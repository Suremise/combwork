// Types shared by the main process, preload bridge and renderer.

import type { SessionEnd } from './sessionEnd'
import type { JournalSettings } from './journal'
import type { Text, TextPart } from './advanced'
import type { AvOffer } from './antivirus'
import type { ActivityKind, ActivityTarget, UndoFinalWhy } from './assistantActivity'
import type { AttachmentKind } from './attachments'
import type { AgentProcess } from './agentProcesses'
import type { StartFailure } from './startFailure'
import type { TipsState } from './tips'
import type { SuggestedPreset, TemplateAgent, TemplateScope } from './templates'
import type { ConnectionOption } from './templateConnections'
import type { KeepAwakeSetting } from './keepAwake'
import type { DateFormat, TimeFormat } from './dates'
import type { ProjectPref } from './uiPrefs'
import type { GitTool } from './gitTool'
import type { ConsoleEvent, ConsoleRecordingInfo } from './devConsole'
import type { SafeguardNote, ScreenStop } from './safeguards'
import type { AgentLeftovers, LeftoverProcessMode } from './agentProcesses'
import type { UsageTimeline } from './usageTimeline'
import type { PlatformId, ProjectPlatform } from './platform/descriptors'
import type { SwitchRefusal } from './platform/switching'
import type { Contradiction, PresetId, WorkflowOptions } from './workflow/options'
import type { Refusal } from './workflow/refusals'
import type { ReviewerMode, WorkflowRole } from './workflow/roles'
import type { NamedFolder, ResumeHold, ShownPlace } from './agentFolders'
import type { StageNameProblem } from './workflow/stages'
import type { TemplateWorkflow, TemplateWorkflowOverlay } from './workflow/templateOptions'
import type { StageId } from './workflow/facts'
import type { StageDef } from './workflow/compile'

/**
 * Text read by both the window and agents (#845, E10a of #677). Hive's services throw a `HiveError` (main/hiveError.ts
 * has the whole contract). What they store or return as data keeps its English field, which agents, the log, old
 * records and any code matching it go on reading, and gains its text as data beside it: a `…Text` field (a `Text`,
 * shared/advanced.ts, or a `StoredText` in a file). The window shows the `…Text` in the user's language and falls back
 * to the English when there is none (a record from before, or the CLI's own words). The Agent API never sends a `…Text`
 * field: its replies are built field by field, and where one sends a whole object that has one, servers.ts leaves the
 * companion behind (`entryForAgents`, `metricsForAgents`, `addedForAgents`).
 */
/** What kind of refusal an error is: the Agent API's status for it (400, 403, 404, 409). */
export type HiveErrorKind = 'invalid' | 'forbidden' | 'notFound' | 'conflict'
/** A failure as data, in a result or an event: its text as data (or a plain error's message, as it came), and its kind. */
export interface HiveErrorData {
  text: TextPart
  kind?: HiveErrorKind
}
/**
 * Text kept in a file (#845): a message's id and its values, never its English or its note, so a record stays small and
 * a later change to the English reaches it. The window formats it with its area's message of that id, and shows the
 * English field beside it for an id it doesn't know (a record from a newer Hive). Values are names and numbers, the
 * same in every language: a word the message chooses (a column, a verdict) is a `select` key, never English.
 */
export interface StoredText {
  id: string
  /** A value can be a message of its own (#866: a CLI's sentence in a comment Hive writes), formatted in the same language. */
  values?: Record<string, string | number | StoredText>
  /**
   * On Hive's comment whose English for agents is worded apart from this message (HI-2087: the queue's return): what
   * that English is said from, so a reader's dialect says it again when it is read (HI-2440): the renderer's name
   * (`storedAgentRenderer`, shared/taskHistory.ts) and its data, kept as JSON.
   */
  agent?: { render: string; data: unknown }
}
/** The window's text as data beside an English field (above), by name: what the Agent API leaves out of its replies. */
export type WindowTextField =
  | 'whatText'
  | 'hiveText'
  | 'statusText'
  | 'mergeSlotText'
  | 'messageText'
  | 'notReusedText'
  | 'problemText'
  | 'errorText'
  | 'notMeasuredText'
  | 'notFilteredText'

export type ThemeSetting = 'dark' | 'light' | 'system'
/** A coding-agent CLI Hive can run ("claude-code", "codex"). See src/shared/providers.ts. */
export type ProviderId = string
/** A permission mode id from the agent's provider (e.g. Claude Code's "auto", Codex's "approve-for-me"). */
export type PermissionMode = string
/** A reasoning effort id from the agent's provider (e.g. "low", "high", "max"). */
export type EffortLevel = string
export type ChimeSound = 'chime' | 'bell' | 'soft' | 'pop'
/** Settings → Notifications, *Show pop-ups about agents for* (HI-2320: `none`, only in the bell). */
export type BannerScope = 'all' | 'workspace' | 'project' | 'none'
export type BannerPosition = 'top-left' | 'top-center' | 'top-right' | 'bottom-left' | 'bottom-center' | 'bottom-right'

/** A notice the Agent API's event stream hears of (#620): an agent finished or waiting, or another notice (HI-2320: the window shows it as an entry). */
export interface Notice {
  id: string
  kind: 'finished' | 'waiting' | 'notice'
  /** In the language Hive shows (#796). */
  title: string
  /** The title in English, for the Agent API (agent-facing text stays English), when `title` is a translated one. */
  apiTitle?: string
  body: string
  /** The project it is about (null: app-wide, such as plan usage); clicking the banner shows it. */
  projectPath: string | null
  /** The agent waiting, for a waiting banner to close once it is answered. */
  agentId?: string
  /** A banner's button (#1437): a command of the window's, with its arguments; its label in the language Hive shows. */
  action?: { label: string; command: string; args?: unknown[] }
}
export type CacheTtlSetting = 'auto' | '5m' | '1h'

export type QuitConfirm = 'working' | 'always' | 'never'
/** What Hive does when an agent edits a file another agent in the same folder is editing. */
export type FileLockMode = 'off' | 'warn' | 'block' | 'ask'
export type MergeStyle = 'squash' | 'merge'
/** How the Session tab arranges the agents of one page. */
export type SessionLayout = 'single' | 'columns2' | 'columns3' | 'grid' | 'grid6'
/** A project's layout as saved: 'auto' is the one that shows its agents, up to the 3×2 grid (until one is chosen by hand). */
export type PageLayout = SessionLayout | 'auto'

/** How the Session tab shows a project's agents (#975): their terminals in panes, or a tile each (#976). */
export type SessionView = 'panes' | 'tiles'
/** The Tiles view's order (#976): the panes' own, or by urgency (waiting and stalled first). */
export type TileOrder = 'panes' | 'urgency'
/** 'window': quitting was asked, but only the window showing the question closes (Close this window only). */
export type QuitChoice = 'now' | 'wait' | 'cancel' | 'window'
/** What the quit dialog is for: quitting, closing a window, closing its workspace, or switching the window to another workspace. */
export type QuitScope = 'app' | 'window' | 'workspace' | 'switch'

/** A running session listed in the quit dialog. */
export interface QuitSession {
  projectPath: string
  project: string
  status: SessionStatus
  /** The agent's name (none for the Hive Assistant). */
  agent?: string
  /** The agent's id, to find its card. */
  agentId?: string
  /** The card it works on, or reviews ("reviewing #12 …"), from its workspace's board (#572). */
  card?: string
  /** The name of the workspace it runs in (its folder's), shown over its group when several windows are open. */
  workspace?: string
  /** That workspace's full path: the quit dialog groups agents by it, so two workspaces with the same name stay apart. */
  workspacePath?: string
  provider?: ProviderId
  /** A watching agent: what it waits for ("Waiting for #12 → Review"). */
  watch?: string
  /** It keeps "Quit when agents finish" waiting: a card it watches is being worked on by another agent. */
  keepsQuitWaiting?: boolean
}

export type UpdateInstallMode = 'auto' | 'manual'

/** Command id → key combination ("Mod+Shift+P", chords as "Mod+K Mod+S"); null removes the default. */
export type KeybindingOverrides = Record<string, string | null>

export interface AppSettings {
  /** The user's changes to the default keyboard shortcuts. */
  keybindings: KeybindingOverrides
  /** Hive's own commands (HI-1954, Settings → Commands at Hive's level) and When Hive quits, run. */
  commands: CommandsHive
  /** The MCP catalogues the MCP view lists servers from (HI-545, Settings → MCP Catalogues). */
  mcpCatalogs: McpCatalogSettings
  /** The global default workflow options (SPEC §16.6.6), under each workspace's and project's own; absent: all off. */
  workflow?: WorkflowDefaults
  /** The one-time steps settled in Hive's own defaults (HI-1997's `workflow.commitMessageDefault`), each saved with its change. */
  stepsDone?: string[]
  /** Hive's default slot options for Git projects (HI-1765), under each workspace's and project's own (`slots`). */
  slotDefaults?: SlotDefaults
  updates: {
    checkAutomatically: boolean
    downloadAutomatically: boolean
    /** auto: a downloaded update installs when Hive quits. manual: only with Restart and Update. */
    install: UpdateInstallMode
    prerelease: boolean
  }
  general: {
    closeToTray: boolean
    minimizeToTray: boolean
    startMinimized: boolean
    launchAtLogin: boolean
    reopenLastWorkspace: boolean
    /** When to ask before quitting while sessions run. Older configs stored a boolean (migrated on load). */
    confirmOnQuit: QuitConfirm
    /** A tip when Hive starts (at most one a day), and at the moments a tip helps. Help → Tips… has them all. */
    showTips: boolean
    /** Keep Windows from sleeping while agents work: only on mains power, always, or never. */
    keepAwake: KeepAwakeSetting
    /** The Progress panel (long runs agents report, with taskbar progress). Off: reports are accepted and ignored. */
    progressPanel: boolean
    /**
     * Agents run long commands (about 30 s or more) through hive-progress without being asked, so they show in the
     * panel: Hive's session guidance says so. Off, or with the panel off: only when the user asks. New sessions.
     */
    progressCommands: boolean
    /** How dates show everywhere in Hive (session names, lists, tooltips, exports): 2026-10-04 by default. */
    dateFormat: DateFormat
    /** How times show with them: 24-hour (14:05) by default. */
    timeFormat: TimeFormat
    /** How Hive names the user to the Hive Assistant (#426): "User replied to B1 on #399". "User" by default. */
    userName: string
    /** The language Hive shows (#767): 'auto' (Windows' display languages) or a language's code (de, pl…). */
    language: string
    /** HI-1368's When Hive quits, run, as saved before HI-1954: read once into `commands`, then dropped. */
    onQuit?: CloseCommandSetting
  }
  appearance: {
    theme: ThemeSetting
    uiFontSize: number
    terminalFontFamily: string
    terminalFontSize: number
    terminalScrollback: number
    terminalCursorBlink: boolean
  }
  /** Each provider's settings, keyed by provider id. Providers start disabled on a fresh install. */
  providers: Record<ProviderId, ProviderSettings>
  /** The provider Add Agent's quick add uses unless the project says otherwise. */
  defaultProvider: ProviderId
  /**
   * 0.9's order of the providers (HI-1965), which its Automatic picked from. No list follows it since HI-2139 (Hive's
   * order): kept read-only in config.json, as defaultProvider is, for the migration's reading of a 0.9 launch
   * (connectionDefaults.ts' legacyAutoProvider) in workspaces not opened yet. Never written.
   */
  providerOrder: ProviderId[]
  notifications: {
    chimeEnabled: boolean
    chimeSound: ChimeSound
    chimeVolume: number
    desktopNotifications: boolean
    notifyOnFinished: boolean
    notifyOnWaiting: boolean
    /** Which agents' notices the focused window pops up: from every window, its workspace, the project it shows, or none (only in the bell). */
    bannerScope: BannerScope
    /** Where every pop-up goes (HI-2320). */
    bannerPosition: BannerPosition
    /** How long a pop-up that closes by itself stays, in seconds; kept while the pointer or the focus is on it, or the window isn't focused. */
    bannerSeconds: number
    /** Pop-ups for an agent waiting for you stay until handled (clicked, dismissed or answered); off: they close like the others. */
    waitingBannerStays: boolean
    /** A badge with the count of agents that need you on the window's taskbar button, and the count in its title. */
    taskbarCount: boolean
    /** Flash the taskbar button when an agent starts waiting for your input and the window isn't focused. */
    flashOnWaiting: boolean
    /** A notice when a project's work has finished (#1437): a good moment to start its idle agents fresh. A project may set its own. */
    suggestFreshStart: boolean
  }
  sessions: {
    backupTranscripts: boolean
    /**
     * How long Hive keeps its backups of sessions the CLI still has (#1110): after this many days without activity they
     * go to the Recycle Bin; 'off' keeps them. A session whose only copy is Hive's is never touched.
     */
    backupRetention: BackupRetention
    cacheTtl: CacheTtlSetting
    confirmStop: boolean
    /** Context size (tokens) above which Compact is highlighted. 0 never highlights. */
    compactSuggestTokens: number
    /** A running session's transcript over this many MB is flagged (footer, notification): long ones slow the CLI and Hive. 0 never. */
    transcriptWarnMB: number
    /** How many transcripts' usage Hive keeps, in memory and in usage-cache.json, so a restart doesn't read them again. */
    usageCacheSize: number
    /** The Sessions tab's transcript of a running session follows new messages without a Refresh. */
    followTranscripts: boolean
    /** How the Overview and the session lists update: as sessions change (at most every 15 s), every minute, or on Refresh. */
    overviewRefresh: 'live' | 'minute' | 'manual'
    /** The Session tab's view for a project that hasn't chosen one with its Panes | Tiles toggle (#975). */
    defaultView: SessionView
    /** The order of the Tiles view's tiles (#976): the panes' order (urgent tiles highlighted where they are) or by urgency. */
    tileOrder: TileOrder
    /** Hive counts what its Agent API, tools, guidance and skill service cost (aggregates only), per workspace. */
    recordPerformance: boolean
    /** After Hive closed unexpectedly (#984), resume the agents that were running at the next start: off, only the notice. */
    resumeAfterUnexpectedClose: boolean
  }
  agentApi: {
    enabled: boolean
    port: number
    provideHiveMcp: boolean
    allowSessionInput: boolean
    /** Agents and the Hive Assistant may read the developer console through the hive tools (#636): their own sessions; the Assistant its workspace's. */
    devConsole: boolean
  }
  /** The Hive Assistant's defaults (each workspace's Assistant Settings can override them). */
  assistant: AssistantSettings
  agents: {
    /** How long a background task an agent started counts as running if it never reports its end, in minutes. */
    backgroundTaskMinutes: number
    /** What to do with processes an agent leaves running when it stops: offer to end them, or end them (#507). */
    leftoverProcesses: LeftoverProcessMode
  }
  board: {
    /** Done cards are archived this many days after they went into Done. 0 never. */
    archiveDoneDays: number
    /** Colour each column's heading and tint its cards. */
    columnColors: boolean
    /** The columns' colours (#rrggbb). */
    colors: Record<TaskColumn, string>
  }
  advanced: {
    /** Help → Developer Console and its shortcut (#366, #637): hidden until this is on. */
    showDeveloperFeatures: boolean
  }
}

export type AssistantPanelSide = 'right' | 'left'

/** The Hive Assistant's defaults: its provider, its mode and, per provider, its model, effort, mode and arguments. */
export interface AssistantSettings {
  /** '' follows the default provider. */
  provider: ProviderId | ''
  /** The mode new conversations use (a file in the workspace's .hive/modes, without .md). */
  mode: string
  /** What the Assistant may do beyond looking (see AssistantControl). */
  control: AssistantControl
  /**
   * Whether it may change Hive's settings when the user asks (hive_update_setting), whatever its control level. It can
   * always read and explain them; sensitive ones, and its own Control, are never its to change (#186).
   */
  changeSettings: boolean
  /** Seconds after the user types in an agent's terminal before the Assistant may type there (0: no pause). */
  typingPause: number
  /** The user pressing Enter (sending what they typed) ends that pause. */
  enterEndsPause: boolean
  /**
   * Its watches are told when the user sends a watched agent (or a watched card's agent or reviewer) a prompt from that
   * agent's pane, with its first line (#418).
   */
  tellReplies: boolean
  /** Which side of the window its panel is on (the same in every workspace and window). */
  panelSide: AssistantPanelSide
  /**
   * Context size, in tokens, at which its Compact button and context count are highlighted (0: never). Its own, not
   * settings.sessions.compactSuggestTokens: the Assistant usually runs a bigger context than project agents.
   */
  compactSuggestTokens: number
  providers: Partial<Record<ProviderId, AssistantProviderSettings>>
}

/**
 * How far the Hive Assistant may act: only look and advise; also run the agents (add, change, start, stop and
 * prompt them); or that and create projects. It never removes agents, discards worktrees or deletes projects.
 */
export type AssistantControl = 'look' | 'agents' | 'projects'

/** Something the Hive Assistant did (or tried), for the list in its panel and hive.log. */
/** Also its kind and targets (#763, assistantActivity.ts): what the event stream gives viewers instead of the line. */
/**
 * What kind of change of the Assistant's undo works on (#1282, SPEC §16.14): a card's fields (or a card it made), a lane
 * record, an agent's settings, a Hive setting, an agent it started (stopped by undo), or one that can't be undone
 * (`final`: a prompt or comment sent, a project made), which says why.
 */
export type AssistantChangeKind = 'card' | 'lane' | 'agent' | 'setting' | 'started' | 'final'

/** One of the Assistant's changes as kept for undo: its line, what it was about, the fields it set, and whether undone. */
export interface AssistantChangeRow {
  id: string
  /** The user's message it came from. */
  group: string
  at: string
  kind: AssistantChangeKind
  /** The Assistant's action it came from (its activity kind: `update-task`, `prompt-agent`…), for the window's words. */
  act: ActivityKind
  /** The Assistant's change as it said it ("change #12 on the board"), in English. */
  what: string
  card?: number
  project?: string
  /** The fields it set (a card's `labels`, `column`…; a lane's `cards`; a setting's `value`; `created` for a card it made). */
  fields: string[]
  /** Why it can't be undone (a `final` change), in English. */
  final?: string
  /** The same reasons as codes, which the window words in its language (#1283: its IPC only). */
  finalWhy?: UndoFinalWhy[]
  undoneAt?: string
  /**
   * Once undone, what undo did with its fields (#1283): those put back, and those left as they were, with why (someone
   * changed it since, it is gone, the lane ended). Absent for a change undone before outcomes were kept.
   */
  outcome?: { undone: string[]; skipped: { field: string; why: 'changed' | 'gone' | 'ended' }[] }
}

/** The Assistant's changes for one message of the user's (#1282): when it was sent, and its changes, newest first. */
export interface AssistantChangeGroup {
  id: string
  at: string
  changes: AssistantChangeRow[]
}

/**
 * What undoing one change did: the fields put back (`running`: an agent it started, stopped), and those left as they are,
 * with why: someone changed it since, the card, lane or agent is gone, the lane has ended, or the change failed (`error`).
 */
export interface AssistantUndoResult {
  change: string
  act: ActivityKind
  what: string
  card?: number
  undone: string[]
  skipped: { field: string; why: 'changed' | 'gone' | 'ended' | 'failed'; error?: string }[]
  /** Why nothing of it can be undone (a `final` change), in English. */
  final?: string
  /** The same reasons as codes, which the window words in its language (#1283: its IPC only). */
  finalWhy?: UndoFinalWhy[]
  /** It was undone before: nothing more was done. */
  already?: true
}

export interface AssistantAction extends Partial<ActivityTarget> {
  id: string
  at: string
  /** One line, e.g. "Started Agent 2 in hive". */
  text: string
  ok: boolean
  /** Why it failed or was refused, in full (its panel). */
  error?: string
  /** Why, as the event stream says it (#763): Hive's own short words, never the error's text (publicReason). */
  reason?: string
  /** A setting it changed (#186): old → new, which the list's Revert puts back. */
  setting?: AssistantSettingChange
  /** The user reverted that change (this action's id): the list marks the change as reverted. */
  revertOf?: string
  /** The line without what it quotes (a prompt, a message): what the Agent API's event stream gives (#620). */
  brief?: string
  /** The user's message it came from, and when it was sent (#1283: the panel lists it with that message's changes). */
  group?: string
  groupAt?: string
}

/** A setting the Hive Assistant changed, as its activity list shows it and Revert undoes it. */
export interface AssistantSettingChange {
  /** The settings catalog's id (settingsCatalog.ts). */
  id: string
  /** For a project's setting: the project's folder. */
  project?: string
  /** "Settings → Sessions → Suggest compacting above". */
  path: string
  old: unknown
  new: unknown
  /** A provider's prices, when the change put back shipped models removed from its table: removed before and after. */
  removed?: { old: string[]; new: string[] }
  /** As the list shows them. */
  oldText: string
  newText: string
}

/** A question the Hive Assistant's action is waiting on (e.g. stopping a busy agent), shown as a card in its panel. */
export interface AssistantQuestion {
  id: string
  title: string
  message: string
  yes: string
  no: string
}

/** Empty values follow the provider's own settings; an empty permission mode is the provider's assistantMode (reads freely, asks before changing anything). */
export interface AssistantProviderSettings {
  model: string
  effort: EffortLevel | ''
  permissionMode: PermissionMode | ''
  extraArgs: string
  /** Run with a 200K context window instead of the model's 1M one (capabilities.contextLimit); '' follows the provider's settings. */
  use200kContext: '' | 'on' | 'off'
}

/** A mode the Hive Assistant can take: a Markdown file of instructions in the workspace's .hive/modes. */
export interface ModeInfo {
  /** The file name without .md. */
  id: string
  name: string
  description: string
  /** An emoji or short mark shown beside the name. */
  icon: string
  /** The file; for a bundled mode missing from the workspace, its copy in Hive's installation. */
  path: string
  /** Modes that ship with Hive: the workspace copy matches Hive's, was changed, or isn't in the workspace. */
  bundled?: 'same' | 'changed' | 'missing'
  /** A changed copy of an older version of Hive's: reverting it also brings in this version's. */
  updateAvailable?: true
}

/** API prices for one model, in USD per million tokens (for estimated costs). */
export interface ModelPrice {
  input: number
  cachedInput: number
  cacheWrite?: number
  output: number
}

export interface ProviderSettings {
  enabled: boolean
  executablePath: string
  defaultModel: string
  defaultEffort: EffortLevel | ''
  defaultPermissionMode: PermissionMode
  /** The provider's no-guardrails mode (Claude Code's Bypass, Codex's Full Access) can be chosen. */
  enableDangerousMode: boolean
  extraArgs: string
  checkUpdatesOnLaunch: boolean
  /** Let sessions move into the CLI's own background service (capabilities.backgroundSessions). Off: Hive turns it off. */
  allowBackgroundSessions: boolean
  /** Run sessions with a 200K context window instead of the model's 1M one (capabilities.contextLimit). */
  use200kContext: boolean
  /**
   * Where a session's cost comes from when the provider reports one (capabilities.reportsCost, #436): the CLI's own
   * report (the truth, from its own price table: Hive never recomputes it), or Hive's estimate from the price table.
   */
  costSource: 'reported' | 'prices'
  /** The user's price overrides by model id; missing models use the prices Hive ships. */
  prices: Record<string, ModelPrice>
  /** Shipped prices the user removed from the table (a model of their own in `prices` wins). */
  pricesRemoved?: string[]
  /**
   * The models offered when the CLI can't be asked (not installed, too old, an odd reply), as the user edited them;
   * absent: the descriptor's. Only an edited list is stored, so improved shipped defaults reach everyone else.
   */
  modelFallback?: FallbackModel[]
  /** The effort levels offered when the CLI doesn't report a model's own, as the user edited them; absent: the descriptor's. */
  effortFallback?: EffortOption[]
}

/** An effort level and what to call it. */
export interface EffortOption {
  value: EffortLevel
  label: string
}

/** A model of the fallback list (Settings → provider → Models): older ones are behind "Show older versions". */
export interface FallbackModel {
  value: string
  label: string
  older?: boolean
}

/**
 * A model as the provider's CLI describes it (Claude Code's initialize reply, codex debug models). A field the CLI
 * doesn't report is absent, and Hive falls back for it.
 */
export interface CatalogModel {
  /** What to pass to the CLI (an alias such as "opus", or a model id). */
  value: string
  label: string
  /** The id an alias stands for ("claude-opus-5-5"), when the CLI says. */
  resolved?: string
  description?: string
  /** The effort levels the model takes ([]: none, it has no effort setting); absent: not reported. */
  efforts?: EffortLevel[]
  /** The effort the CLI uses with it when none is chosen, when the CLI says. */
  defaultEffort?: EffortLevel
  /** Whether the CLI runs it in its automatic mode (Claude Code's Auto); absent: not reported. */
  supportsAuto?: boolean
  /** Listed by the CLI as not available to this account. */
  unavailable?: boolean
}

/** The models a CLI reported, and which version of it said so. */
export interface ModelCatalog {
  /** cli: read just now; cache: the last good reply from this version, while a fresh read runs. */
  source: 'cli' | 'cache'
  version: string | null
  models: CatalogModel[]
  /** The model the CLI runs when none is passed, when it says (Claude Code's "default" entry). */
  defaultModel?: string
  /** When it was read (ISO). */
  at: string
}

export interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

export interface AppConfig {
  /** 7 since working modes replaced the shipped personas (#259); 6 since notices show in Hive while it is focused; 3 since the Assistant uses the agents' model and effort (0.3.0); 2 since providers (0.2.0); 1 was Claude Code only. */
  version: 9
  settings: AppSettings
  recentWorkspaces: string[]
  /** The workspace of the window focused last (what 0.1 reopened); `windows` has every window. */
  lastWorkspace: string | null
  /** Active project names, keyed by workspace path. */
  activeProjects: Record<string, string[]>
  /** The last focused window's size and place, for a new window. */
  window: WindowState
  /** The developer console window's size and place (#637). */
  consoleWindow?: WindowState
  /** The windows open when Hive last quit, each with its workspace (null: the welcome page), reopened at start. */
  windows?: (WindowState & { workspace: string | null })[]
  /** Per workspace (lowercased path): the last project rename (#514, `.hive/project-names.json`'s number) its view preferences and Working on follow. */
  renamesApplied?: Record<string, number>
  /** Always on Top: the workspaces (lowercased paths) whose window was left pinned. This machine's, never in .hive. */
  alwaysOnTop?: Record<string, true>
  /**
   * Moved workspaces whose records here by folder (the window's pin, the close command's runs) are still to follow them
   * (HI-2007): one per old folder, `to` where the workspace is now, kept until nothing is left at `from`, tried at each
   * open and Repair (workspaceMove.ts carryProfile). `failed`: why the last try left something it could have moved.
   */
  profileMoves?: ProfileMove[]
  /**
   * Antivirus scanning (#316), this machine's: the exclusions Hive added (resolved paths), Defender's list as last read
   * with administrator rights, and per workspace (lowercased path) the last suggestion (its folders, when and how many
   * times; a plain string is #316's form, the folders only) and "Don't ask again".
   */
  antivirus?: { added?: string[]; adminCheck?: { at: string; exclusions: string[]; devDrives?: Record<string, 'trusted' | 'untrusted' | 'no'> }; offered?: Record<string, string | AvOffer>; dismissed?: Record<string, true> }
  /** `panes`: resizable pane sizes by key (pixels, or a fraction for split views). `tips`: what the tips know (shared/tips.ts). */
  ui: {
    sidebarWidth: number
    sidebarVisible: boolean
    sidebarCompact?: boolean
    panes?: Record<string, number>
    tips?: TipsState
    /** The provider each project's Skills tab last showed, by project path in lower case (#118). */
    skillsProvider?: Record<string, ProviderId>
    /** Each project's Skills tab groups as the user last left them open or folded, by project path in lower case (#118). */
    skillsFold?: Record<string, { hive?: boolean; provider?: boolean }>
    /** Each project's Sessions tree branches the user opened (true) or folded (false), by project path in lower case (#239). */
    sessionsTree?: Record<string, Record<string, boolean>>
    /** The .hive version control notice each project's Overview no longer shows (#345): the situation dismissed (`hiveVcsKey`), by project path in lower case. */
    hiveVcsNotice?: Record<string, string>
    /** The connections notice's entries dismissed (HI-1770): `<project path in lower case>|<moved entry's id>`. */
    connectionsNoticeDismissed?: string[]
    /** The one-time notice that agents run on connections (HI-1774) was dismissed, or a connection was added: never shown again. */
    connectionsIntroShown?: boolean
    /** The active projects folded in the Assistant panel's Workspace list (#399), by `assistantFoldKey` (workspace and project path); unfolded ones aren't kept. */
    assistantFold?: Record<string, boolean>
    /** Each workspace's board as the user left it, by workspace path in lower case (#170): collapsed columns, folded cards. */
    boardFold?: Record<string, BoardFold>
    /**
     * Each project's Session tab as the user left it (HI-1749: Panes or Tiles, its layout, where its panes are), by
     * projectViewKey: this user's view, not the project's config, so it is never written to project.json (where another
     * program holding the file made a view switch fail). A project's project.json from before keeps its view until read.
     */
    projectViews?: Record<string, ProjectView>
    /** Each workspace's Progress panel filter (#251), by workspace path in lower case: one project's runs (and agent's), or all. */
    progressFilter?: Record<string, { project: string; agent?: string }>
    /** Each workspace's running lanes in the order the user put them in the Progress panel (#568), by workspace path in lower case: lane ids. */
    laneOrder?: Record<string, string[]>
    /** The tab each remembered row of tabs last showed (HI-1837: Settings → Version Control's Hive or workspace defaults…), by the row's key. */
    tabs?: Record<string, string>
  }
  /** Per provider: the model last seen in a session started without a model choice (the CLI's own default). */
  observedDefaultModel: Record<ProviderId, string>
  /**
   * Per provider and model: the effort last seen in a session started without an effort choice (the CLI's own default
   * for that model, for CLIs that don't report it otherwise).
   */
  observedDefaultEffort?: Record<ProviderId, Record<string, EffortLevel>>
  /** Per provider: the last good model catalog its CLI gave, keyed by the CLI version, so pickers fill at once on start. */
  modelCatalogs?: Record<ProviderId, ModelCatalog>
  /** Per provider: the plan usage it last reported (account-wide), from sessions not on a connection. */
  planUsage: Record<ProviderId, PlanUsage>
  /** Per connection (its id, HI-1756): the plan usage its sessions last reported, that login's own limits. */
  connectionPlanUsage?: Record<string, ConnectionPlanUsage>
  /**
   * The usage moves fired (HI-2195), per account and limit: one record per reset period, saying which agents it handled.
   * Kept until that period's reset passes.
   */
  usageMoves?: Record<string, Record<string, UsageMoveRecord>>
  /** Highest warning shown per "provider:limit", and for which reset period. */
  planWarnings: Record<string, { resetsAt: string | null; level: number }>
  /**
   * The accounts Hive keeps (HI-980; HI-2106), in one order for all CLIs (decision A): a CLI's first account on in a
   * workspace is what a launch falls back to there. Before HI-2106 they were `connections`, with their defaults.
   */
  accounts?: Account[]
  /**
   * The connections (HI-2106): the setups agents and the Assistant choose, each on an account and ordered within it by
   * their order here; an account's first is its base connection, made with it.
   */
  connections?: Connection[]
  /** One-time changes to this file (HI-2106): `accounts1`, its connections became accounts, and their defaults connections. */
  migrations?: { accounts1?: AccountsMigration }
  /** Per provider: the account last chosen as a workspace's default (or launched on). Since HI-1875 only its migration's. */
  lastUsedConnection?: Partial<Record<ProviderId, string>>
  /** HI-1875's one-time move (the most recently used default to the top of each CLI's order) is done. */
  connectionOrderMigrated?: true
  /**
   * The CLIs whose old per-CLI model, effort and context (Settings → <CLI> before connections) were given to a
   * connection (HI-1774): to its first, or to those from before connections had defaults; only once, never again.
   */
  connectionDefaultsTaken?: ProviderId[]
  /**
   * Server connections' key masking (HI-1772), mirrored with key-coverage.json and never cleared: `ever`, a key was
   * saved (so fingerprints must exist); `gap`, a reset lost some (masking strict for good).
   */
  keyMasking?: { ever?: true; gap?: true }
  /** A version the user chose to skip; automatic checks don't offer it. */
  skippedUpdate?: string
  /** Version that last ran, to say "Hive updated" once after an update. */
  lastRunVersion?: string
}

export interface PlanLimit {
  /** Stable id within the provider, e.g. "five_hour", "seven_day". */
  id: string
  /** "5-hour", "weekly". */
  label: string
  windowMinutes: number | null
  usedPercent: number
  resetsAt: string | null
  /** When the reading kept was reported, and by which session's agent (#383: sessions relay readings of different ages). */
  reportedAt?: string
  reportedBy?: string
}

/** Subscription limits a provider reported (e.g. a rolling 5-hour window and a weekly limit). */
/** A connection's plan usage (HI-1756): the login it came from (planUsage.ts usageLogin), so another's never shows as its. */
export type ConnectionPlanUsage = PlanUsage & { login?: string }

export interface PlanUsage {
  provider: ProviderId
  /** The plan's name when the provider says (e.g. "plus"). */
  plan: string | null
  limits: PlanLimit[]
  updatedAt: string
}

/** Who an account's folder is signed in as (HI-980): what the CLI's own status says, never a token. */
export interface ConnectionIdentity {
  email: string
  /** The organisation's id: with the email, it tells two logins apart. */
  orgId: string
}

/** An account's latest check (HI-980): what the CLI said, or why it couldn't be asked. */
export interface ConnectionObserved {
  at: string
  /** null: the check failed (`error` says why), which never counts as signed out. */
  loggedIn: boolean | null
  email?: string
  orgId?: string
  /** Its plan, as the CLI names it ("max"). */
  plan?: string | null
  /** A check that failed (a timeout, output Hive couldn't read), in English for the log; the last good identity is kept. */
  error?: string
  /** Its folder isn't there, or isn't a folder Hive made (replaced from outside). */
  missing?: boolean
}

/**
 * An account (HI-2106, HI-2105's design): a CLI login Hive keeps (HI-980) or a server it reaches (HI-1772), in a folder of
 * its own under the accounts folder (`<accounts>\<id>\`), linked to the CLI's home by a junction for what all accounts
 * share; or (`home: 'cli'`) the CLI's own home and sign-in. `accepted` is who the user took it on as; `observed` the
 * latest check: they differ when its login changed (a /login typed in a pane), which the user answers. Agents don't
 * choose an account: they choose a connection on one.
 */
export interface Account {
  /** Stable and random ("a-3f9c2e1b"): its folder's name, and its key-store and usage (`connectionPlanUsage`) entries'. A rename never changes it. */
  id: string
  provider: ProviderId
  /**
   * Where it gets its model (Darren, 27 Oct ~08:55): `signIn`, a login folder of Hive's signed in through the CLI's own
   * sign-in; `server`, a server it reaches by a base URL, with a key or none (HI-1772: DeepSeek, Ollama…), in a folder of
   * Hive's too. Absent in a record from before it: signIn.
   */
  kind?: 'signIn' | 'server'
  /** A server account's server (HI-1772). Its key is never here: only in the key store (keyStore.ts). */
  server?: ServerConnection
  /**
   * `cli`: no folder of Hive's but the CLI's own home and sign-in, made by Hive and never removed (HI-2106): Copilot's one
   * PC-wide sign-in (decision C), and a test copy's CLI test home (the test seam, connectionSeam.ts).
   */
  home?: 'cli'
  /** The user's name for it ("Personal", "Hive overnight"). */
  name: string
  createdAt: string
  accepted?: ConnectionIdentity
  observed?: ConnectionObserved
  /** A removal that stopped partway, in English: what is left, for Remove to try again. */
  leftover?: string
  /** Its usage move (HI-2195): at this share of a limit, its agents move to another account's connections. Absent: off. */
  usageMove?: UsageMoveRule
}

/** Which of an account's limits a usage move watches (HI-2195): the weekly one, the 5-hour one, or whichever gets there first. */
export type UsageMoveLimit = 'weekly' | 'fiveHour' | 'any'

/** An account's usage move (HI-2195): when `limit` reaches `percent`, its agents move to the account `to` (its id). */
export interface UsageMoveRule {
  percent: number
  limit: UsageMoveLimit
  to: string
}

/**
 * A usage move fired for one limit's reset period (HI-2195): the rule it fired with (`firing` tells two firings apart),
 * each agent it handled (by `<project id>/<agent id>`: moved, kept on the user's own choice, or given up after failed
 * writes), the reasons it was noticed for, and failed tries.
 */
export interface UsageMoveRecord {
  resetsAt: string
  firing: string
  rule: UsageMoveRule
  handled: Record<string, 'moved' | 'kept' | 'failed'>
  noticed?: string[]
  tries?: Record<string, number>
}

/**
 * A connection (HI-2106): a named setup on an account ("Claude · High"), what agents and the Assistant choose. Each value
 * absent: the CLI decides (its default model, effort and mode, no 200K context, no extra arguments). A server account's
 * connections take no effort or context: its server's models aren't the CLI's.
 */
export interface Connection {
  /** Stable and random ("c-3f9c2e1b"), never an account's. */
  id: string
  /** Its account's id. */
  account: string
  name: string
  model?: string
  effort?: EffortLevel
  use200kContext?: boolean
  permissionMode?: PermissionMode
  /** Extra command-line arguments, as typed (split at launch: splitArgs). */
  extraArgs?: string
}

/** What a connection launches with (HI-2106): two connections on one account with the same values are the same setup. */
export type LaunchValues = Pick<Connection, 'model' | 'effort' | 'use200kContext' | 'permissionMode' | 'extraArgs'>

/**
 * A connection as config.json kept it before HI-2106 (HI-980 to HI-1875): an account with its defaults (HI-1770). Read
 * by the accounts migration only, from its record (`migrations.accounts1.legacy`).
 */
export interface LegacyConnection extends Account {
  /**
   * Its defaults for the agents on it (HI-1770): what an agent with no model, effort or context of its own ran with.
   * Absent: not set yet (copied from the CLI's once, `defaultsFrom`); an empty object is the user's (the CLI decides).
   */
  defaults?: ConnectionDefaults
  /** 'cli': `defaults` were still the CLI's per-CLI defaults as copied. */
  defaultsFrom?: 'cli'
}

/**
 * config.json's accounts migration (HI-2106), recorded once: when, and its connections as they were then (`legacy`, read
 * only), which each workspace's own files are migrated from when it next opens, however much later.
 */
export interface AccountsMigration {
  at: string
  legacy: LegacyConnection[]
}

/**
 * A project's accounts migration (HI-2106), recorded in the write that made it: `unplaced`, agents whose CLI had no
 * account to make a connection on, by id, with what they would have launched with; the Assistant's home (`assistant`),
 * the connection made for each CLI it had a setup for in its workspace (its agent holds the active one's), which a change
 * of its CLI picks.
 */
export interface ProjectAccountsMigration {
  at: string
  unplaced?: Record<string, LaunchValues>
  assistant?: Partial<Record<ProviderId, string>>
}

/** The Claude names a server's model can stand in for (HI-1772): the CLI's aliases. */
export type ModelAlias = 'opus' | 'sonnet' | 'haiku'

/** One of a server's models (HI-1772): its id at the server, and the aliases it stands in for (each alias at most one model). */
export interface ServerModel {
  id: string
  as?: ModelAlias[]
  /**
   * The server runs it elsewhere (HI-1773: an Ollama cloud model, reached through the server on this PC but run on
   * ollama.com), so its sessions are never free (local). Kept in config only as its server's listing said; what main
   * sends a window or a launch also has its preset's pattern applied, as set now (withRemote).
   */
  remote?: true
}

/**
 * A server connection's server (HI-1772): its base URL, its preset (the descriptor's, for its model listing), and its
 * models, typed or read from it. Nothing secret: a key is in the key store, bound to the URL's origin.
 */
export interface ServerConnection {
  baseUrl: string
  preset?: string
  models: ServerModel[]
  modelsFrom: 'typed' | 'listed'
}

/** A legacy connection's defaults (HI-1770); each absent: the CLI decides (its own default model, effort; context off). */
export interface ConnectionDefaults {
  model?: string
  effort?: EffortLevel
  use200kContext?: boolean
}

/** The field moved from a project onto its agents by the connections migration (HI-1770). */
export type MovedField = 'model' | 'effort' | 'use200kContext'

/**
 * A CLI's project overrides moved onto the project's agents (HI-1770, Darren's 26 Oct ~23:25 (2)): when, and each value
 * an agent was given (`id`: `<cli>:<agentId>:<field>`, stable, for the notice and its dismissal).
 */
export interface ConnectionsMoved {
  at: string
  moved: { id: string; agent: string; field: MovedField; value: string | boolean }[]
}

/**
 * A workspace's accounts for one provider (HI-980; workspace.json's `connections`, whose ids are accounts' since HI-2106):
 * those on in it, and its default among them (derived, HI-1875; null: none).
 */
export interface WorkspaceConnections {
  on: string[]
  default: string | null
}

export interface WorkspaceConfig {
  version: 1
  /**
   * The accounts on in this workspace, per provider (HI-980). No entry for a provider: not set up yet (nothing is turned
   * on by itself); `{ on: [] }`: the user turned them all off. `default` was HI-1875's migration input, ignored since
   * and removed by the accounts migration (HI-2106).
   */
  connections?: Partial<Record<ProviderId, { on: string[]; default?: string | null }>>
  /**
   * The Assistant's own account per provider in this workspace (HI-1755), before HI-2106: read once by the accounts
   * migration (the Assistant's agent then holds its connection), and removed by it.
   */
  assistantConnection?: Partial<Record<ProviderId, string | null>>
  /**
   * One-time changes to this file (HI-2106): `accounts1`, its own launch sources (`assistantConnection`, each provider's
   * stored `default`) removed, once its Assistant's home was migrated (its record says what was made).
   */
  migrations?: { accounts1?: { at: string } }
  /** Where the workspace was last opened (#146): a different folder now means it was moved, and Repair… is offered. */
  lastPath?: string
  /**
   * The folder Hive's profile keeps this workspace's records by (HI-2007: its window's pin, its close command's runs),
   * set once they have all followed it here. Apart from lastPath, which stays where Repair needs it until Repair is done:
   * moved again before that, the records are found where they went.
   */
  profileAt?: string
  /** The last project rename (#514, `project-names.json`'s number) its hidden and removed projects follow. */
  renamesApplied?: number
  /**
   * The workspace's MCP settings. `enabled` was #1093's master switch (the servers on in the workspace): since HI-2059 it
   * is only read, frozen, for projects not yet converted to added servers (mcpAdded), and never written. `model` 2: the
   * settings are #1093's (before, `enabled` meant on for all projects, unless a project turned it off); absent, they are
   * moved to it when the workspace opens.
   */
  mcp: {
    enabled: string[]
    model?: 2
    /**
     * The servers added for the Hive Assistant (HI-1472, HI-2059: its view's MCP servers), as a project's. Absent until
     * set or moved from the old Advanced switch; before `assistantModel` 3, #1093's meaning (assistantMcpAdded).
     */
    assistant?: string[]
    /** 3: `assistant` means added (HI-2059), converted once from #1093's meaning. */
    assistantModel?: 3
    /** Choices dropped converting to added servers (HI-2059: servers that were off in the workspace), not yet said. */
    droppedNotice?: number
  }
  /**
   * The Hive skills the workspace's agents aren't given (#1431, Skills → Delivered to agents), by name: every other skill
   * for their audience is delivered. A project can switch off more (ProjectConfig.skillDelivery), never one on again.
   */
  skillDelivery?: SkillDeliveryChoice
  /** Project folders Hive leaves out (Hide, or Remove from Hive while the folder is still in the workspace), by folder name. */
  hiddenProjects?: HiddenProject[]
  /** Agent names two projects share from before names were unique (#702), lower case: each said once, while it lasts. */
  flaggedAgentNames?: string[]
  /** The workspace's own advanced values (#367: Settings → Advanced, This workspace), for those a workspace can set. */
  advanced?: Record<string, unknown>
  /** The Assistant's journal (#1031: Settings → Assistant → Journal); absent: on, work only, 90 days, 50 MB. */
  journal?: JournalSettings
  /** The Assistant suggested its journal once, writing a handover while it was off (#1032): never again. */
  journalSuggested?: boolean
  /** The workspace's default workflow options (SPEC §16.6.6), between the global ones and each project's own. */
  workflow?: WorkflowDefaults
  /** The one-time steps settled in this workspace's own defaults (HI-1997's `workflow.commitMessageDefault`), each in the same write as its change. */
  stepsDone?: string[]
  /** The workspace's default slot options (HI-1765), between Hive's and each project's own. */
  slotDefaults?: SlotDefaults
  /** HI-1368's When this workspace closes, run, as saved before HI-1954: read once into `commands`, then dropped. */
  onClose?: CloseCommandSetting
  /** The workspace's own commands (HI-1954, Settings → Commands at its level) and its open and close points. */
  commands?: CommandsWorkspace
}

/**
 * A command of the user's (HI-1954, like JetBrains' External Tools): run by cmd.exe from `folder` (the workspace's folder
 * when absent), its placeholders filled in (shared/commands.ts fillCommand), by hand or at the points that pick it.
 */
export interface CustomCommand {
  /** `c-` and 8 hex. */
  id: string
  name: string
  command: string
  folder?: string
  /** "The commands after this need it": failing, its dialog leads with Stop here; unattended, the list stops there. */
  needed?: boolean
}

/** A command a point runs: Hive's or the workspace's, by id. */
export interface CommandRef {
  scope: 'hive' | 'workspace'
  id: string
}

/** A point's commands, in the order they run. `onUpdate`: close and quit run them too when Hive restarts for an update. */
export interface CommandPoint {
  run: CommandRef[]
  onUpdate?: boolean
}

/** Hive's commands and When Hive quits, run (its commands only). */
export interface CommandsHive {
  list: CustomCommand[]
  onQuit: CommandPoint
}

/** A workspace's commands and its points, which may pick Hive's commands too. */
export interface CommandsWorkspace {
  list: CustomCommand[]
  onOpen: CommandPoint
  onClose: CommandPoint
}

/**
 * A command Hive runs as a workspace closes, or as Hive quits (HI-1368), waiting for it with a panel. An object, not a
 * bare string, so it can later be one of a workspace's named commands without a migration.
 */
export interface CloseCommandSetting {
  /** The command, run by cmd.exe; `{workspace}`, `{name}` and `{reason}` are filled in. Empty: nothing runs. */
  command: string
  /** Run it too when Hive restarts to install an update (skipped by default). */
  onUpdate: boolean
}

/** Why a close command runs: its `{reason}`. */
export type CloseReason = 'window' | 'switch' | 'quit' | 'update'

/** A close command's run as its panel shows it (HI-1368): the `close-command` event's and closeCommand:state's. */
export interface CloseCommandRun {
  id: string
  /** 'workspace': this window's workspace's; 'quit': When Hive quits, run. */
  kind: 'workspace' | 'quit'
  /** The command as it runs, its placeholders filled in. */
  command: string
  startedAt: string
  /**
   * saving: its workspace isn't closed and written yet (the spinner, Skip the command, which skips its command and When
   * Hive quits, the close itself always finishing); running: the command (the spinner, Don't wait); failed: its exit
   * code (or why), Close; ok and left: the panel goes.
   */
  state: 'saving' | 'running' | 'ok' | 'failed' | 'left'
  /** The workspace's folder name, for the saving step's "Waiting for <workspace> to finish saving…". */
  workspace?: string
  /** The saving step's Skip the command was pressed: the command won't run, and the panel stays until the close ends. */
  skipped?: boolean
  /** The output's last lines (at most 8, each at most 400 characters). */
  lines: string[]
  exitCode: number | null
  /** Why it failed without an exit code: 'drain' (its workspace's close didn't finish, so it didn't run), 'spawn', 'runner'. */
  failure?: 'drain' | 'spawn' | 'runner'
  /** The error, for 'spawn' (the system's text). */
  error?: string
  /** Which point runs it (HI-1954): a workspace opening or closing, Hive quitting, or by hand. */
  point?: 'open' | 'close' | 'quit' | 'manual'
  /** Its commands, in the order they run (HI-1954); `command`, `lines` and `exitCode` above are the current step's. */
  steps?: CloseCommandStep[]
  /**
   * A failed step waiting for the user's choice (HI-1954): Rerun, Skip it and continue, Stop here, the controls bound to
   * its step and attempt. `needed`: "The commands after this need it" is ticked, so Stop here leads.
   */
  awaiting?: { step: number; attempt: number; needed: boolean } | null
}

/** A step of a run as its panel shows it (HI-1954). */
export interface CloseCommandStep {
  name: string
  state: 'waiting' | 'running' | 'ok' | 'failed' | 'skipped'
  exitCode: number | null
  /** Why it failed with no exit code: a placeholder or folder it couldn't use, or the command not starting. */
  failure?: 'placeholder' | 'folder' | 'spawn'
  detail?: string
  startedAt?: string
  endedAt?: string
}

/**
 * Slot options a level (Hive's, a workspace's) gives the Git projects under it (HI-1765). `copy`: the git-ignored files
 * copied into each new slot and review copy, glob patterns, comma separated or one per line; left out, the level
 * inherits; an empty string is none.
 */
export interface SlotDefaults {
  copy?: string
}

/** A project folder Hive leaves out of the workspace, until it's restored in Settings → Workspace. */
export interface HiddenProject {
  name: string
  /** hidden: everything left where it is. removed: its workspace files were packed into the folder's .hive/removed. */
  mode: 'hidden' | 'removed'
  at: string
}

// ---------------------------------------------------------------------------
// Task board: one per workspace, a card per file in .hive/tasks.
// ---------------------------------------------------------------------------

/** On Hold, Todo, Doing, Review, Passed, Done (#170): Passed is reviewed and waiting to be merged, Done is merged. */
export type TaskColumn = 'hold' | 'todo' | 'doing' | 'review' | 'passed' | 'done'

/** A column of the board (#1420): a category's, or `merging`, a stage with a column of its own inside Approved. */
export type BoardColumnId = TaskColumn | 'merging'

/** A board as the user left it (a view preference, never in the cards' files): collapsed columns and folded cards. */
export interface BoardFold {
  /** A category's applies to its stage's column; Merging keeps its own. */
  columns?: BoardColumnId[]
  cards?: number[]
}

export interface TaskComment {
  at: string
  /** "You", "Assistant", or an agent ("Agent 2 (Claude Code) in hive"). */
  by: string
  text: string
  /** A comment Hive wrote itself (#845): its text as data, for the window; `text` is its English. */
  hiveText?: StoredText
  /** Unique on the card (#224): what a card watch counts its view of the card by. Comments from before have none. */
  id?: string
}

export interface TaskHistoryEntry {
  at: string
  by: string
  /** In English, always (#845): agents read it, and Hive's own code matches it. */
  what: string
  /** What happened as data (#845), for the window to show in the user's language: entries from before have none. */
  whatText?: StoredText
  /** Unique on the card (#224), as a comment's. */
  id?: string
}

/** A card's context reference that doesn't resolve (#819): the reference, why, and the closest headings' slugs (without #). */
export interface ContextProblem {
  ref: string
  /** outside, hidden, notMarkdown, notFound, tooBig (its file), invalid (not a reference), noHeading or ambiguous (its heading). */
  problem: 'outside' | 'hidden' | 'notMarkdown' | 'notFound' | 'tooBig' | 'invalid' | 'noHeading' | 'ambiguous'
  closest?: string[]
}

export interface TaskCard {
  /** #number, unique in the workspace and never reused. */
  number: number
  /**
   * Its key (#1219, #704): its project's key and its number there, `HI-12`; absent for a card with none (a workspace
   * card, a project with no key yet, a 0.9 board). Worked out when the card is read, never saved with it.
   */
  key?: string
  title: string
  /** Markdown. */
  description: string
  /** The project's folder name; '' for a card about the workspace. */
  project: string
  /** The agent working on it (its id in the project), if any. */
  agent: string | null
  /** The agent's name when it was assigned, for when the agent is gone. */
  agentName?: string
  /**
   * An agent reviewing it now, apart from the agent that has it (who did the work): from its review "start" to its
   * verdict, while the card stays in Review. Absent when nobody is (and in cards from before reviews were marked).
   */
  review?: TaskReview
  column: TaskColumn
  /** Position in its column, smallest first. */
  order: number
  labels: string[]
  /** Why it can't go on, when it can't (shown in red in any column). */
  blocked: string | null
  /** Cards that have to be done first. */
  blockedBy: number[]
  /** Related cards. */
  links: number[]
  /**
   * Doc sections the agent reads first (#818): references by file and heading, never by line (`docs/PLAN.md#setup`,
   * `shared:plans/notes.md#open-questions`; shared/docRefs.ts). Absent when none.
   */
  context?: string[]
  /**
   * Its context references that didn't resolve when they were last checked (#819: when the list was edited, and when the
   * card was started): which, why, and the closest headings' slugs. Absent when all did.
   */
  contextProblems?: ContextProblem[]
  comments: TaskComment[]
  history: TaskHistoryEntry[]
  /** Hidden from the board, kept and searchable. */
  archived: boolean
  /** Who held it when (#602): its agent while in Doing, its reviewer while reviewing. What its cost is worked out from. */
  held?: TaskHold[]
  /**
   * Who archived it: the user, Hive after its days in Done (Settings → Board), or its project being hidden or
   * removed (restoring the project brings those back).
   */
  archivedFor?: 'user' | 'done' | 'project-hidden' | 'project-removed'
  /** The bulk archive it went with (an ArchiveBatch's id, #351): Undo and "Unarchive this batch" bring that batch back. */
  archivedBatch?: string
  /** What the user decided about it (#357), oldest first: agents follow these over the description. Absent when none. */
  decisions?: TaskDecision[]
  createdAt: string
  createdBy: string
  updatedAt: string
  /**
   * An archived card as the window's board has it until it needs it in full (#1017): its title, place, agent, labels and
   * dates, with no description, comments, history or decisions. Never in what agents read.
   */
  summary?: true
}

/**
 * A bulk archive by the user (#351): Archive All in a column, or Archive All Cards. Kept so the batch can be brought back
 * later (Undo, "Unarchive this batch"), each card where it was.
 */
/**
 * The board's state for the window (#1207): why it is read-only (saved by a newer Hive, or waiting for its upgrade to 1.0,
 * which the user is asked for), and when the copy kept from before its upgrade to 1.0 was made (Help → Restore the 0.9
 * Board Backup… puts it back), if there is one.
 */
export interface BoardState {
  readOnly: 'newer' | 'upgrade' | null
  backup09: { at: string } | null
}

export interface ArchiveBatch {
  id: string
  at: string
  by: string
  /** What was archived, in a few words: "All in Done", "5 shown in Todo", "All Cards". */
  label: string
  /** The cards it archived. */
  cards: number[]
  /** Each column the cards left: its cards, top to bottom, as it was then (the batch's and those that stayed). */
  columns: Partial<Record<TaskColumn, number[]>>
}

/**
 * A card an older Hive saved after the board moved to its database (#1017), set aside in `.hive/tasks.set-aside` for the
 * user to review (#1044): added as a new card or discarded. Its fields are as the older Hive saved them.
 */
export interface SetAsideCard {
  /** Its file's name in the set-aside folder: what Add and Discard name. */
  file: string
  /** The number the older Hive gave it (from the file's name), or null. */
  number: number | null
  /** Whether that number is free on the board: Add keeps it, else gives the next free one. */
  free: boolean
  /** False when the file isn't a card (not JSON): it can only be discarded. */
  readable: boolean
  title: string
  /** The start of its description, cut short. */
  preview: string
  project: string
  column: TaskColumn
  createdBy: string
  createdAt: string
  comments: number
}

/** What the user asked Archive All for (#351): main checks it again on each card as it is when it is archived. */
/** Where a window's copy of the board stands (HI-1715): the board's stamp and the mark it last read. */
export interface TaskCursor {
  board: string
  mark: number
}

/**
 * A window's board read (HI-1715, `tasks:changes`): the cards changed since its cursor (every card when `full`), the live
 * ones in full and the archived in short (`summary`), with every card's number (a card not among them is gone) and the
 * cursor to send next. `stale`: the board was opened again, or the workspace changed, while it was read: read again.
 */
export type TaskChanges = { stale: true } | { stale?: false; board: string; mark: number | null; full: boolean; cards: TaskCard[]; numbers: number[] }

export interface ArchiveRequest {
  /** What it was, in a few words (ArchiveBatch.label). */
  label: string
  /** The column it was for; null: the whole board. */
  column: TaskColumn | null
  /**
   * The stage it was for, where its category shows several (Approved beside Merging, #1420): a card in another stage
   * of the column, as its facts say now, stays.
   */
  stage?: StageId
  /** The project the board showed (null: every project) and its search: a card that has left them stays. */
  project: string | null
  query: string
  /** Also cards agents are on (in Doing with their running agent, being reviewed, watched). */
  includeBusy: boolean
}

export interface ArchiveResult {
  batch: ArchiveBatch | null
  archived: number[]
  /** Cards left on the board after all: changed meanwhile (an agent took one, it moved), or not readable or saved. */
  skipped: { number: number; why: string }[]
}

/** A batch brought back: `failed` couldn't be read or saved, stay archived, and keep the batch for another try. */
export interface UnarchiveResult {
  restored: number[]
  failed: number[]
}

/**
 * A decision the user made about a card (#357): scope, wording, a default, "option B". The card is the record: agents
 * read these when they start and before Review, and reviewers check the work against them.
 */
export interface TaskDecision {
  /** Unique on its card: the user edits or removes a decision by it. */
  id: string
  text: string
  /** Always the user: an agent or the Assistant only records what the user decided. */
  decidedBy: 'user'
  /** Who wrote it down: "You" (the user), "Assistant", or an agent ("B5 (hive)"). */
  recordedBy: string
  at: string
  /** When the user last changed its words. */
  editedAt?: string
}

/**
 * An agent holding a card for a while (TaskCard.held): its builder (its agent, while the card is in Doing) or its
 * reviewer (from its review's start to its verdict). Kept by Hive as the card changes (cardCosts.ts trackHolds); a
 * card from before has them worked out from its history once, by the agents' names.
 */
export interface TaskHold {
  /** The agent's id in the card's project; absent when worked out from history by a name that wasn't the card's agent's. */
  agent?: string
  name: string
  role: 'build' | 'review'
  from: string
  /** Absent while it still holds it. */
  to?: string
}

/** An agent reviewing a card (TaskCard.review). */
export interface TaskReview {
  /** The reviewing agent's id in the card's project, and its name then. */
  agent: string
  agentName: string
  /** When it started (ISO). */
  since: string
}

/** What a change to a card may set (the board's own fields: number, history and dates are Hive's). */
export interface TaskPatch {
  /**
   * An agent reviewing the card (in Review): "start" marks it as reviewing it, "passed" or "failed" ends the review
   * with its verdict. The card keeps the agent that did the work.
   */
  review?: 'start' | 'passed' | 'failed'
  title?: string
  description?: string
  project?: string
  agent?: string | null
  column?: TaskColumn
  /** Before this card in the column (null: at the end). Only with column or on its own to reorder. */
  before?: number | null
  /** At the top or the bottom of the column (instead of before). */
  position?: 'top' | 'bottom'
  /** Replaces the card's labels. Not with addLabels or removeLabels. */
  labels?: string[]
  /** Labels added where missing, keeping the others (#1131). */
  addLabels?: string[]
  /** Labels taken off where present, keeping the others (#1131). */
  removeLabels?: string[]
  blocked?: string | null
  blockedBy?: number[]
  links?: number[]
  /** The doc sections to read first (#818), replacing the list; [] clears it. */
  context?: string[]
  /** Records a decision the user made (#357), attributed to the user whoever records it. Editing or removing one is the user's (tasks:editDecision). */
  decision?: string
  /**
   * HI-1932: the card's open requests (For you, their ids) the `decision` answers, closed with it in one write. Only with
   * a decision and no other field; only the user's or the Assistant's (never an agent's).
   */
  answers?: string[]
  /** HI-1932, set by Hive itself: the id the decision is recorded with (the one its answers name). */
  decisionId?: string
  /**
   * A column move across workflow rules (#1265, SPEC §16.8.4), with why: the Assistant's, required when its move skips
   * a rule (else refused, naming them); the user's reason, optional. Never an agent's.
   */
  override?: { reason: string }
}

/**
 * What the window's move of a card came to (`tasks:move`, #1265): moved (the card as saved; `stopped`: it went only as
 * far as it could, the step after refused for what no override makes true, such as nothing to submit, §16.8.4), or a
 * question first (the rules the move would skip: nothing written; move again with `confirm`), or refused. `leftOut`
 * (HI-2352): a None code card's submission, asked first what its paths leave out: move again with `paths`.
 */
export type TaskMoveResult = { moved: TaskCard; stopped?: Refusal } | { ask: string[] } | { leftOut: { paths: string[]; files: string[] } } | { refused: Refusal }

/** Which agent Start gives a card to; a new one runs on `connection` (its id: HI-2121), else the first usable here. */
/** `worktree` (0.9's own worktree for a new agent) is refused since 1.0 (#1451); the window stops sending it (#1442). */
export type TaskStartTarget = { kind: 'agent'; agentId: string } | { kind: 'new-agent'; worktree?: boolean; name?: string; connection?: string }

/** How a project leaves Hive (the main menu's Project → Remove Project…). */
export type ProjectRemoval = 'hide' | 'remove' | 'delete'

/** What removing a project touches, for its dialog. */
export interface ProjectRemovalInfo {
  name: string
  path: string
  /** Running agents, which are stopped first. */
  running: number
  /** Its handovers in the shared notes. */
  handovers: string[]
  /** Its board cards (not archived / archived). */
  cards: number
  archivedCards: number
  /** Worktree agents: their folder, and work not merged into the project folder (commits ahead, uncommitted files). */
  /** `error`: git couldn't check it, which counts as holding work. */
  worktrees: { agent: string; path: string; branch: string; ahead: number; dirty: number; error?: string }[]
  /**
   * Its slots, copies and retired homes (#1447), with what removing the project would do to each: `kept`, why it would
   * stay (the guarded clean-up's reason, or a home's, or a folder Hive didn't make), or null: removed.
   */
  folders?: { of: ProjectFolderOf; path: string; kept: string | null; blocksDelete?: string }[]
}

/** A project folder holding what Remove from Hive packed into its .hive/removed. */
export interface RemovedData {
  at: string
  workspace: string
  handovers: number
  cards: number
}

export type Inherit<T> = 'inherit' | T

/**
 * Workflow options a level sets for its projects (SPEC §16.6.6: global in config, the workspace's in workspace.json), per
 * platform: an option unset inherits the level before (the platform's all-off at the bottom, the project's own on top).
 */
export type WorkflowDefaults = Partial<Record<PlatformId, Partial<Omit<WorkflowOptions, 'platform'>>>>

/**
 * A project's workflow options as project.json keeps them (SPEC §16.6.6): the options it sets itself (an option it
 * doesn't set inherits the workspace's, then Hive's, then the platform's all-off), and the preset they started from.
 */
export interface ProjectWorkflow {
  platform: PlatformId
  preset: PresetId | null
  options: Partial<WorkflowOptions>
  /**
   * The other platforms' preset, options and answer to "How do you work?", kept while another one is in force so
   * switching back restores them (#1419). Written with `setKept`, never by replacing `workflow` (#1417's `writeWorkflow`).
   */
  kept?: Partial<Record<PlatformId, { preset: PresetId | null; options: Partial<WorkflowOptions>; presetAsked?: PresetAsked }>>
  /** The answer to "How do you work?" for the platform in force (#1423), written with `setPresetAsked`. */
  presetAsked?: PresetAsked
  /**
   * HI-1697: set by the 1.0 upgrade on a Git project from 0.9, whose merge style and commit message (G6, G19) nobody
   * chose, and kept: the merge queue asks before its first merge (For you) until the board records a choice (the answer,
   * or a save that changes either; optionsForm.ts).
   */
  mergeAsk?: true
  /**
   * HI-1997: Git's commit message (G19) set to Hive's by a choice, not left by a preset: set by `writeWorkflow` when a
   * write changes it to 'hive', kept while it stays so. The one-time switch to the branch's own keeps such a project's.
   */
  commitMessageChosen?: true
}

/** The answer to "How do you work? Solo / Pair / Team" (#1423): a preset was chosen, or Not now. */
export type PresetAsked = 'chosen' | 'notNow'

/** A project's stages as the board shows them (#1417, `workflow:stages`): those its options produce, and its own names. */
export interface ProjectStages {
  stages: StageDef[]
  names: Partial<Record<StageDef['id'], string>>
  /** The preset its options started from (null: none chosen): Solo hides its ended lanes from Pulse (#1421). */
  preset: PresetId | null
}

/** Where a workflow option's value came from: the platform's all-off, or the level that set it (§16.6.6). */
export type WorkflowOptionOrigin = 'platform' | 'global' | 'workspace' | 'project'

/** The Workflow section of Project Settings (#1278): the project's options, what they inherit, and the presets on offer. */
export interface WorkflowForm {
  platform: PlatformId
  /** A level's defaults (#1422: Hive's, the workspace's) rather than a project's options. */
  level?: WorkflowLevel
  /** The preset the project's options started from (null: none chosen). */
  preset: PresetId | null
  /** The options the project sets itself. */
  own: Partial<WorkflowOptions>
  /** The options in force, with where each came from; `invalid` when they fell back to all-off (English, why). */
  options: WorkflowOptions
  origins: Record<keyof WorkflowOptions, WorkflowOptionOrigin>
  invalid: string | null
  /** What each option would be without the project's own value (the workspace's, Hive's, or all-off), and from where. */
  inherited: WorkflowOptions
  inheritedOrigins: Record<keyof WorkflowOptions, WorkflowOptionOrigin>
  /** The presets offered, in order, each with its options for this project; `needs`: shown unavailable, with why. */
  presets: { id: PresetId; options: WorkflowOptions }[]
  /** The project's commit identity from its git config (G12), or null. */
  identity: { name: string; email: string } | null
  /** Settings → Advanced → Workflow rules are enforced: off, the options are saved but no rule applies. */
  enforced: boolean
}

/**
 * A change to a project's workflow options: the preset they start from and the options the project sets itself. `base`:
 * the preset and options the window's form was read with (#1418); a save is refused when the project's are no longer
 * those (changed meanwhile by the Assistant's tool or another window), never written over them.
 */
export interface WorkflowChange {
  preset: PresetId | null
  options: Partial<WorkflowOptions>
  base?: { preset: PresetId | null; options: Partial<WorkflowOptions> }
}

/** Why options can't be saved: a contradiction or a value not offered yet (their messages), or a reason in English. */
export type WorkflowProblem = OwnWorkflowProblem | { kind: 'inheritor'; project: string; problem: OwnWorkflowProblem }

/**
 * A problem of the options being saved themselves; an inheritor's (#1422): a project inheriting a level's change would
 * have that problem in its own options.
 */
export type OwnWorkflowProblem = { kind: 'contradiction'; id: Contradiction } | ({ kind: 'stageName' } & StageNameProblem) | { kind: 'bad'; why: string }

/** The levels of workflow defaults the window edits (#1422): Hive's (config) and the workspace's (workspace.json). */
export type WorkflowLevel = 'global' | 'workspace'

/**
 * What saving a level's defaults would do (#1422): its problems (an inheriting project's contradiction among them), the
 * options it changes, and each project inheriting a changed option, with what changes for it, its running lanes and its
 * cards in flight (they keep their rules: from the next card).
 */
export interface WorkflowLevelCheck extends WorkflowCheck {
  projects: { name: string; path: string; workspace: { path: string; name: string }; changed: (keyof WorkflowOptions)[]; lanes: { id: string; name: string | null; builder: string }[]; inFlight: { number: number; key: string; title: string }[] }[]
}

/** What saving a change would do (§16.6.5's warning): its problems, the options it changes, and what keeps the old rules. */
export interface WorkflowCheck {
  problems: WorkflowProblem[]
  changed: (keyof WorkflowOptions)[]
  /**
   * Whether the change applies at once to every card (#1417): it changes only names (N5), which aren't rules, so no card
   * or lane keeps old rules (then `lanes` and `inFlight` are empty).
   */
  appliesNow: boolean
  /** The project's running lanes: their cards keep the rules they started with until the lane ends. */
  lanes: { id: string; name: string | null; builder: string }[]
  /** Its cards in flight (started, not done): each keeps its rules, unless the change is applied to it. */
  inFlight: { number: number; key: string; title: string }[]
}

/**
 * What switching a project's version control would do (#1419, §16.6.5's warning): from what to what, why it can't be
 * made now (null: it can), and the running lanes and cards in flight that keep their platform's rules. A switch is never
 * applied to cards in flight: a Git card can't finish under None's rules.
 */
export interface PlatformSwitchCheck {
  from: PlatformId
  to: PlatformId
  refused: SwitchRefusal | null
  lanes: { id: string; name: string | null; builder: string }[]
  inFlight: { number: number; title: string }[]
  /** None chosen for a folder that is a Git repository: Hive then records no commits or merges for its cards. */
  gitFolder: boolean
  /** A card in flight goes through Hive's merge queue (its ruleset's): the queue carries on, and stays shown. */
  queue: boolean
}

/** A project's Session tab as this user left it (AppConfig.ui.projectViews, HI-1749): ProjectConfig's view fields. */
export type ProjectView = Partial<Pick<ProjectConfig, 'sessionView' | 'layout' | 'placement'>>

export interface ProjectConfig {
  /** 2 since 0.2.0: agents are all equal and a project starts with none (0.1's agents are cleared). */
  version: 2
  /**
   * The project's stable id (#508), made once and kept in its folder, so it goes with a rename or a move: the workspace's
   * cards, lanes and watches name the project by it (and by its folder name, read back from the id).
   */
  id?: string
  /** Project-scoped shortcut overrides (project, session and agent commands), over the global ones. */
  keybindings?: KeybindingOverrides
  /**
   * The workspace's MCP servers added to this project (HI-2059, its MCP tab): the ones that run here. `model` 3 says
   * `enabled` means added; before it is converted, #1093's meaning holds (on here and on in the workspace, mcpAdded).
   * `disabled` is from before #1093 (a project turning off a server on for all projects): read once when the
   * workspace's settings are moved to #1093's model, then emptied.
   */
  mcp: { disabled: string[]; enabled: string[]; model?: 3 }
  /** The Hive skills this project's agents aren't given (#1431, its Skills tab → Delivered to agents), over the workspace's. */
  skillDelivery?: SkillDeliveryChoice
  chime: 'inherit' | 'on' | 'off'
  /** This project's own Suggest a fresh start (#1437), over Settings → Notifications'. */
  suggestFreshStart: 'inherit' | 'on' | 'off'
  /** Carrying on (#1432, shared/inboxSwitches.ts): this project's own inbox switches over Settings → Advanced's; inherit uses those. */
  inboxCheckpoints: 'inherit' | 'on' | 'off'
  inboxStopContinuation: 'inherit' | 'on' | 'off'
  inboxIdleWakes: 'inherit' | 'on' | 'off'
  /**
   * The provider new agents got (Add Agent's quick add), before HI-2106 (decision A: the one order of accounts instead);
   * removed by the accounts migration, and only shown until the window's screens follow (HI-2107).
   */
  defaultProvider: Inherit<ProviderId>
  /**
   * The project's settings per provider, over the global ones, before HI-2106: read once by the accounts migration (its
   * agents' connections then hold them), and removed by it.
   */
  providers: Record<ProviderId, ProjectProviderConfig>
  /** Overrides settings.sessions.compactSuggestTokens for this project; null inherits. */
  compactSuggestTokens: number | null
  /** Overrides settings.sessions.transcriptWarnMB for this project; null inherits. */
  transcriptWarnMB: number | null
  /** Archived cards' attachments go this many days after archiving, or never (HI-1842, shared/cardCleanup.ts). */
  cardAttachmentCleanup: 'off' | '3' | '7' | '30' | '90'
  /** The project's agents, in the order they were added. All are equal; a new project has none. */
  agents: AgentDef[]
  /**
   * One-time changes made to the project, recorded with what they did: `connections1`, per CLI, its model, effort and
   * context overrides moved onto its agents (HI-1770), written with them in one write; `accounts1` (HI-2106), each agent
   * pointed at the connection it launched with, and the project's and agents' own launch settings removed, in one write
   * (`unplaced`: agents whose CLI had no account to make one on, by id, with what they would have launched with).
   */
  migrations?: { connections1?: Partial<Record<ProviderId, ConnectionsMoved>>; accounts1?: ProjectAccountsMigration }
  /** The Session tab's layout (one for the project, #134); its pages hold as many agents as it has panes. */
  layout: PageLayout
  /**
   * Where the user put each agent's pane, per layout (#762): its cells page after page, an agent's id or null for an
   * empty cell (shared/paneCells.ts). A layout without one shows the agents in order.
   */
  placement?: Partial<Record<SessionLayout, (string | null)[]>>
  /** The Session tab's view, once chosen with its Panes | Tiles toggle (#975); absent, Settings → Sessions → Default session view. */
  sessionView?: SessionView
  /** Where the project folder was last opened (#146), as workspace.json's lastPath. */
  lastPath?: string
  /**
   * The folder Hive's profile keeps this project's view preferences by (HI-2008), set once they have followed it here:
   * apart from lastPath, which stays where Repair needs it until Repair is done, as workspace.json's profileAt.
   */
  profileAt?: string
  /**
   * Folders that moved (an agent's worktree repaired or recreated at a new place) whose CLI data (copyPathData) isn't
   * all copied yet (#146): kept until a copy works, so Repair tries again, after a restart too.
   */
  pendingCopies?: { from: string; to: string; of: string; owner?: MoveOwner }[]
  /**
   * Agents' branches Repair is renaming (#1305), recorded before git's rename and dropped once git, the agent's record
   * and the cards' lines all have the new name: a rename cut short (a file that couldn't be written) is finished by the
   * next Repair, whichever of its steps were done.
   */
  pendingBranchRenames?: { agentId: string; from: string; to: string }[]
  /**
   * Worktrees kept after their agent was replaced (#289: loading a template) before its first session ran the worktree
   * setup command: an agent that works in one again runs it first (needsSetup), so it isn't lost, nor run twice.
   */
  setupPending?: string[]
  /**
   * Workspace parts other than the workspace's own that Hive has given this project's worktree branches
   * (hive/<part>/<project>/<agent>, #703 round 3: when a branch from before was in the way of its own): with its own,
   * the only ones Hive takes for this project's. Added when Hive first makes a branch in one; never removed.
   */
  branchSpaces?: string[]
  /**
   * The project's version control platform (SPEC §16.3), recorded from detection when Hive makes its project.json and
   * never switched silently: a different detection later is offered (ProjectInfo's `platform.offer`).
   */
  platform?: PlatformId
  /**
   * What detection found when the user last switched the platform (#1419, `foundKey`): `git`, `none` or `other:<name>`.
   * While the folder still shows that, no switch is offered: choosing None for a Git folder isn't asked about again.
   */
  platformFound?: string
  /**
   * The project's workflow options (SPEC §16.6.6, OP-5): its platform, the preset they came from (null: set one by one,
   * or the upgrade's), and the options. The upgrade to 1.0 writes them from how the project works today (#1218, §16.17);
   * read-only in P3 (P4's Version Control tab edits them).
   */
  workflow?: ProjectWorkflow
  /**
   * The one-time upgrade steps settled in this project (#1445's `workflow.slotsUpToDateFromBeforeP7`), each recorded in
   * the same write as its change, so a later run can tell it from a choice the user made since, after a failure too.
   */
  stepsDone?: string[]
  /**
   * From before HI-1766 (Project Settings → Agents → File locks): kept, with the old Card loops keys below, only while the
   * project has no workflow options to hold them (shared/workflow/preferences.ts); read as its own until then.
   */
  fileLocks?: Inherit<FileLockMode>
  /** Overrides settings.agents.worktreeCopy; null inherits. */
  worktreeCopy: string | null
  /** Command run in a new worktree before its agent's first session, e.g. "npm install". */
  worktreeSetup: string
  /**
   * The project's slot options (#1429, SPEC §16.10.2): the setup command run in a new slot (and again when its lock
   * files change), the archive command run before Hive removes one, and the git-ignored files copied into a new one.
   * Each left out reads today's `worktreeSetup`, none, and `worktreeCopy` (which stay as they are, for 0.9.3).
   */
  slots?: SlotOptions
  /** The project's review and check copies (#1435): how many it keeps (left out: the larger of 2 and its reviewers plus one). */
  copies?: { size?: number }
  /** From before HI-1766 (Project Settings → Card loops): see `fileLocks`. */
  loopWakes?: boolean
  loopRounds?: number | null
  loopWaitHours?: number | null
  loopStepWaitMinutes?: number | null
}

/** One of a project's slots as the window reads it (#1429, slots.ts): its state and its open lease, if any. */
export interface SlotView {
  name: string
  folder: string
  state: 'creating' | 'ready' | 'lent' | 'dirty' | 'gone' | 'removing'
  /** Its last setup or install failed: why (in English) and the run's log. */
  warmError: string | null
  warmLog: string | null
  lease: { id: string; kind: 'card' | 'lane' | 'carried'; agent: string; card: number | null; lane: string | null } | null
  /**
   * The session run writing in it now (#1434): its agent and the lease it started under, until it has exited. `held`
   * (#1506): its run is over but its processes aren't known to have ended (nor its Hive running), so only Release Slot…
   * frees it.
   */
  writer: { agent: string; lease: string; held: boolean } | null
}

/** A slot's writer as Release Slot… shows it (#1506, agentFolders.ts heldWriter). */
export interface HeldWriter {
  slot: string
  agent: string
  run: string
  /** The Hive holding it: this one (`self`), or another and whether that one still runs (null: can't be told). */
  hive: { pid: number; self: boolean; alive: boolean | null }
  /** Its run is still live in this Hive (its session, or the processes it left still followed): Release is refused. */
  live: boolean
  /**
   * What Hive lists of the processes its run left running: its leftovers (the agent's ⋯ lists them), or, its Hive gone,
   * the agent's processes that the notice that Hive closed unexpectedly lists and that still run. Null: not known.
   */
  processes: { list: AgentProcess[]; more: number; from: 'leftovers' | 'restart' } | null
  /** Every process listed is Windows' own idle broker (HI-2309: a Sandbox's, none running): releasing it is safe. */
  idleBrokers?: true
}

/** One of a project's review and check copies as the window reads it (#1435, copies.ts): its state and its lease not freed. */
export interface CopyView {
  name: string
  folder: string
  state: 'creating' | 'free' | 'leased' | 'returning' | 'dirty' | 'gone'
  revision: string | null
  warmError: string | null
  lease: { id: string; kind: 'review' | 'check'; card: number; agent: string | null; returned: boolean } | null
}

/** What a test copy asks of a project's slot pool (`slots:test`, unpackaged builds only: #1429's e2e). */
export type SlotTestOp = { op: 'lend'; agent: string; card?: number; lane?: string; slot?: string } | { op: 'release'; lease: string; why?: string } | { op: 'tidy'; at?: number } | { op: 'remove'; slot: string } | { op: 'carry'; agent: string; slot: string; folder: string } | { op: 'homes'; folders: string[] } | { op: 'writer'; slot: string; agent: string; run: string; pid: number; started: number } | { op: 'quit'; agent: string }

/** A project's slot options as project.json keeps them (ProjectConfig.slots): each left out falls back (slots.ts). */
export interface SlotOptions {
  setup?: string
  archive?: string
  copy?: string
}

export interface ProjectProviderConfig {
  model: string // 'inherit' or a model alias / id
  effort: Inherit<EffortLevel>
  permissionMode: Inherit<PermissionMode>
  extraArgs: string
  /** 200K context instead of 1M (capabilities.contextLimit). */
  use200kContext: Inherit<'on' | 'off'>
}

/** One of a project's agents (up to 24, #562; the Assistant's up to Maximum agents, HI-2001). Settings left undefined follow the project's. */
export interface AgentDef {
  /** Random and never reused, so session records of removed agents don't attach to new ones. */
  id: string
  name: string
  /** The CLI this agent runs: its connection's account's (HI-2106), kept with it. Always stored when the agent is added. */
  provider?: ProviderId
  /**
   * Its own model, effort, mode and context before HI-2106: read once by the accounts migration (its connection then
   * holds them) and removed by it. Stored since only while it has no connection because its CLI has no account here yet,
   * for the connection it gets once one is (placeUnplaced). In a window's AgentInfo, its connection's values (the
   * adapter until HI-2108); in a patch or a new agent's options, a change of them: the connection on its account with
   * them, made if none is.
   */
  model?: string
  effort?: EffortLevel
  permissionMode?: PermissionMode
  /** 200K context instead of 1M (capabilities.contextLimit); as model. */
  use200kContext?: boolean
  /** Session to resume for this agent. */
  lastSessionId?: string
  /** The Hive Assistant only: this workspace's mode, over Settings → Assistant. */
  mode?: string
  /** A note on what the agent is for (free text, #126; shown as Note since #1430): saved in templates. */
  role?: string
  /** Which side of the workflow it takes (#1430); unset, the guess from its note or name (`agentWorkflowRole`). */
  workflowRole?: WorkflowRole
  /**
   * The agent it is paired with (#1436): a builder's reviewer, or a reviewer's builder, by name, as a template's `pairs`
   * made it. Start Lane fills in a builder's reviewer from it (#1443).
   */
  pairedWith?: string
  /**
   * Only these of the project's MCP servers (#537, shared/agentMcp.ts), saved in templates; absent: all of them. The
   * built-in hive server is given whatever this says.
   */
  mcpServers?: string[]
  /**
   * The connection it runs on (HI-2106: a Connection's id; before it, HI-1755, an account's). Its account off in the
   * workspace, or the connection removed, or none: it launches on its CLI's first usable connection here and says so
   * (decision H). In a window's AgentInfo, its account's id (the adapter until HI-2108; `connectionId` is the connection's).
   */
  connection?: string
  /**
   * Its "Dialect" setting (dialects, HI-2443): the file of its CLI's dialects folder that fills its chain's model slot,
   * by its path there ("claude-code/Opus 5.5 v2.json"), for an A/B test or a model Hive can't identify. Absent: Auto (the
   * model file whose `model` is the real model ID it runs). Applies at its next launch; changing its CLI clears it.
   */
  dialect?: string
}

/** A change to an agent's settings: empty values (null for use200kContext and mcpServers) clear an override so it follows the project. */
export type AgentPatch = Partial<Pick<AgentDef, 'name' | 'provider' | 'mode' | 'role'>> & { mcpServers?: string[] | null; workflowRole?: WorkflowRole | null; connection?: string | null; /** null, '' or 'auto': Auto again. */ dialect?: string | null }

/**
 * The dialect chain a session was launched on (dialects, HI-2443), in its launch record: pinned at launch, so an edit
 * applies at its next one.
 */
export interface LaunchDialect {
  /** Each layer, top first, with the file that filled it (null: empty, off or missing). */
  layers: { layer: 'model' | 'cli' | 'workspace'; file: string | null }[]
  /** A hash of the texts it overrides; '' when it overrides none (it speaks the Default). */
  hash: string
  /** Hive's guidance revision as said in this chain: the Default's (`guidance`) unless the chain changes its text. */
  guidance: string
  /** The real model ID it launched with, which Auto matches by; absent when Hive couldn't name it. */
  model?: string
  /** Hive couldn't name the model, so Auto left the model slot empty ("model unknown"); never with a file picked. */
  modelUnknown?: true
  /** The file the agent picked, when it did (its Dialect setting). */
  pick?: string
  /** The file it picked is gone: Auto filled the slot instead. */
  pickMissing?: true
}

/** Why a connection can't be an agent's own choice here (HI-1769): removed, another CLI's, or off in its workspace. */
export type ConnectionProblem = 'missing' | 'otherCli' | 'off'

/** What loading a template into a project would do (#126), and what stops it now. */
export interface TemplateLoadPlan {
  scope: TemplateScope
  file: string
  name: string
  layout: PageLayout
  /** The project's agents, all removed: running ones and uncommitted worktree work block the load. */
  remove: { id: string; name: string; running: boolean; dirty: number; worktree?: { path: string; branch: string } }[]
  /**
   * The agents it creates, with the names chosen in the dialog (#702) when it gave some, its patterns expanded with the
   * project's key (#1123 names), each with the CLI it suggests (HI-2109: its connection, chosen in the dialog, says the
   * one it runs). Each works in the project folder (#1436): where an agent works is the card's or lane's, not the template's.
   */
  create: TemplateAgent[]
  /** The template's own names for them, by `create`'s order, expanded with the project's key: what a prefix goes in front of (#702). */
  templateNames: string[]
  /** Created names another project's agent has (#702): the load is refused until they are renamed. */
  taken: { name: string; project: string }[]
  /** Builders and their reviewers among `create`, by their indexes (#1436): kept as the agents' `pairedWith`. */
  pairs: { builder: number; reviewer: number }[]
  /** The preset it suggests (#1436), when the project's options didn't start from it: the dialog offers to switch. */
  suggestedPreset: SuggestedPreset | null
  /** G17's choice it suggests (#1436), offered once the Workflow section has it (#1443, #1445); never written by the load. */
  reviewerMode: ReviewerMode | null
  /**
   * The connections its agents can be given (HI-2109): those usable in the project's workspace, in the order (its account
   * on there, its CLI on and installed). Its agents' `provider` is only the CLI they suggest, which preselects one. None
   * usable: they are made on the CLI they suggest, and get a connection once an account is (as Add Agent's).
   */
  options: ConnectionOption[]
  /** Why it can't be loaded now (empty: it can). */
  blocked: string[]
  /** Its workflow (HI-1910) as it meets this project's: null when it has none. */
  workflow: TemplateLoadWorkflow | null
  /**
   * More agents than the project's Maximum agents (HI-2001): `now` is it, `needs` the template's agents. The user's load
   * goes ahead, and its dialog offers to raise the maximum; the Assistant's is refused (`blocked`). Null when they fit.
   */
  maxAgents: { now: number; needs: number } | null
}

/**
 * A template's workflow in the Load template dialog (HI-1910): the section for the project's version control, laid
 * over its options as they are now (`overlay`: the preview; the Workflow form lays the section over them again once it
 * reads them, to save there), or why none applies.
 */
export interface TemplateLoadWorkflow {
  /** The project's version control. */
  platform: PlatformId
  /** The template's usable sections, and those it had that can't be used (said). */
  sections: PlatformId[]
  dropped: PlatformId[]
  /** The section used (Hive's own: its preset as this project's form offers it), or null. */
  section: TemplateWorkflow | null
  overlay: TemplateWorkflowOverlay | null
  /** It has only a Git section and the project has no version control: its workflow needs Git first. */
  needsGit: boolean
  /** A None project, the template with both sections: None's is used, and it has a Git one too. */
  alsoGit: boolean
}

export interface AgentInfo extends AgentDef {
  live: LiveSessionState | null
  restartNeeded: boolean
  /** The session Resume opens for this agent while it isn't running (null: nothing to resume). */
  resume: ResumeTarget | null
  /** Its adopted worktree's slot, while it holds it under a carried lease (#1441): Release Slot… in its menu ends it. */
  carriedSlot?: string
  /** A slot its run that is over still holds as writer, its processes not known ended (#1506): Release Slot… frees it. */
  heldSlot?: string
  /** Where it works now (#1442): its running session's folder, else where its next conversation starts. */
  place: ShownPlace
  /**
   * Main's record of its start while it isn't running (HI-1977, HI-1976's): under way (a Start, its slot being prepared,
   * its session spawning, a restart's resume), or why its last one failed. Absent: neither, or it runs.
   */
  start?: AgentStart
  /** The count of start changes main had made when `start` was read (HI-1977): a change told with a higher one is newer. */
  startSeq?: number
  /** Its connection (HI-2106), while `connection` says its account to today's screens: its id and name. */
  connectionId?: string
  connectionName?: string
}

/**
 * An agent's start as the stall check reads it (HI-1977): under way, why it failed, or why it waits (HI-2304: its slot
 * held by what another run left running there; English, as Hive says it).
 */
export type AgentStart = { starting: true } | { failed: string } | { waiting: string }

export interface ResumeTarget {
  id: string
  name: string
  lastActiveAt: string
  createdAt?: string
  titleAtRename?: string | null
  /** Why it can't resume now in the slot it ran in (#1434): Resume All and startup leave an agent with one. */
  hold?: ResumeHold
  /** The retired home it resumes in (#1441), by its folder's name, while a new conversation starts elsewhere (#1552). */
  home?: string
}

export interface AddAgentOptions {
  name?: string
  /** Absent: the project folder (#1442: the window sends none; #1451 refuses a worktree). */
  location?: 'project' | 'new-worktree' | 'existing-worktree'
  /** new-worktree: branch to create (default hive/<workspace>/<project>/<name>, #703) and the branch to base it on (default the current one). */
  branch?: string
  base?: string
  /** existing-worktree: its folder. */
  worktreePath?: string
  /** Its CLI when no connection is named (HI-2122): that CLI's first usable connection here. */
  provider?: ProviderId
  role?: string
  /** Which side of the workflow it takes (#1430); absent, the guess from its note or name. */
  workflowRole?: WorkflowRole
  /** Only these of the project's MCP servers (#537); absent: all of them. */
  mcpServers?: string[]
  /** The connection it runs on (HI-2108: its id), on in the workspace; absent: the first usable here (decision A). */
  connection?: string
  /** Run with the write, under project.json's lock (HI-2328: the Assistant's guard): throwing adds nothing. Main only. */
  check?: () => void
  /**
   * #456: new-worktree, work in the project's unused worktree on that branch instead when it is merged into the base and
   * clean, brought up to the base; existing-worktree, bring the one chosen up to the base when it is merged and clean.
   * The Add Agent dialog and the Agent API ask for it; templates reuse their own way (#289). 1.0 (#1451): no agent gets a
   * worktree, so it does nothing.
   */
  reuseWorktree?: boolean
}

/**
 * The project's unused worktree on the branch a new worktree would get (#456), checked against the base: `reusable`
 * when merged into it (a squash merge counting) and clean, else `why` not (commits not merged, uncommitted files, or git
 * couldn't say).
 */
export interface WorktreeMatch {
  path: string
  branch: string
  base: string
  reusable: boolean
  why?: string
}

/**
 * What adding an agent did about a worktree it could reuse (#456): `reused` it (`upTo`: brought up to the base, at that
 * commit; without, it was there already or kept its work), or made a new one because it held work (`notReused`).
 */
export interface WorktreeReuse {
  branch: string
  reused: boolean
  base: string
  upTo?: string
  keptWork?: boolean
  /** In English (the Agent API's start reply says it); `notReusedText` is it as the window shows it (#845). */
  notReused?: string
  notReusedText?: Text
}

/** An agent just added, with what happened to a worktree it could reuse (#456). */
export type AddedAgent = AgentDef & { reuse?: WorktreeReuse }

export interface ProjectGitInfo {
  isRepo: boolean
  /** Git can't run (missing or too old, #346): what to say instead of "Needs a git repository". */
  gitProblem?: string
  current: string | null
  branches: string[]
  /** Worktrees of the project other than the project folder, and whether an agent uses them. */
  worktrees: { path: string; branch: string | null; used: boolean }[]
  /** Where new worktrees are created. */
  worktreesRoot: string
  /** The workspace part of new branches here (#703: `chooseSpace`, clear of branches from before); absent: not a repository. */
  branchSpace?: string
  /** The other workspace parts that are this project's (project.json's `branchSpaces`). */
  branchSpaces?: string[]
}

/** A worktree agent's branch compared with the branch it merges into. */
export interface AgentBranchStatus {
  branch: string
  base: string
  /** The project folder's current branch, which a merge goes into. */
  into: string | null
  /** Commits on the branch that aren't in `into`. */
  ahead: number
  /** Uncommitted changes in the worktree. */
  dirty: number
  /** What a merge would bring (unmerged commits and tracked uncommitted changes): files changed, lines added and removed. */
  diff?: { files: number; insertions: number; deletions: number }
}

/** Whether a worktree can be deleted without losing work (`worktreeCheck` in main); `reason` says why not ("2 commits not merged into main"). */
export interface WorktreeCheck {
  removable: boolean
  /** The branch it must be merged into: the repository's main branch (`primaryBranch`; null: it has none). */
  into: string | null
  reason?: string
  /** The branch's commit that was checked, and the main branch's commit it was checked against (it is merged into it when removable). */
  tip?: string
  intoTip?: string
  /** Once git could count them: commits not merged into `into`, and uncommitted files. */
  ahead?: number
  dirty?: number
}

/**
 * A git worktree of a project that no agent of it works in (#353): kept when its agent was removed, or made outside
 * Hive. `check` is the merged-and-clean check (#291's `worktreeCheck`; git failing counts as not removable).
 */
export interface UnusedWorktree {
  path: string
  /** Null: detached. */
  branch: string | null
  check: WorktreeCheck
  /** The commit its folder has checked out; with `check.dirty`, what Remove anyway was shown it would lose. */
  head?: string
  /** Its last commit: when (ISO) and its subject. */
  lastCommit?: { at: string; subject: string }
  /**
   * Who made it (#476): a Hive agent's (the agent whose session last ran there, when one did; else it is in Hive's
   * worktrees folder), or not Hive (an agent's own `git worktree add`, a CLI subagent's isolation, the user's).
   */
  origin?: UnusedWorktreeOrigin
  /**
   * What it is to Hive's pools (#1450): a free slot beyond the pool's size (`slot`), a slot left with changes and no
   * lease (`dirtySlot`), a carried folder whose lease ended (`carried`), or a retired home no conversation resumes in
   * any more (`home`), or a merge queue's folder its queue no longer needs, or one named as the queue names them that it
   * has no record of (`queue`, #1644; one its queue uses is never listed). Absent: a worktree no agent works in, as before. A slot's kinds are removed only through the
   * pool's guarded clean-up (never Remove anyway), and aren't given to an agent.
   */
  kind?: UnusedWorktreeKind
  /** Its slot's name (a slot's kinds). */
  slot?: string
}

export type UnusedWorktreeKind = 'slot' | 'dirtySlot' | 'carried' | 'home' | 'queue'

/**
 * A branch the Merge dialog can merge outside cards (#1450, OP-13): a card's line, a carried slot's branch, or any
 * other local branch; where it is checked out (its slot, when that is one), and the card whose line it is while that
 * card isn't Done (merged through its card, or here after a confirmation).
 */
export interface MergeBranch {
  name: string
  kind: 'line' | 'carried' | 'branch'
  folder?: string
  slot?: string
  card?: { number: number; key: string; title: string }
}

/** The Merge dialog's choices (#1450): the branches to merge, the targets, and the project folder's branch (the default target). */
export interface MergeBranchList {
  branches: MergeBranch[]
  targets: string[]
  checkedOut: string | null
}

export type UnusedWorktreeOrigin = { madeBy: 'hive'; agentName?: string } | { madeBy: 'other' }

/** A project's unused worktrees, or why git couldn't list them. */
export interface UnusedWorktrees {
  worktrees: UnusedWorktree[]
  gitProblem?: string
}

/** Remove anyway's confirmation (#353): what it loses, checked now; `token` is what the removal presents. */
export interface UnusedWorktreePreview {
  token: string
  path: string
  branch: string | null
  lost: string[]
}

/** What removing an unused worktree did: deleted it (and its branch), or kept it and why. */
export interface UnusedWorktreeRemoval {
  deleted: boolean
  /** Refused because what was shown is out of date (expired, used, or the worktree changed): a fresh preview can be confirmed (#377). */
  lookAgain?: boolean
  branchKept?: boolean
  reason?: string
}

/** What removing an agent did with its worktree: deleted it (and its branch), or kept it and why (Remove All, #291). */
export interface RemovedAgent {
  /** `branchKept`: the worktree was deleted but its branch kept (it changed meanwhile). */
  worktree?: { path: string; branch: string; deleted: boolean; branchKept?: boolean; reason?: string }
}

export interface MergeResult {
  ok: boolean
  /** Files that would conflict; nothing was changed. */
  conflicts?: string[]
  error?: string
  /** Refused: the worktree has this many uncommitted files (#1347: only committed work is merged). */
  uncommitted?: number
  /** The commit the target is at after the merge (the merge or squash commit; its tip when a squash changed nothing). */
  mergeCommit?: string
  /** The worktree and branch were removed afterwards. */
  cleanedUp?: boolean
  /** An unused worktree's merge asked to remove it afterwards, but it was kept: why (#400). */
  cleanupKept?: string
  /** After a squash merge, the agent's branch was moved to the merged branch; or why it wasn't. */
  branchMoved?: boolean
  moveError?: string
}

export interface SessionRecord {
  /** The connection its latest run launched on (HI-1755), id and name as then; absent: none (a provider without connections). */
  connection?: { id: string; name: string }
  /**
   * A run of it was on a server connection (HI-1772), kept once set: its CLI's own cost reports price the server's model
   * as a Claude model, so they are never counted (`withoutCostReports`): Hive's estimate by the real model id only.
   */
  serverRan?: true
  /** A run of it was on a server on this PC; one ran anywhere else (HI-1772): each kept once set. Free: the first alone. */
  serverLocal?: true
  notLocal?: true
  id: string
  /** The provider that ran it ("claude-code", "codex"). The field name predates providers. */
  agent: ProviderId
  name: string
  createdAt: string
  lastActiveAt: string
  archived: boolean
  /** The agent that ran it (absent in records from 0.1's Agent 1, and in adopted sessions). */
  agentId?: string
  /** That agent's name then, so a session still says whose it was after the agent is removed (absent in older records). */
  agentName?: string
  /**
   * Folder it ran in: always recorded since #1434 (the project folder too); absent in older records, which ran in the project
   * folder. Claude Code files transcripts by folder.
   */
  cwd?: string
  branch?: string
  /** The slot lease it is bound to (#1434, agentFolders.ts): set when it started in a slot. Read only: its own column. */
  lease?: string
  /** Where the provider keeps the transcript, when it can't be found from the folder (Codex). */
  transcriptPath?: string
  /** The session whose work was handed over to this one ("Hand Over to…"). */
  handedOverFrom?: string
  /**
   * Board cards its agent had in Doing while it ran, in order, with the title each had then; `review`: one it reviewed
   * (TaskCard.review) rather than worked on.
   */
  cards?: { number: number; title: string; review?: true }[]
  /**
   * The CLI's own name for the session (SessionUsage.customTitle) when it was last renamed in Hive, null when it had
   * none. Once the CLI's name changes from this (a /rename since), it is the newer rename and wins (sessionLabel).
   */
  titleAtRename?: string | null
  /**
   * What it used, saved when Clean Up removed Hive's backup of it (the CLI still had the transcript): totals keep
   * counting it once the CLI's copy is gone too.
   */
  keptUsage?: SessionUsage
  /**
   * Safeguard stops Hive saw only on the CLI's screen (its prompt about one, #606), so Performance counts them (usage()
   * adds the unmatched ones to SessionUsage.safeguards): the transcript may never record them.
   */
  screenStops?: ScreenStop[]
  /** A session the CLI started for another one (e.g. a Codex guardian review), kept when it was adopted. */
  sub?: SubSession
  /**
   * A Hive Assistant conversation's mode (its id) it was last given: the one it started in, or the last one Hive
   * told it. A resume in another mode (or with none recorded) tells it the mode once (#334).
   */
  mode?: string
  /**
   * Hive gave this conversation instructions of its own at a launch (#1433: the Assistant's role and mode, the Workspace
   * notes note). Never cleared: a resume of it renders its system prompt fresh, whichever agent resumes it and whatever
   * that launch gives, so instructions switched off or emptied since leave it (Claude Code keeps a conversation's first).
   */
  promptAdded?: true
}

/**
 * A session a CLI started for another one rather than a conversation of its own: Codex's guardian reviews (it starts
 * one to judge each action in Approve for me) and other sub-agent sessions. Read from the transcript's first line by
 * the provider's adapter. `parentId`: the session that started it (null when the CLI doesn't say); `kind`: what it is,
 * for labels ("guardian review", "sub-agent").
 */
export interface SubSession {
  parentId: string | null
  kind: string
}

/** What a background task is (#1584): a command left running, a Monitor, a subagent run in the background, a workflow. */
export type BackgroundTaskType = 'command' | 'monitor' | 'subagent' | 'workflow'

/** What a bulk action on the Sessions tab does to each session (session:bulk). */
export type SessionBulkAction = 'archive' | 'unarchive' | 'delete'

/**
 * Why a bulk action left a session alone: `live`: running (in any window); `in-use`: its files are in use (its CLI
 * still writing its transcript, or another program holding the CLI's transcript or Hive's copy open); `reading`: Hive
 * is reading its transcript (an export, a search); `open`: its transcript is open in a Hive window (the window asking
 * closes its own view first);
 * `external`: started outside Hive, so Hive has nothing of it to archive; `failed`: anything else (`message` says what).
 */
export type SessionSkipReason = 'live' | 'in-use' | 'reading' | 'open' | 'external' | 'failed'

export interface SessionBulkResult {
  done: string[]
  skipped: { id: string; reason: SessionSkipReason; message?: string }[]
}

/** A bulk action under way on a host's sessions (#1659): how many of them it has been through, done or skipped. */
export interface SessionBulkProgress {
  /** Which run: several can run at once on a host (a branch's action started while Clean Up runs). */
  id: number
  action: SessionBulkAction
  done: number
  total: number
}

/** background: the agent's turn has ended, but it has background tasks that will start it again when they end. */
/**
 * `watching`: its turn has ended and it waits on cards (a wake-on-change watch, #128): Hive types one line to wake it
 * when a watched card changes. It runs nothing meanwhile, but it isn't idle: nothing else is given to it.
 */
/**
 * `signin`: its CLI refused the turn because its sign-in has expired (or was refused): it needs the user to sign in
 * again, and stays idle until then (#309). Every agent of that CLI shares the sign-in.
 */
export type SessionStatus = 'stopped' | 'starting' | 'ready' | 'working' | 'waiting' | 'background' | 'watching' | 'finished' | 'error' | 'signin'

/** Facts of an agent's runtime (#648), each set at its source (LiveSessionState.runtime). */
export interface RuntimeFacts {
  /** The CLI's process: starting (not at its prompt yet), running, stopped by a refused sign-in, or stopped. */
  lifecycle: 'starting' | 'running' | 'signin' | 'stopped'
  /** Work that isn't a turn's own: compacting its conversation (by itself, mid-turn or idle, or Hive's Compact). */
  maintenance: 'compacting' | null
  /** A person is asked: the agent waits for them, or a question waits beside its work. */
  attention: 'waiting' | 'question' | null
  /** Its input: held by a line Hive is typing, has just typed or is confirming, or one it didn't take; else free. */
  composer: 'held' | 'free'
}

/** An agent's wake-on-change watch, as its state shows it: the cards and condition, since when, and its overall limit. */
export interface TaskWatchInfo {
  cards: number[]
  changes: ('column' | 'comment' | 'verdict' | 'agent' | 'blocked' | 'request' | 'decision' | 'step')[]
  column?: TaskColumn
  /** An agent watch's agents, by name (#416: its cards are none). */
  agents?: string[]
  /** A lane watch's lanes, by id, or ["all"] (#531; its cards are those beside the lanes, #726). */
  lanes?: string[]
  /** Accounts' usage watched beside its cards or lanes, or alone (HI-2195; HI-2285: such a watch waits on more than its cards). */
  usage?: true
  /** "Waiting for #12 → Review", "Waiting for B6 to finish". */
  label: string
  since: string
  /** When Hive wakes it to say nothing changed (ISO). */
  limitAt: string
}

/** A delivery not received yet, as an agent's pane shows it (#647, shared/deliveries.ts): its id, who from, the start of what it says, when. */
export interface InboxBrief {
  id: string
  from: string
  text: string
  at: string
  state: 'queued' | 'offered' | 'uncertain' | 'received' | 'acked' | 'cancelled' | 'refused' | 'expired' | 'stale'
  card?: number
}

/** An agent's deliveries as its pane shows them: those not received yet, and how many aren't acked in time (overdue). */
export interface InboxSummary {
  unread: InboxBrief[]
  overdue: number
}

/** LiveSessionState.hooksMissing (#1336): since when, what showed it, and why when Hive can tell. */
export interface HooksMissing {
  since: string
  /** start: no hook since its start; prompt: none after a prompt its CLI took; transcript: none for a turn its transcript shows it took (#1371). */
  after: 'start' | 'prompt' | 'transcript'
  /** transcript: the turn that showed it, by the transcript's id for it (Claude Code's promptId, Codex's turn_id, Copilot's interactionId). */
  turn?: string
  why?: 'refused' | 'off' | 'newer'
  /** off: the settings that turn them off, as the CLI's adapter names them. */
  offIn?: string
}

/**
 * A CLI waiting to retry its model request (HI-1972), as its own records say (Codex's log): when it was told (`at`, ISO),
 * the turn's first such wait (`since`), when it tries again (`retryAt`; null when the CLI doesn't say), which try it is
 * of how many (`max` null when it doesn't say), and the HTTP status that refused it (429: rate-limited), when it names
 * one. `network`: the provider couldn't be reached at all (for CLIs that say so; Codex's records don't).
 */
export interface RetryWait {
  at: string
  since: string
  retryAt: string | null
  attempt: number
  max: number | null
  status: number | null
  network?: true
}

/**
 * The retry waits this launch has finished (HI-1996): how many, their time together (ms), and the latest one (from its
 * first try, `since`, to when it ended, as RetryWait says), for telling a throttled round from a slow one afterwards.
 */
export interface RetryWaited {
  waits: number
  ms: number
  latest: { since: string; ended: string; tries: number; status: number | null; network?: true }
}

export interface LiveSessionState {
  provider: ProviderId
  /** This launch, until the process exits; hooks name it so they reach the right agent. */
  runId: string
  projectPath: string
  /** Which of the project's agents this is. */
  agentId: string
  agentName?: string
  /** Folder the session runs in: the project folder, a slot (#1434), or the agent's 0.9 worktree. */
  cwd: string
  /** The slot it runs in (#1434): its name, while it runs under one of its leases. */
  slot?: string
  /** The provider's session id. Empty until the provider reports it, for providers that choose it themselves. */
  sessionId: string
  /** The mode the session is actually in: from launch, Hive's live switches, Shift+Tab in the terminal (its footer) and hooks. */
  permissionMode?: PermissionMode
  /**
   * The mode the CLI itself last showed (its footer, a hook, its transcript); absent until it has shown one. The
   * mode Hive shows (permissionMode) starts as the one asked for at launch, so this says it was seen (#234).
   */
  modeObserved?: PermissionMode
  /** The session's name in Hive (renamable in the Sessions tab and the agent's footer). */
  sessionName?: string
  /** See SessionRecord.titleAtRename. */
  titleAtRename?: string | null
  /**
   * When the conversation began: its record's createdAt (a resumed one began before this launch; a new one's record is
   * given this launch's startedAt), which names it until it has a name, as in the Sessions tab (#630).
   */
  sessionCreatedAt?: string
  /** What the agent is doing, in one word: a projection of its runtime's fields (agentRuntime) and Hive's policy (watching). */
  status: SessionStatus
  /** When the status last changed (ISO): how long an agent has been waiting or finished. */
  statusSince?: string
  /**
   * In English, or the CLI's own words (#845): agents read it, and Hive's code compares it. `statusText` is Hive's own
   * text as the window shows it (none when the message is the CLI's).
   */
  statusMessage?: string
  statusText?: Text
  /**
   * Its CLI's latest turn as Hive's turn ledger knows it (#648): running, over, or unknown, when a running turn has been
   * silent for a while (`silentSince`) with no sign of its end. Unknown isn't idle: nothing is typed into it, and the user
   * can Mark idle. `id`: the CLI's own turn id, when it names turns.
   */
  turn?: { state: 'running' | 'over' | 'unknown'; id?: string; silentSince?: string }
  /**
   * Its CLI is waiting to retry its model request in the running turn (HI-1972: Codex's log after a 429), as Hive last
   * read it: shown as its status while `retryAt` is ahead (retryWaitCurrent), cleared by its next hook or the turn's end.
   * With no `retryAt` (HI-1973: Copilot doesn't say), it stands until one of those.
   */
  retryWait?: RetryWait
  /** The retry waits this launch has finished (HI-1996); absent until one has. retryWait is the one under way. */
  retryWaited?: RetryWaited
  /**
   * Facts of its runtime besides its turn and background tasks, each set where Hive learns it, never read back from the
   * status word (#648; shared/runtime.ts agentRuntime() gathers them all, and the labels are projected from them).
   */
  runtime?: RuntimeFacts
  /** Its place at the merge slot (#350): waiting for it ("Waiting for the merge slot (B4 is merging #305)") or holding it. */
  mergeSlot?: string
  /** `mergeSlot` as the window shows it (#845); `mergeSlot` is its English. */
  mergeSlotText?: Text
  /** An action under the CLI's automatic review (Codex's Approve for me), as asked ("Codex asks to run …"): shown beside the status, never as it. */
  review?: string
  /**
   * A question the agent asked without stopping for it (Codex's request_user_input_async): it carries on working
   * and takes the answer when it comes. It needs you (the attention inbox) until answered.
   */
  question?: { text: string; since: string }
  /**
   * Its last turn ended on an error (#1632: a failed stop, such as Claude Code's StopFailure on an API connection
   * error), with what the CLI said and when: it needs you until its next turn starts. Its status stays as the turn's
   * end made it (finished), so Hive still prompts and wakes it as an idle agent.
   */
  /** `message`: the CLI's words, '' when it said none (the window says the turn ended on an error). */
  failedTurn?: { message: string; since: string }
  pid?: number
  startedAt: string
  /** Effective settings the session launched with — used to detect "restart to apply". */
  launchSignature: string
  /**
   * The connection this run launched on (HI-1755), kept for the run whatever is chosen meanwhile; absent: a provider
   * without connections (or a test copy on its CLI test home). `id` and `name` are its account's (HI-2106: its home,
   * login and usage); `connection`, the named connection on it whose values it launched with (HI-2397), is what the
   * window names. `note`: why it isn't the one chosen (its choice was off).
   */
  launchedConnection?: {
    id: string
    name: string
    /** The connection (`c-…`) it launched with, as named then (HI-2397); absent from a launch before it: its account's name stands in. */
    connection?: { id: string; name: string }
    note?: 'offFallback' | 'missing' | 'unknownLogin' | 'loginChanged'
    /** Who it launched as (HI-1756: its plan usage is that login's), as plan usage keeps a login (a hash); absent: unknown. */
    login?: string
    /** A server connection's (HI-1772): its models as launched, so the footer shows the real model and what it stands in for, and whether it runs only on this PC (its server is, and none of its models runs elsewhere: HI-1773). */
    server?: { models: ServerModel[]; local?: boolean }
  }
  /**
   * The model and effort this launch gave its CLI (HI-1996), after the agent's, project's, provider's and connection's
   * choices; null: none given, so its CLI's own default. What the CLI reports once it runs is `modelId` and `effort`.
   */
  launchedWith?: { model: string | null; effort: string | null; /** The model was the agent's own choice, not a default. */ own?: true }
  /** A switch to the connection it would launch on now waits for its turn to be over (HI-1755). */
  switchPending?: boolean
  /** Its conversation ran only on servers on this PC (HI-1772): free, its cost a known $0, shown as "free (local)". */
  costFree?: boolean
  /**
   * What it was given at launch (GET /v1/projects/{name}): Hive's guidance revision, the content hash of each Hive skill's
   * copy it reads, and why a skill isn't as asked for (a folder of the user's has its name, an old copy kept while in use),
   * and the dialect chain it speaks (HI-2443).
   */
  /**
   * `dialect`: its chain where a dialect is set (a text overridden, or a file picked); on the Default, only
   * `{ modelUnknown: true }` where Hive couldn't name its model (decision Q4); absent otherwise.
   */
  launched?: { guidance: string; skills: Record<string, string>; problems?: Record<string, string>; dialect?: LaunchDialect | { modelUnknown: true } }
  /** Finished or waiting since its pane was last on screen in a focused window (the renderer marks it seen). */
  unseen: boolean
  /** Its wake-on-change watch, while it has one (status `watching` while its turn has ended). */
  watch?: TaskWatchInfo
  /**
   * Cards still in play (Doing or Review) that this agent was looping on when its turn ended with no card watch (#376):
   * nothing will wake it when they change, so they show as stalled. Cleared once it works or watches again.
   */
  notWatching?: number[]
  /**
   * A line Hive typed (a wake) that its CLI hasn't taken, even after Enter again (#430): the CLI wasn't reading its input.
   * Shown in its pane until the CLI takes it or the user types there; nothing more is typed into it meanwhile.
   */
  untakenLine?: { since: string; text: string }
  /**
   * Its input takes no keys (HI-2191): keys Hive typed went unanswered while its input box read empty, so something on its
   * screen takes them. Nothing is typed into it until it is seen to take keys again; its pane offers Try again (`since`
   * names this block).
   */
  inputBlocked?: { since: string }
  /**
   * Its CLI's hooks aren't reaching Hive (#1336), this launch: none came within a while of its start (a CLI that sends one
   * then), or none after a prompt its CLI went to work on (its screen or its records show it). Hive's status for it may be
   * wrong, so it shows as unknown and nothing is typed into it; any hook clears it. `why` when Hive can tell: Hive
   * refused its hooks (their token), its settings turn hooks off (`offIn`: where), or it is newer than Hive was tested with.
   */
  hooksMissing?: HooksMissing
  /**
   * Its deliveries (#647: messages left for it, main/deliveries.ts) not received yet, and how many are overdue; shown in
   * its pane ("✉ 2 unread"), where the user can cancel those waiting. Absent when there are none.
   */
  inbox?: InboxSummary
  /**
   * Its last turn stopped because its CLI's sign-in was refused, and it hasn't carried on since (#309): the CLI's
   * message and when. Status `signin` until the CLI is signed in again, then `ready`; Resume (n) carries it on.
   */
  signIn?: { message: string; since: string; /** Hive's own message as the window shows it (#845), when `message` isn't the CLI's. */ messageText?: Text }
  /**
   * Its CLI's safety classifier stopped a response this launch, or its model changed after one (#606): when, the model,
   * the names of its last tool calls before it (never their input nor what was stopped), and whether it waits on the
   * CLI's prompt about it, is idle after it, or runs on another model since. Absent when none.
   */
  safeguard?: SafeguardNote
  /** Reported by the provider once the session has started. */
  effort?: string
  modelName?: string
  /** The model's id as the session reports it (Claude Code's status line, Codex's rollout): what the footer shows (#248). */
  modelId?: string
  /** How its CLI was set to compact by itself, as read at launch (providers that say: Claude Code, #242). */
  autoCompact?: AutoCompactSetting
  /** API-equivalent cost of the session so far, in USD. */
  costUsd?: number
  /** The model's context window in tokens, as the provider reports it for the running session (Claude Code's status line). */
  contextWindow?: number
  /** costUsd was estimated by Hive from token counts, not reported by the provider. */
  costEstimated?: boolean
  /** A live permission-mode change Hive has asked for and is waiting to see confirmed. */
  modeSwitching?: PermissionMode
  /** Codex's Plan mode, which is separate from its permission preset. */
  planMode?: boolean
  /** Files this agent has claimed by editing them (relative to its folder), while locks are on. */
  lockedFiles?: string[]
  /** The worktree's setup command is running before the agent starts. */
  settingUp?: boolean
  /** Background tasks the agent started that are still running (commands, Monitors, Codex's background terminals). */
  backgroundTasks?: number
  /** When its background tasks last ended (ISO: the count went to none), so a review waiting on them starts its clock then (HI-1993). */
  backgroundEndedAt?: string
  /** The running conversation's transcript size in bytes, once the provider has written one. */
  transcriptBytes?: number
  /** The start of its latest reply, as its last turn's end reported it (shared/tiles.ts replyStart): its tile's last lines (#976). */
  replyStart?: string
}

export interface ProjectInfo {
  name: string
  path: string
  active: boolean
  isGitRepo: boolean
  branch: string | null
  config: ProjectConfig
  /** The first running agent's session. */
  live: LiveSessionState | null
  /** True when the project's effective settings differ from the live session's launch settings. */
  restartNeeded: boolean
  /** Every agent, in the order added, with its running session. */
  agents: AgentInfo[]
  /** Its slots and retired homes, named (#1442): how the window names a session's or a card's folder. */
  folders?: NamedFolder[]
  /** MCP servers defined in the project's own config (.mcp.json, .codex/config.toml) that are not deployed to the workspace. */
  unmanagedMcp: string[]
  /** The folder holds what Remove from Hive packed (handovers, board cards), which Hive offers to restore. */
  removedData?: RemovedData | null
  /** Whether its .hive is kept out of version control (#345); absent for the Assistant's home. */
  hiveVcs?: HiveVcs
  /** Its version control platform, capabilities and detection (SPEC §16.3); absent for the Assistant's home. */
  platform?: ProjectPlatform
}

/**
 * Whether a project's .hive (this machine's sessions, transcript backups and launch settings) is kept out of version
 * control (#345). `excluded`: in the info/exclude of the git repository holding it (Hive adds it there itself);
 * `not-excluded`: a git repository Hive couldn't add it to; `other-vcs`: another system (`vcs` names it), which Hive
 * doesn't configure; `none`: no version control holds the folder. `sync` names a sync service whose folder holds it
 * (OneDrive, Dropbox), which copies .hive whatever version control does.
 */
export interface HiveVcs {
  state: 'excluded' | 'not-excluded' | 'other-vcs' | 'none'
  vcs?: string
  sync?: string
  /** Files under .hive git tracks (#364): committed before it was excluded, so git goes on committing their changes. */
  tracked?: number
}

export interface WorkspaceInfo {
  path: string
  name: string
  config: WorkspaceConfig
  projects: ProjectInfo[]
  /**
   * The Hive Assistant, the workspace's overseer: a session host like a project (its home is .hive/assistant,
   * never listed as a project) with one agent, working in the workspace folder.
   */
  assistant: ProjectInfo | null
  /** Moved since Hive last opened it, with something to repair (#146): the banner offers Repair…. */
  moved?: WorkspaceMoved | null
}

/** What moved (#146): the workspace (from its old folder), or only some of its projects. */
/** A moved workspace's records by folder still to follow it (HI-2007, config.json's `profileMoves`). */
export interface ProfileMove {
  from: string
  to: string
  failed?: string
}

export interface WorkspaceMoved {
  /** The workspace's old folder; null when only projects moved (renamed or moved in from elsewhere). */
  from: string | null
  /**
   * Old folders whose records by folder (the close command's runs) the last try couldn't all bring here (HI-2007), and
   * why: Repair tries again. A run still going there isn't one: it follows once it has ended. Absent when there are none.
   */
  profile?: { from: string; failed: string }[]
  /** The projects that moved, by name. */
  projects: string[]
  /** Projects that didn't move but have a worktree's sessions or data still to follow it to a new folder (#146). */
  pending: string[]
  /**
   * Cards left under a project's old name (#508): saved before projects had ids, by a project renamed or moved since.
   * Repair gives them to the project they belong to now. Absent when there are none.
   */
  cards?: MoveCards[]
  /** How many agents' branches are still named after an old place (#1305), for Repair to rename; absent: none. */
  branches?: number
}

/**
 * Cards of a project that isn't in the workspace by that name (#508), and the project they belong to now: the one
 * Repair moves from that name, else the one whose agents worked on them (their agents and sessions are only its).
 */
export interface MoveCards {
  /** The name the cards were saved with, and the project's folder name now. */
  from: string
  to: string
  cards: number[]
  /** How many of its lanes and agents' card watches were saved under that name too (absent: none). */
  lanes?: number
  watches?: number
}

/** What Repair… would do for a moved workspace or project (#146). */
export interface MovePlan extends WorkspaceMoved {
  to: string
  /** Agents running in the workspace ("project · agent"): Repair waits until they are stopped. */
  running: string[]
  hosts: MoveHostPlan[]
  /** The old folder is in File → Open Recent, to be replaced by the new one. */
  recent: boolean
  /** Projects marked Working on at the old folder and not yet at the new one (kept per workspace folder). */
  working: string[]
}

/** One moved project (or the Assistant's home) and what Repair does for it. */
export interface MoveHostPlan {
  /** Its folder now (where its sessions.json is), and the folder its sessions ran in, then and now: its own, except the Assistant's, which works in the workspace folder. */
  path: string
  name: string
  from: string
  folder: string
  worktrees: MoveWorktree[]
  /** Session records whose folder (cwd) moves with it. */
  sessions: number
  /** What a CLI keeps by folder path (Claude Code's transcripts and memory), to copy to the new path's name. */
  folders: PathDataCopy[]
  /** Agents' branches named after where the workspace or project was (#1305): renamed, their records with them. */
  branches?: MoveBranch[]
}

/**
 * An agent's branch in Hive's form, hive/<workspace>/<project>/<agent>, whose workspace or project part is an old one
 * (#1305, Darren's decision on #1303: renamed, never offered): `to` is its name here. `remote`: the remote it tracks,
 * which keeps the old name (pushing under the new one is the user's step). `kept`: why it isn't renamed now
 * (`exists`: a branch of that name is already there). `pending`: a rename a Repair before began and couldn't finish
 * (project.json's `pendingBranchRenames`), finished now from where it stopped.
 */
export interface MoveBranch {
  agentId: string
  agentName: string
  from: string
  to: string
  remote?: string
  kept?: 'exists'
  pending?: boolean
}

/**
 * An agent's worktree whose links need repairing. moved: found at a new place; stayed: still where it was (outside the
 * moved folder), its links to the repository repaired; located: the folder the user picked; missing: not found
 * (Recreate, Locate… or Remove the link); recreate: to be made again on its branch, or new from its base when the
 * branch is gone (`to`: where, if that place can be used); unlink: the agent's worktree link is to be removed;
 * original: the project is still at its old folder too (a copy), which keeps the worktree.
 */
/**
 * A folder Hive keeps for a project besides an agent's 0.9 worktree (#1447), as Repair and project removal name it: a
 * slot (its lease's agent and the cards it held, by key; `carried`: an agent's adopted worktree), a review or check copy,
 * or a reviewer's retired home (its agent).
 */
export type ProjectFolderOf =
  | { kind: 'slot'; name: string; agent: string | null; cards: string[]; carried: boolean }
  | { kind: 'copy'; name: string }
  | { kind: 'home'; agent: string | null }

/**
 * A worktree Repair looks at: an agent's 0.9 worktree, or (`of`, #1447) one of the project's slots, copies or retired
 * homes, keyed then as `slot:<name>`, `copy:<name>` or `home:<n>` in `agentId` (`agentName`: its name for the log).
 * `later`: a free slot or copy not found, made again where it belongs at its next lease.
 */
export interface MoveWorktree {
  agentId: string
  agentName: string
  from: string
  to: string | null
  how: 'moved' | 'stayed' | 'located' | 'missing' | 'recreate' | 'unlink' | 'original' | 'later'
  of?: ProjectFolderOf
  /** missing and recreate: its branch, and whether the branch survives (Recreate) or not (Create a new worktree). */
  branch?: string
  branchExists?: boolean
}

/** An agent's worktree whose folder is missing (#146): Recreate makes it again on its branch, or new from its base when the branch is gone. */
export interface WorktreeGone {
  agentName: string
  path: string
  branch: string
  base: string
  branchExists: boolean
  /** A gone slot the agent holds (#1447): its name; Recreate makes it again on its line (`branch`), Release frees it. */
  slot?: string
}

/** A CLI's per-path folder copied for a moved folder: files to copy, and files already there with other content (kept). */
/**
 * Whose a moved folder is (#796): kept as data, so Repair's report says it in the language shown when it is shown,
 * whatever language the move was recorded in. `of` beside it keeps the English label older records and readers have.
 */
export type MoveOwner = { kind: 'project' } | { kind: 'assistant' } | { kind: 'worktree'; agent: string }

export interface PathDataCopy {
  provider: ProviderId
  /** Whose folder it is, as the dialog says it: "the project", "Builder's worktree" (set by the move, not the CLI). */
  of?: string
  /** The same as data (#796). */
  owner?: MoveOwner
  from: string
  to: string
  copy: number
  kept: string[]
  failed?: string[]
}

/** The user's choices for Repair…: worktree folders picked with Locate…, and links to remove, by `${projectPath}#${agentId}`. */
export interface MoveOptions {
  locate?: Record<string, string>
  unlink?: string[]
  /** Missing worktrees to make again (on their branch, or new from their base). */
  recreate?: string[]
  /**
   * Move Hive's Defender exclusions from the moved workspace's old folders to its new ones (#1302): one administrator
   * prompt, at the end. Only when true (the dialog's box): a Repair asked for otherwise never prompts.
   */
  defender?: boolean
}

/** What a row of Repair's report is about (#1313): the dialog words it as the plan's What column does. */
export type MoveReportWhat =
  | { kind: 'worktree' | 'branch'; agent: string }
  | { kind: 'folder'; of: ProjectFolderOf }
  | { kind: 'sessions' }
  | { kind: 'copy'; provider: ProviderId }
  | { kind: 'board'; from: string }
  | { kind: 'saved' | 'recent' | 'working' | 'defender' | 'closeRuns' }

/** A step of Repair's report as a table row (#1313): what, where it was and is, and how it went in a few words. */
export interface MoveReportRow {
  /** The project (or the Assistant) it is about, by name; none: the workspace's (Open Recent, Working on, the board). */
  host?: string
  what: MoveReportWhat
  /** Where it was and is: folders (shortened to the part that differs) unless `names` (branches). */
  was?: string
  now?: string
  names?: boolean
  outcome: 'done' | 'skipped' | 'failed'
  /** How it went, short (the Result column): "linked again", "couldn't be repaired: …". */
  result: string
  /** The step's full sentence, as in done, skipped or failed: the row's tooltip and what a screen reader reads. */
  line: string
}

/** What Repair did: each line a step, for the dialog and the log; `rows`, the same steps for the dialog's table. */
export interface MoveReport {
  done: string[]
  skipped: string[]
  failed: string[]
  rows: MoveReportRow[]
  /** Nothing is left to repair: the banner goes. */
  complete: boolean
}

export type SkillLevel = 'hive' | 'machine' | 'plugin' | 'local'

export interface SkillInfo {
  /** For machine (user), plugin and local skills: the provider that loads them. */
  provider?: ProviderId
  name: string
  description: string
  level: SkillLevel
  /** The skill's folder. For a bundled skill missing from the workspace: its folder in Hive's installation. */
  path: string
  /** Plugin name for plugin skills. */
  plugin?: string
  /**
   * Hive skills that ship with Hive: the workspace copy matches this version of Hive's ('same'), was edited
   * ('changed'), or isn't in the workspace ('missing'). Untouched copies of older versions are updated by Hive.
   */
  bundled?: 'same' | 'changed' | 'missing'
  /** A changed copy of an older version of Hive's: reverting it also brings in this version's. */
  updateAvailable?: true
  /** Hive skills: who gets it (SKILL.md's metadata.audience): project agents (the default), the Assistant, or both. */
  audience?: SkillAudience
  /** Hive skills: its header is broken or its audience unknown, so nobody gets it until it's fixed (why, in English). */
  problem?: string
  /** `problem` as the window shows it (#845). */
  problemText?: Text
}

/** Who a Hive skill is for. */
export type SkillAudience = 'agents' | 'assistant' | 'all'

/** Hive skills switched off for agents (#1431): their names (a hand-edited file may hold anything: skillDelivered reads it). */
export interface SkillDeliveryChoice {
  off: string[]
}

/** Where a new skill goes: the workspace's Hive skills, or a provider's local skills folder in a project. */
export type SkillTarget = { kind: 'hive' } | { kind: 'local'; projectPath: string; provider: ProviderId }

export interface McpServerDef {
  command?: string
  args?: string[]
  env?: Record<string, string>
  type?: string
  url?: string
  headers?: Record<string, string>
  description?: string
  /** Words to find it by in the MCP view and the Add server picker (HI-2059): Hive's, never given to the CLIs. */
  tags?: string[]
  /** The MCP catalogue it was installed from (HI-545): Hive's, never given to the CLIs. */
  catalog?: McpCatalogOrigin
  [key: string]: unknown
}

export interface McpServerInfo {
  name: string
  path: string
  def: McpServerDef | null
  /** In English, or the reason a read failed as Node gave it; `errorText` is Hive's own as the window shows it (#845). */
  error?: string
  errorText?: Text
  /** The projects it is added to (HI-2059), by path, hidden ones too: it runs in them. The window's only, never an agent's. */
  projects: string[]
  /** Added for the Hive Assistant (HI-1472, HI-2059): it runs for it. */
  assistant: boolean
  secretWarnings: string[]
  /** What it runs, shown before it is enabled (#550): the command or URL, folder, environment and header names. */
  runs: string[]
  /** Which copy of its definition this is (a replace or an edit changes it): an Add says which it showed. */
  revision?: string
}

/** What Add to… changed (HI-2059), by place (a project's path, or `assistant`), and where it failed, with why. */
export interface McpPlacesResult {
  added: string[]
  removed: string[]
  failed: { place: string; error: string }[]
}

/** The server an Add showed the user (#550): refused if its definition has been replaced or edited since. */
export interface McpShown {
  def: McpServerDef | null
  revision?: string
}

/** A server read from a .json definition or a .zip server folder, before it is added (#550). */
export interface McpFileServer {
  /** A name for it: the definition's file name, else the zip's folder or file name. */
  name: string
  def: McpServerDef
  runs: string[]
  secretWarnings: string[]
  /** The files a .zip unpacks to .hive/mcp/<name>/ (none for a .json). */
  files: number
  /** A server of this name exists already. */
  exists: boolean
}

/** A server's requirements in an MCP catalogue (HI-545, catalog.json v1's `requires`). */
export interface McpCatalogRequires {
  os: string[]
  windows?: { editions?: string[]; minBuild?: number; features?: string[] }
  node?: string
  docker?: boolean
  apps?: string[]
}

/** A server an MCP catalogue offers (HI-545, catalog.json v1), as Hive checked it. */
export interface McpCatalogServer {
  name: string
  version: string
  description: string
  tags: string[]
  requires: McpCatalogRequires
  homepage?: string
  zip: { url: string; sha256: string; size: number }
}

/** One requirement of a catalogue server checked on this PC: met, not met, or not something Hive can check. */
export interface McpCatalogCheck {
  kind: 'os' | 'edition' | 'build' | 'feature' | 'node' | 'docker' | 'app'
  label: string
  state: 'ok' | 'no' | 'unknown'
}

/** The catalogue view's filter (HI-545). */
export type McpCatalogFilter = 'all' | 'notInstalled' | 'installed' | 'updates' | 'meets'

/** A catalogue server in the MCP view: whether it is installed (its version, or `other` for a server of the name not from this catalogue), has an update, and meets this PC. */
export interface McpCatalogRow extends McpCatalogServer {
  source: string
  installed: string | null
  update: boolean
  checks: McpCatalogCheck[]
}

/** A catalogue source's page in the MCP view (HI-545): its rows from `offset`, out of `total` matching. */
export interface McpCatalogSourcePage {
  url: string
  name: string
  ours: boolean
  /** Its servers aren't checked by Hive, and the one-time note about it hasn't been shown yet. */
  noteDue: boolean
  /** Why it can't be used (not read, not a catalogue Hive reads), in the window's language. */
  error?: string
  skipped: number
  total: number
  offset: number
  rows: McpCatalogRow[]
}

/** Hive's MCP catalogue sources (HI-545): ours first (on unless turned off), then the user's, each on or off. */
export interface McpCatalogSettings {
  oursOn: boolean
  sources: { url: string; on: boolean; noted?: boolean }[]
}

/** A catalogue server downloaded and checked, held for the user's Install or Update (HI-545). */
export interface McpCatalogPrepared {
  id: string
  source: string
  server: McpCatalogServer
  /** What it adds: its definition (moved to its name's folder), what it runs, what to know, its files. */
  def: McpServerDef
  runs: string[]
  secretWarnings: string[]
  files: number
  /** Installed from this catalogue entry already, under `name` (an update's: its version, where it is added). */
  existing: { name: string; version: string; def: McpServerDef | null; revision?: string; runs: string[]; projects: string[]; assistant: boolean } | null
  /** A server of the entry's own name is in the workspace (from it or not): Install asks to replace it or choose another name. */
  nameTaken: boolean
}

/** Where an installed catalogue server came from (HI-545): Hive's own field in its definition, never a CLI's. */
export interface McpCatalogOrigin {
  source: string
  name: string
  version: string
  sha256: string
}

/** A server a project defines in its own config (.mcp.json…), as copying it to the workspace would add it. */
export interface McpProjectServer {
  name: string
  def: McpServerDef
  runs: string[]
  secretWarnings: string[]
}

export interface CompactionEvent {
  timestamp: string
  trigger: string
  preTokens: number
  postTokens: number
  /**
   * The last request before it: its input (what the context showed before that turn) and its output (thinking
   * included). A turn with a big output is often what pushed the context past the threshold. Absent when not known.
   */
  lastInputTokens?: number
  lastOutputTokens?: number
}

/** How a session's CLI was set to compact by itself (#242), as far as Hive could read at launch. */
export interface AutoCompactSetting {
  /** 'off': auto-compaction is turned off; a number: the auto-compact window it was set to (tokens); null: the CLI's own default. */
  window: number | 'off' | null
  /** It compacts at this percentage of the window (1–100), which can only bring it earlier. */
  percent?: number
  /** Where that comes from, in words ("CLAUDE_CODE_AUTO_COMPACT_WINDOW", "autoCompactWindow in Claude Code's settings.json"); null for the default. */
  source: string | null
  /** Why this is only as far as Hive can tell (sources it can't read: always for the default, #273; for any answer when a settings file couldn't be read or which are read isn't known, #333), shown with it. */
  estimate?: string
}

export interface SessionUsage {
  provider: ProviderId
  sessionId: string
  /** The session's title: the name the user gave it in the CLI, else one the CLI made up. */
  title: string | null
  /** A name the user gave the session in the CLI (Claude Code's /rename, Codex's thread name); absent when unknown. */
  customTitle?: string | null
  model: string | null
  cliVersion: string | null
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  requests: number
  /** Reasoning tokens, where the provider reports them separately (included in outputTokens). */
  reasoningTokens: number
  /**
   * The context now: the last request's input (cache included) plus its output (thinking included), which stays in
   * the context and is what the CLI compacts on. Right after a compaction, what it left.
   */
  contextTokens: number
  /** contextTokens' two parts (the gauge's tooltip); absent from usage read by older versions. */
  contextInputTokens?: number
  lastOutputTokens?: number
  /** The model's context window when the provider reports it. */
  contextWindow: number | null
  compactions: CompactionEvent[]
  cacheTtlSeconds: number
  firstActivity: string | null
  lastActivity: string | null
  userMessages: number
  lastPrompt: string | null
  /** API-equivalent cost for the session (USD): reported by the provider, else estimated by Hive; null if unknown. */
  costUsd: number | null
  costEstimated: boolean
  /**
   * Tokens used after the provider last reported the cost (Claude Code writes it only at some turns' ends):
   * Hive adds its estimate for them to the reported cost.
   */
  costUnreported?: Pick<SessionUsage, 'inputTokens' | 'outputTokens' | 'cacheWriteTokens' | 'cacheReadTokens'>
  /**
   * It ran only on servers on this PC (HI-1772, Darren 27 Oct): free, its cost a known $0, shown as "free (local)"; its
   * tokens counted as any session's.
   */
  costFree?: true
  /** The session's usage by local day (YYYY-MM-DD in this computer's time zone), for periods (see usageDays.ts). */
  days?: Record<string, DayUsage>
  /** From the parser: each cost report's increase and the tokens it covered by day. Hive turns them into day costs and removes them. */
  costReports?: { costUsd: number; days: Record<string, UsageTokens> }[]
  /**
   * From the parser: the usage over time (usageTimeline.ts), for cost per card (#602). Kept in usage-cache.json with the
   * parser's result and removed before pricing, so it never travels with the session's usage.
   */
  timeline?: UsageTimeline
  /**
   * Responses the CLI's safety classifier stopped (#606), by the model each was on ('' when the CLI didn't say): absent
   * when none, or for a CLI Hive can't detect them in (shared/safeguards.ts).
   */
  safeguards?: Record<string, number>
  /**
   * Of those, the CLI's records of stops it may have asked about first (SafeguardEvent.asked), per turn (its prompt's id):
   * a stop Hive saw on screen in that turn (SessionRecord.screenStops) is one of them, not another (withScreenStops).
   */
  safeguardsAsked?: Record<string, number>
}

/** A workspace's usage history (#1106): whether its one-time import of the sessions it had is under way, and how far. */
/** Settings → Sessions → Keep transcript backups (#1110): off, or a number of days. */
export type BackupRetention = 'off' | '30' | '90' | '180' | '365'

export interface UsageHistoryProgress {
  importing: boolean
  done: number
  total: number
}

export interface UsageTokens {
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
}

/** One local day's share of a session's usage. */
export interface DayUsage extends UsageTokens {
  requests: number
  prompts: number
  compactions: number
  /** The day's API-equivalent cost: its share of the reported cost, else Hive's estimate; null when no price is known. */
  costUsd: number | null
  costEstimated: boolean
}

export interface RecacheEstimate {
  tokens: number
  warm: boolean
  secondsLeft: number
  ttlSeconds: number
}

/** A deleted session's usage, kept so totals (the Overview, the Assistant's summary) still count it. */
export interface KeptUsage {
  id: string
  provider: ProviderId
  agentId?: string
  /** That agent's name when the session was deleted (SessionRecord.agentName), for totals by agent once it is gone. */
  agentName?: string
  cwd?: string
  name: string
  usage: SessionUsage
}

/** What Hive keeps for a project or the Assistant (Project Settings → Storage), in bytes. */
export interface ProjectStorage {
  path: string
  name: string
  assistant?: boolean
  /** Transcript backups (.hive/sessions). */
  sessions: number
  /** Archived sessions' backups (.hive/archive). */
  archive: number
  /** What the backups and the archive hold before compression (#1110: a compressed backup's own size), when any is. */
  sessionsRaw?: number
  archiveRaw?: number
  /** Files pasted or dropped into sessions (.hive/attachments, but its cards' folder). */
  attachments: number
  /** Files kept with cards (HI-1700: .hive/attachments/cards), when there are any; never cleaned up. */
  cardAttachments?: number
  /**
   * The folders agents work in (#1451): each of the project's slots on disk (`slot`, and the agent it is lent to now, if
   * any), and an agent's 0.9 worktree while its project isn't migrated; each folder once.
   */
  worktrees: { agent?: string; path: string; bytes: number; slot?: string }[]
  /** The project's review and check copies (#1435), one folder, when it has any. */
  copies?: { path: string; bytes: number }
  /** Worktrees no agent works in (#353), counted in the total. */
  unusedWorktrees?: { path: string; branch: string | null; bytes: number }[]
  total: number
  computedAt: string
}

export interface WorkspaceStorage {
  /** Projects and the Assistant, biggest first. */
  projects: ProjectStorage[]
  total: number
}

/** What Clean Up… removes; a days value of null leaves that kind out. */
export interface CleanupOptions {
  archivedAttachmentsDays: number | null
  /** Attachments of deleted sessions, and of launches that never got a session id. */
  orphanAttachments: boolean
  /** Hive's backups of archived sessions the CLI still has. */
  archivedBackupsDays: number | null
  /** Backups of archived sessions the CLI no longer has: the session is deleted (its usage still counts). */
  goneBackups: boolean
}

export interface CleanupItem {
  kind: 'archived-attachments' | 'orphan-attachments' | 'archived-backup' | 'gone-backup'
  path: string
  bytes: number
  sessionId?: string
  label: string
}

export interface CleanupResult {
  removed: number
  bytes: number
  /** Listed items that no longer qualified, or couldn't be moved (with why). */
  skipped: string[]
}

/** What Purge… (#1138) clears: one session's, a project's (or the Assistant's), or the whole workspace's. */
export type PurgeTarget = { kind: 'session'; projectPath: string; sessionId: string } | { kind: 'project'; projectPath: string } | { kind: 'workspace' }

/**
 * One thing Purge… removes, of Hive's only: a session's backup (an active or archived copy), each of its attachments, a
 * leftover file of a backup (a deleted session's, or half made: .spare, .tmp), each attachment of a session Hive no longer
 * has, or old usage kept on a session's record (keptUsage) or for a deleted one (deletedUsage), from before the usage
 * history (#1106): those are records, not files (no path).
 */
export interface PurgeItem {
  kind: 'backup' | 'attachments' | 'leftover-backup' | 'orphan-attachments' | 'kept-usage' | 'deleted-usage'
  /** What the apply call lists: its kind with its file or folder's path, or with the record's host and session id (purgeKey). */
  key: string
  /** The project folder (or the Assistant's home) it belongs to. */
  host: string
  /** The project's name, for the workspace's preview. */
  hostName: string
  /** The host is the Hive Assistant's home. */
  assistant?: boolean
  path?: string
  bytes: number
  /** A file's modified time as the preview saw it: apply leaves a file that changed since. */
  mtimeMs?: number
  sessionId?: string
  label: string
  /** A backup that is its session's last copy (the CLI no longer has its transcript): the session is deleted from Hive with it. */
  lastCopy?: boolean
}

export interface PurgePreview {
  /** The preview's own id: storage:purge applies it, as it was listed (main keeps it a while). */
  id: string
  items: PurgeItem[]
  /** Leftover files kept because they may be a session's only copy (Hive stopped while it deleted or moved it). */
  recoverable: number
  /** Sessions left alone because they are running or starting (whose things aren't listed). */
  running: number
}

export interface PurgeResult {
  removed: number
  bytes: number
  /** Sessions deleted from Hive because their last copy went. */
  deleted: number
  /** Listed items (their keys) that no longer qualified or couldn't be removed, with why. */
  skipped: { key: string; reason: string }[]
}

export interface SessionListItem extends Partial<SessionRecord> {
  id: string
  provider: ProviderId
  source: 'hive' | 'external'
  title: string | null
  lastActivity: string | null
  hasTranscript: boolean
  hasBackup: boolean
  /** The CLI's transcript's size on disk, from a stat when the list is read (#671); null when it is missing or can't be read. */
  transcriptBytes?: number | null
  /** A deleted session kept only for its usage (session:keptUsage), never in lists. */
  deleted?: boolean
  usage: SessionUsage | null
  recache: RecacheEstimate | null
  /** The usage history doesn't have it yet (#1106): its figures follow once the worker has read it (the window is told). */
  pending?: boolean
  /** The slot it ran in (#1434), if it ran in one of the project's. */
  slot?: string
  /** Why it can't resume in its slot now, or that only its own Resume takes the slot (`byHand`); absent: it may. */
  hold?: ResumeHold
}

/**
 * The workspace's usage for the Workspace Overview: each project's sessions (Hive's own, deleted ones included) and the
 * Assistant's, with their usage by day, from the usage history (#1106).
 */
export interface WorkspaceUsage {
  workspacePath: string
  projects: { name: string; path: string; items: SessionListItem[] }[]
  assistant: SessionListItem[]
  /** Projects left out: hidden, or removed from Hive. */
  hidden: number
  /** The usage history's import of the sessions the workspace had (#1106): while it runs, the figures are partial. */
  history: UsageHistoryProgress
}

/** A tool call and its result, as shown in the transcript viewer. */
export interface TranscriptTool {
  toolUseId: string
  name: string
  /** One line, e.g. the command's description or the file edited. */
  summary: string
  input: string
  result: string | null
  isError: boolean
  /** Images the tool returned (e.g. a screenshot it read). */
  images: TranscriptImageRef[]
  /** Set when input/result were shortened for display; fetch the full call with transcript:tool. */
  inputLength?: number
  resultLength?: number
  /**
   * The calls a Codex code-mode script made, in the order they ended (HI-2240): each a tool of its own, named as the same
   * call made directly is. Empty for a script that made none (its Codex records calls); absent for any other tool, and
   * for a script whose calls aren't known (its Codex records none, HI-2246: the scenario checks credit it nothing).
   */
  calls?: TranscriptTool[]
  /**
   * A Codex code-mode script (its `exec` tool, HI-2246), whatever it is shown as (Script, or the Edit of the patch it
   * applies): what it did is its `calls`, and with none known, unknown (the scenario checks credit it nothing).
   */
  script?: true
  /** A command's exit code, once it has ended with one (a Codex script's command, HI-2240). */
  exitCode?: number
  /**
   * The folder a command ran in, when its CLI recorded one apart from the command (HI-2264): a Codex script's command's
   * `cwd`, or the `workdir` of a direct exec_command. Absent when not recorded: it then ran in the session's folder.
   */
  cwd?: string
}

export interface TranscriptImageRef {
  /** Pass to transcript:image to get the picture. */
  id: number
  /** Where the image was pasted from, when Claude Code recorded it (e.g. .hive/images/…). */
  path: string | null
}

interface TranscriptItemBase {
  /** Position in the transcript; stable, because transcripts are append-only. */
  id: number
  timestamp: string | null
}

export type TranscriptItem = TranscriptItemBase &
  (
    | { kind: 'user'; text: string; images: TranscriptImageRef[] }
    | { kind: 'assistant'; text: string }
    | { kind: 'thinking'; text: string }
    | { kind: 'tool'; tool: TranscriptTool }
    | { kind: 'compaction'; trigger: string; preTokens: number; postTokens: number; nextRequestTokens: number | null; summary: string | null }
    | { kind: 'command'; name: string; args: string; output: string }
    /**
     * A note in the conversation: the CLI's own (an API error, a sign-in or usage limit, an interruption), or what it
     * relays (`from`): a background task's summary, or a command's output with no command (#342).
     */
    | { kind: 'notice'; text: string; level: 'info' | 'error'; from?: 'task' | 'command'; /** Hive's own notice as data (#797): `text` is its English, the window is sent it in its language. */ message?: Text }
  )

export interface Transcript {
  sessionId: string
  /** File size read so far. */
  size: number
  /** Pass back to transcript:read (knownVersion) to get null when nothing changed: a plain file's size, a compressed backup's identity (#1110: replaced whole, maybe by one of the same size). */
  version: string
  /** Items in the whole conversation; `items` holds those from `from` on (an item's id is its index). */
  total: number
  from: number
  items: TranscriptItem[]
}

export interface TranscriptSearchHit {
  itemId: number
  kind: TranscriptItem['kind']
  snippet: string
}

export interface TranscriptSearchResult {
  sessionId: string
  hits: TranscriptSearchHit[]
  /** More matches than returned. */
  more: boolean
}

export interface MemorySource {
  provider: ProviderId
  id: string
  label: string
  path: string
  kind: 'claude-md' | 'local-md' | 'auto-memory'
  exists: boolean
}

export interface GitFileChange {
  path: string
  status: string
  staged: boolean
}

export interface GitStatus {
  isRepo: boolean
  /** Git can't run (missing or too old, #346): what the Changes tab says instead of "not a git repository". */
  gitProblem?: string
  branch: string | null
  ahead: number
  behind: number
  files: GitFileChange[]
}

export interface GitDiff {
  path: string
  original: string
  modified: string
  binary: boolean
}

/** A recent workspace as a window sees it (File → Open Recent, the welcome page; #144). */
export interface RecentWorkspace {
  path: string
  /** Whether its folder is there now (one that isn't stays listed: an unplugged drive's may come back). */
  exists: boolean
  /** Open in another window: choosing it brings that window forward. */
  openElsewhere?: boolean
}

export interface AgentInstallInfo {
  provider: ProviderId
  found: boolean
  path: string | null
  version: string | null
  source: string | null
  latestVersion: string | null
  updateAvailable: boolean
  /** An explicit retry offered after a known update failure; never run automatically. */
  updateRetry?: ProviderUpdateRetry
  loggedIn: boolean | null
  /** How it is signed in (Claude Code's "claude.ai", Copilot's "GitHub CLI"…), when the CLI says. */
  authMethod: string | null
  /** The account it is signed in as, when the CLI says without Hive reading a secret (Copilot, #452). */
  account?: string | null
  /** Short notes Provider Setup shows under the sign-in (Copilot's Free plan runs Auto only). */
  notes?: string[]
  checking?: boolean
  /** Candidates skipped because they belong to an editor extension rather than the standalone CLI. */
  rejected?: string[]
  /** No CLI found, but an editor extension with its own copy is installed. */
  editorExtensionOnly?: boolean
  /**
   * The model the CLI uses when Hive passes none: its own settings, else the model last seen answering
   * in such a session. Null until known.
   */
  defaultModel?: string | null
  /** What still stands between the provider and running agents (not installed, not signed in, setup). */
  readiness?: ReadinessIssue[]
  /** The models the installed CLI reports, in its own order, with their capabilities; null when it couldn't be asked. */
  catalog?: ModelCatalog | null
  /** The effort the CLI's own settings choose for every model (Codex's model_reasoning_effort), if any. */
  configuredEffort?: EffortLevel | null
  /** Per model: the effort seen in sessions started without an effort choice (observedDefaultEffort). */
  observedEfforts?: Record<string, EffortLevel>
  /** The version this Hive release was tested with and how the installed one compares (#365); null when the release names none. */
  tested?: TestedCli | null
}

export interface ProviderUpdateRetry {
  message: string
  label: string
}

/** A coding agent CLI's version this Hive release was tested with (resources/tested-clis.json, #365). */
export interface TestedCli {
  version: string
  /** When the real tier ran against it (YYYY-MM-DD). */
  testedAt: string
  /** The installed version against it; unknown when the installed CLI didn't say its version. */
  installed: 'same' | 'newer' | 'older' | 'unknown'
}

export interface ReadinessIssue {
  id: string
  /** error: agents can't start; warning: they can, with limits; info: nice to know. */
  level: 'error' | 'warning' | 'info'
  message: string
  /** Button: a provider task Hive runs in a terminal. */
  action?: { label: string; task: ProviderTask }
  /** Shown in Provider Setup with the button: what the task will ask and how to choose (paragraphs, `code` allowed). */
  detail?: string[]
}

export type ProviderTask = 'install' | 'update' | 'login' | 'setup'

/** An entry in a project's file browser. relPath uses forward slashes and is relative to the project. */
export interface FileEntry {
  name: string
  relPath: string
  isDir: boolean
  size: number
  modified: string
  /** Ignored by git, or Hive's own .hive folder — shown dimmed. */
  ignored: boolean
}

/** A file opened in the Files tab editor. */
export interface FileContent {
  /** not-utf8: text that isn't valid UTF-8, never offered for editing (saving would rewrite its bytes, HI-2331). */
  kind: 'text' | 'binary' | 'too-large' | 'not-utf8'
  text: string
  size: number
  modified: string
  /** The file started with a UTF-8 byte order mark; it is kept on save. */
  bom: boolean
}

/** A file pasted or dropped into a session (#387), kept in its host's .hive/attachments/<sessionId>. */
export interface SessionAttachment {
  path: string
  name: string
  size: number
  modified: string
  kind: AttachmentKind
}

/** What was pasted or dropped into one session, from <project>/.hive/attachments/<sessionId>, newest first. */
export interface SessionAttachmentGroup {
  sessionId: string
  name: string | null
  archived: boolean
  /** The provider the session ran in, when Hive has its record: how its attachments are labelled. */
  provider: ProviderId | null
  attachments: SessionAttachment[]
}

/** One file to attach (#387), as the session would get it: copied into its attachments folder, or as it is by path. */
export interface AttachmentPlan {
  source: string
  name: string
  size: number
  kind: AttachmentKind
  /** Copied into the session's attachments folder: from outside its folder, or an image (kept with the session). */
  copy: boolean
  /** A folder: its path is pasted as it is. */
  folder: boolean
}

/** One attached file: the path pasted into the prompt. */
export interface Attached {
  source: string
  path: string
  name: string
  kind: AttachmentKind
  copied: boolean
}

/** A kept attachment's content for the Attachments tab's viewer: text (shown with Hive's previewers), or not text. */
export interface AttachmentContent {
  kind: 'text' | 'binary' | 'too-large'
  text: string
}

export interface NoteFile {
  path: string
  relPath: string
  name: string
  isDir: boolean
  children?: NoteFile[]
  modified?: string
}

export type ToastLevel = 'info' | 'success' | 'warning' | 'error'

export interface ToastAction {
  label: string
  command: string
  args?: unknown[]
}

/**
 * What a notice is about, which a click on it opens (HI-1961: `hive_notify`'s target): an agent's pane, or a card's
 * dialog. Its names are as they were when it was shown, for saying it's gone.
 */
export type ToastTarget =
  | { kind: 'agent'; projectPath: string; agentId: string; name: string; project: string }
  | { kind: 'card'; number: number; label: string; projectPath: string | null; workspacePath: string }
  /** A project (HI-2320: every entry links to what it is about); `project` its name as shown then. */
  | { kind: 'project'; projectPath: string; project: string }

/** What an entry is about, which says where it goes and how it behaves (shared/notify.ts, HI-2320). */
export type NotifyKind = 'needsYou' | 'finished' | 'work' | 'usage' | 'warning' | 'result' | 'transcript' | 'update' | 'quit' | 'tip'

/**
 * What keeps a window-made entry's buttons live (HI-2320), re-checked by the window as its state changes
 * (renderer/entryConditions.ts): its buttons go, and the entry says what happened, once it no longer holds.
 */
export type EntryCondition =
  | { kind: 'mcpMissing'; projectPath: string; names: string[] }

export type UpdateStatus = 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'up-to-date' | 'error'

/** Hive's own updates (electron-updater, GitHub Releases). */
export interface UpdateState {
  status: UpdateStatus
  /** The running version. */
  current: string
  /** The newer version found. */
  version?: string
  releaseName?: string
  /** From the GitHub release (HTML or Markdown). */
  releaseNotes?: string
  releaseDate?: string
  /** Installer size in bytes. */
  size?: number
  progress?: { percent: number; transferred: number; total: number; bytesPerSecond: number }
  error?: string
  checkedAt?: string
  /** The last check was started by the user. */
  manual?: boolean
  /** The version found is one the user skipped. */
  skipped?: boolean
  /** The running build is a local one (#1647: `npm run dist`), with the commit it was built from. */
  local?: { commit: string | null }
  /** A published release of the running local build's own version (#1647): offered, never installed by itself. */
  published?: string
  /** Why the downloaded update wasn't installed (#1647): the copy on disk couldn't be read, or isn't older. */
  notInstalled?: 'unreadable' | 'notNewer'
}

/**
 * One notification (HI-2320): shown as a pop-up in one window and kept in that window's bell, or kept in the bell only
 * (`quiet`: told as a Windows notification, or left out of pop-ups by the scope).
 */
export interface ToastMessage {
  id: string
  level: ToastLevel
  /** What it is about (shared/notify.ts); none: from its level (warning and error: warning, else result). */
  kind?: NotifyKind
  title: string
  message?: string
  /** Its buttons, shown while it is unresolved, in its pop-up and its bell row alike. */
  actions?: ToastAction[]
  /** What a click on it opens (HI-1961; a project too, HI-2320). */
  target?: ToastTarget
  timestamp: string
  source?: string
  /** Kept in the Notifications panel (the bell) only, not shown as a pop-up. */
  quiet?: boolean
  /** How long the pop-up stays (ms), when not the usual for its kind (an Undo's ~10 s, #351). */
  timeoutMs?: number
  /** The offer its buttons act on, main's (main/notify.ts): resolved by that offer alone, never by a newer one. */
  offer?: string
  /** A window-made entry's live condition, which the window re-checks (renderer/entryConditions.ts). */
  condition?: EntryCondition
  /** What happened, once its action is done or no longer applies: its buttons are gone and this is shown instead. */
  resolved?: string
  /** What one of its buttons did while others are still live (HI-2320), shown above them. */
  note?: string
}

export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  v8: string
  platform: string
  arch: string
  userData: string
  logsPath: string
  isPackaged: boolean
  /** The language Hive shows, with its translations. */
  language: LanguageInfo
  /** Hardware acceleration this run (#676): off (Settings → Advanced, or --disable-gpu for this start), and why. */
  gpu: { off: boolean; why: 'setting' | 'switch' | null }
}

/** The language Hive shows (#767), as main chose it, for the window. */
export interface LanguageInfo {
  /** Hive's language now: a language's code, or the pseudo-locale (en-XA). */
  code: string
  /** The locale dates and numbers are formatted with (en-GB, pl-PL). */
  locale: string
  /** The language Chromium started in: its own parts (the PDF viewer, date pickers) change only at the next start. */
  startCode: string
  /** The language Automatic picks now. */
  automatic: string
  /** The languages with translations (English aside): Automatic picks only from these. */
  available: string[]
  /** Windows' regional format, for dates shown as Windows shows them (Date format: System). */
  regionalFormat: string
  /** The --lang start option or HIVE_LANG, which wins over the setting for this run; null without one. */
  forced: string | null
  /** Its translations (id → ICU message), loaded once by main. */
  messages: Record<string, string>
}

export interface AgentApiInfo {
  enabled: boolean
  running: boolean
  url: string | null
  token: string
  error?: string
  /** The read-only viewer tokens the user made (#620), oldest first. */
  viewers: ViewerToken[]
}

/** A read-only Agent API token for an app that shows Hive (Apiary): it reads and follows the workspace, never changes it. */
export interface ViewerToken {
  id: string
  /** What the user called it ("Apiary"). */
  name: string
  token: string
  /** ISO time. */
  createdAt: string
}

/**
 * Where a window's workspace is in opening it (HI-1694), for the steady view the window shows meanwhile: reading its
 * projects, and after the user said yes to its upgrade to 1.0, the upgrade (the 0.9 board kept as a backup), the cards'
 * and projects' adoption, and the agents' worktrees adopted as slots. Its bundled skills and modes are brought up to date
 * after the open, not in it (HI-1705).
 */
export interface OpenProgress {
  /** The workspace's folder, and its name as shown. */
  path: string
  name: string
  step: 'projects' | 'upgrade' | 'adoption' | 'slots'
}

/** Events pushed from main to renderer. */
export type HiveEvent =
  | { type: 'workspace-changed'; workspace: WorkspaceInfo | null }
  /** A workspace's team paused or resumed (HI-2081): its pause now, or null. */
  | { type: 'team-pause-changed'; workspacePath: string; pause: import('./teamPause').TeamPause | null; was?: import('./teamPause').TeamPause | null }
  /** The window's workspace opening (HI-1694): its step now, or null once it is done. */
  | { type: 'workspace-progress'; progress: OpenProgress | null }
  /** The recent workspaces changed (opened, removed, cleared): each window asks for its own view of them (#144). */
  | { type: 'recent-changed' }
  | { type: 'session-status'; state: LiveSessionState }
  /** `failure`: the CLI exited before its session started (and nobody stopped it): why, for the agent's pane. */
  | { type: 'session-exit'; projectPath: string; agentId: string; sessionId: string; exitCode: number; failure?: StartFailure; ended?: SessionEnd }
  /** What an agent's stopped launches left running changed (#507): found, ended, kept, or ended by themselves (no processes). */
  | { type: 'agent-leftovers'; leftovers: AgentLeftovers }
  | { type: 'toast'; toast: ToastMessage }
  /** A notice no longer true (HI-1905: a project's platform notice once detection and the platform agree): every window drops it. */
  /** Entries whose offer was taken or no longer applies (HI-2320): their buttons go and `outcome` says what happened. */
  | { type: 'toast-resolved'; ids: string[]; outcome: string }
  /** One of an entry's buttons done or no longer applying, its others still live (HI-2320): those commands' buttons go, `note` says what happened. */
  | { type: 'toast-update'; ids: string[]; drop: string[]; note: string }
  /** How many finishes wait to be told together (HI-2320: no tip while some do). */
  | { type: 'notify-pending'; finishes: number }
  | { type: 'chime'; projectPath: string; silent?: boolean }
  | { type: 'settings-changed'; settings: AppSettings }
  /** Advanced settings (#367) changed: an override, advanced.json, a workspace's own or an installed CLI's version. */
  | { type: 'advanced-changed' }
  /** One project's view preference saved (ui:setProjectPref): every window's store follows. */
  | { type: 'ui-pref-changed'; pref: ProjectPref; project: string; value: unknown }
  /** Panes' sizes and states moved to other keys (HI-2008: a moved workspace's): every window's store follows; null removes one. */
  | { type: 'ui-panes-changed'; panes: Record<string, number | null> }
  /** What the tips know changed (ui:changeTips): every window's store follows. */
  | { type: 'tips-changed'; tips: TipsState }
  | { type: 'provider-install'; provider: ProviderId; info: AgentInstallInfo }
  /** Whether git runs changed (#346): every window's store follows. */
  | { type: 'git-tool'; git: GitTool }
  /** `reply`: an entry's button run here for another window (HI-2320), which waits for notice:actionDone with it. */
  | { type: 'menu-command'; command: string; args?: unknown[]; reply?: string }
  | { type: 'usage-changed'; projectPath: string; sessionId: string }
  /** A workspace's usage history: its one-time import of existing sessions under way, or done (#1106). */
  | { type: 'usage-history'; workspacePath: string; progress: UsageHistoryProgress }
  /** The bulk actions running on a host's sessions (#1659), each with how far it has got: none once they have all ended. */
  | { type: 'session-bulk'; projectPath: string; runs: SessionBulkProgress[] }
  | { type: 'notes-changed' }
  /** The workspace's task board changed (its path names the window). */
  | { type: 'tasks-changed'; workspacePath: string }
  /** Quitting needs the user's decision: the renderer shows the quit dialog and answers with app:quitDecision. */
  | { type: 'quit-request'; sessions: QuitSession[]; unsaved: string[]; /** Anything but 'app' stops only this window's workspace's sessions. */ scope?: QuitScope }
  /** Hive is waiting for working agents to finish before quitting (or stopped waiting). */
  | { type: 'quit-pending'; pending: boolean; working: number }
  /** This window's close command (HI-1368): the panel shows it while it runs or failed; null: none (the panel goes). */
  | { type: 'close-command'; run: CloseCommandRun | null }
  /** How many working agents keep the PC awake (0: it may sleep). */
  | { type: 'keep-awake'; working: number }
  /** Files changed in a project that has a Files or Images tab open. dirs are relative, '' is the root. */
  | { type: 'files-changed'; projectPath: string; dirs: string[] }
  | { type: 'skills-changed' }
  | { type: 'modes-changed' }
  /** A workspace's Assistant journal changed (#1033: its browser reads it again). */
  | { type: 'journal-changed'; workspacePath: string }
  /** The Hive Assistant acted, or asks the user something (its home's path names the window). */
  | { type: 'assistant-activity'; projectPath: string; action: AssistantAction }
  | { type: 'assistant-questions'; projectPath: string; questions: AssistantQuestion[] }
  /** An agent was added by the Hive Assistant: the view doesn't move to it. */
  | { type: 'agent-added'; projectPath: string; agentId: string }
  /**
   * An agent's start changed (HI-1977): under way, failed with why, or neither (null), as its AgentInfo's `start`; `seq`,
   * the count of start changes with it, newer than an AgentInfo whose `startSeq` is lower.
   */
  | { type: 'agent-start'; projectPath: string; agentId: string; start: AgentStart | null; seq: number }
  /** A worktree agent's unmerged work changed (null: git couldn't check it). */
  | { type: 'branch-status'; projectPath: string; agentId: string; status: AgentBranchStatus | null }
  | { type: 'plan-usage'; provider: ProviderId; usage: PlanUsage; connection?: string }
  | { type: 'plan-usage-cleared'; connection: string }
  /** Hive's accounts changed (HI-980: one added, renamed, removed, checked, or a workspace's choice of them): read them again. */
  | { type: 'connections-changed' }
  | { type: 'window-state'; maximized: boolean; focused: boolean; alwaysOnTop: boolean }
  /** A window opened or closed: how many there are now (File → Exit says it closes them all). */
  | { type: 'windows-changed'; count: number }
  /** `windows`: told as a Windows notification, so no window shows it; only in-process listeners (the Agent API's stream) hear of it. */
  | { type: 'notice'; notice: Notice; windows?: true }
  /** The agent no longer waits for you: its waiting banner closes, in whichever window shows it. */
  | { type: 'notice-resolved'; projectPath: string; agentId: string }
  | { type: 'update-state'; state: UpdateState }
  /** The language Hive shows changed (Settings → General → Language): every window shows it. */
  | { type: 'language-changed'; language: LanguageInfo }
  /** A workspace's progress runs changed (all of them, newest first): for in-process listeners (the Agent API's stream, the developer console). */
  | { type: 'progress-changed'; workspacePath: string; runs: ProgressRun[] }
  /** The window's telling of the same (#1108): ProgressTelling. */
  | ProgressTelling
  /** A workspace's merge slots changed (those held or waited for). */
  | { type: 'merge-slots-changed'; workspacePath: string; slots: MergeSlotInfo[] }
  /** A workspace's lanes changed, or one of their cards did (the lanes it lists, as lanes:list gives them). */
  | { type: 'lanes-changed'; workspacePath: string; lanes: LaneInfo[] }
  /** A target's merge queue changed (#1353): an entry queued, its step, an outcome, a pause; read it with queue:list. */
  | { type: 'queue-changed'; workspacePath: string; projectPath: string; target: string }
  /** A project's workflow (project.json's `workflow`: its options, preset, stage names) was written (#1417): views read its stages again. */
  | { type: 'workflow-changed'; workspacePath: string; projectPath: string }
  /** A lane ended with every card Done (#1270): once, with what each card brought in (its Integrated result; null: none). */
  | { type: 'lane-ended'; workspacePath: string; lane: string; project: string; results: { card: number; revision: string | null }[] }
  /** The developer console's new events for the sources this window watches (#636): sent to that window only. */
  /** A window's developer console recording got further, or stopped (#638). */
  | { type: 'console-recording'; recording: ConsoleRecordingInfo }
  /** The developer console's options changed (#699): Settings → Advanced → Developer console: show text. Console windows only. */
  | { type: 'console-options'; showText: boolean }
  | { type: 'console-events'; events: ConsoleEvent[]; /** Events that didn't fit the window's queue since the last batch (it fell behind). */ dropped?: number }

/**
 * A lane (#483): a builder and a reviewer taking a project's cards in order (the card-loop skill), as Hive keeps it.
 * Bookkeeping, never a gate: a loop runs the same without one. `paused` while its current card is blocked; `ended` when
 * every card is Done or its builder ends it after the merge; `abandoned` when its builder or reviewer is removed, or it
 * is ended unmerged. Times are ISO.
 */
export type LaneState = 'active' | 'paused' | 'ended' | 'abandoned'

/** A lane's card as the board has it now, or as an ended lane left it (#512). */
export interface LaneCard {
  number: number
  /** '' when gone. */
  title: string
  /**
   * gone: archived, deleted or moved to another project. unrecorded: the lane ended without a record of where its cards
   * were (it ended before Hive kept one, or the record was damaged): not known, and never the board's now.
   */
  column: TaskColumn | 'gone' | 'unrecorded'
  blocked: string | null
  /** The round it is in, or took: 1 + the reviews it has failed. */
  round: number
  /** A review is under way now. */
  reviewing: boolean
  /** At its round limit, waiting for the user's answer (For you, §16.11.4): its lane pauses on it. */
  roundLimit?: boolean
  /**
   * Held elsewhere (HI-1821), an open card that isn't the lane's own: the id of the agent it is given to on the board
   * (not the lane's builder), or, given to none, of the running lane that owns it (another lane listing it: the one whose
   * builder has it, else the newest). Its lane shows it but never takes it, waits on it or keys a queued list change to it.
   */
  elsewhere?: string
}

export interface LaneInfo {
  id: string
  /** The project's folder name. */
  project: string
  name: string | null
  builder: { id: string; name: string }
  reviewer: { id: string; name: string } | null
  /** Reviewed by the project's reviewer pool (#1443, G17): `reviewer` is null, and each card goes to a free pooled reviewer. */
  pool?: boolean
  /** In the lane's order. */
  cards: LaneCard[]
  /** The first card not in Passed or Done (null: none left). */
  current: number | null
  state: LaneState
  /** Paused: the blocked card. */
  pausedOn: number | null
  /** Failed reviews a card gets before the user is asked. */
  rounds: number
  /** No change this long and the user is told. */
  waitMinutes: number
  /** Who started it, as the board names them ("B1 (hive)", "Assistant", "You"). */
  startedBy: string
  startedAt: string
  updatedAt: string
  endedAt: string | null
  mergeCommit: string | null
  /**
   * Why a running lane waits, or what it waits on (#1270, SPEC §16.11.4), worked out in main from the board and its
   * cards' facts; null when it goes on as it is (or has ended). With workflow rules off, only a blocked or held card.
   */
  status: LaneStatus | null
  /** A list change made while a card was in flight, applied at the next card boundary (#1270); null: none. */
  queued: number[] | null
  /**
   * Old rules (#1421, §16.5.4): a running lane whose recorded ruleset isn't its project's current one, so it keeps the
   * options from before a change until it ends. Never on an ended lane, nor one with none recorded (from before 1.0).
   */
  oldRules: boolean
  /**
   * A running lane's stages: its recorded ruleset's, in board order (#1421: HR4's round 1), which its cards in Todo take
   * too; null for an ended lane, or one with none recorded (its project's options now stand in).
   */
  stages: StageId[] | null
  /** The slot a running lane's builder works in (#1438: its lease's), or null (none yet, or slots don't apply). */
  slot: string | null
  /** That slot as its row's hover tells it (#1446): its line, ready or being prepared, its lease's start; null with none. */
  slotInfo?: LaneSlotInfo | null
  /**
   * A lane reviewed by the pool (#1443, #1446): who gave its current card's last verdict (and whether it passed), and who
   * reviews it now, by name; absent for other lanes, or with no current card.
   */
  poolReview?: { lastVerdict: { name: string; pass: boolean } | null; reviewing: string | null }
}

/**
 * Why a lane waits (#1270): its card blocked or On Hold, a request for you (For you), the round limit reached, a card
 * passed but not merged yet (merging: in the merge queue), its pass gone stale (submit again), no reviewer on a card in
 * Review, or a list change queued after the card in flight. The first four and the merge pause the lane, as does `hooks`
 * (#1336): its builder's or reviewer's hooks aren't arriving, so Hive can't tell what it does and types nothing into it.
 * `checkCopy` (#1435): its card's review or isolated check waits for a review or check copy to be free. `slot` (#1438):
 * the lane has no slot yet (every one is lent), so its builder can't start; it pauses the lane until one is free.
 * `preparing` (#1446): its slot is being prepared (G15's warming: its setup or an install), which doesn't pause it.
 * `teamPause` (HI-2081): its workspace's team is paused (before an update): nothing of it starts or is woken until it
 * resumes; it pauses the lane.
 */
export type LaneWaitReason = 'blocked' | 'hold' | 'you' | 'roundLimit' | 'notMerged' | 'merging' | 'stale' | 'reviewer' | 'listChanges' | 'lineUpdate' | 'hooks' | 'checkCopy' | 'slot' | 'preparing' | 'startWait' | 'teamPause'

/**
 * A running lane's slot as its row shows it (#1446): its name, whether the lane works in its builder's carried slot (a
 * 0.9 worktree adopted at the upgrade, #1441) rather than one lent to the lane, the current card's line (its branch
 * there), whether the slot is ready or being prepared (G15's warming, its setup or install), and when its lease began.
 */
export interface LaneSlotInfo {
  name: string
  carried: boolean
  line: string | null
  state: 'ready' | 'preparing'
  since: string
}

/** Start lane… from the window (#1280): who builds and reviews, the cards in order, the user's note and a name. */
export interface LaneStartRequest {
  builder: string
  reviewer: string | null
  /** Reviewed by the project's reviewer pool (#1443: G17 a shared pool), with `reviewer` null. */
  pool?: boolean
  cards: number[]
  note?: string
  name?: string | null
  /** For the builder's running lane with a card in flight: the list applied now, that card put back (HI-1995). */
  applyNow?: boolean
}

/**
 * What Start Lane… offers for a project (#1443): with workflow rules on and G17 a shared pool, Pool in its reviewer list
 * (`pool`: the agents whose role reviews, by id and name); null: one reviewer per lane.
 */
export interface LaneStartInfo {
  pool: { id: string; name: string }[] | null
}

/** What Start lane… did: the lane recorded, and how each agent started (failed: the lane stays, why said). */
export interface LaneStartResult {
  lane: LaneInfo
  /** `deferred` (HI-2034): in a turn or with a prompt it hadn't taken, so it starts in a new conversation once free (the lane's `freshStart`). */
  started: { agentId: string; name: string; role: 'builder' | 'reviewer'; how: 'started' | 'fresh' | 'failed' | 'deferred'; why?: string }[]
  /** Its slot (#1438), or, with none free, why it waits: its agents start once one is. */
  slot?: string
  waitingForSlot?: string
}

export interface LaneStatus {
  reason: LaneWaitReason
  /** The card it is about. */
  card: number | null
  /** blocked: the card's reason, as the board has it. */
  blocked?: string
  /** you: what the user is asked for (the open request's kind, #1279). */
  ask?: 'approve' | 'decide' | 'test' | 'signIn' | 'other'
  /** hooks: the agent whose hooks aren't arriving, by name; startWait: the builder; slot (`held` session, HI-2466): the agent whose session holds the slot. */
  agent?: string
  /** startWait (HI-2029): why its card isn't started yet (LaneStartWhy); `fresh` (HI-2034): `agent` is owed its new conversation. */
  why?: 'busy' | 'watching' | 'queued' | 'failed' | 'refused' | 'fresh' | 'dependencies'
  /** startWait `dependencies` (HI-2129): the card it depends on that isn't Done yet, by its key. */
  waitsFor?: string
  /** startWait `fresh` (HI-2034): no more automatic tries, and why (the user retries it, or ends the lane); the reason a failure gave. */
  freshBlocked?: 'timeout' | 'uncertain' | 'failed'
  freshWhy?: string
  /** preparing (#1446): the slot being prepared; slot (HI-2466): the free slot it was refused as held. */
  slot?: string
  /** slot (HI-2466): what holds that free slot, a session or a process (a file or folder in it open); Hive tries again until it is free. */
  held?: 'session' | 'process'
  /**
   * When this wait began (HI-1926, epoch ms): when Hive first saw this reason for this card (and ask), kept while they
   * stay the same. `atLeast`: Hive didn't see it begin (it was already waiting when this Hive first listed the lane), so
   * it has waited at least that long.
   */
  since?: number
  atLeast?: boolean
}

/**
 * Who reported a progress run: a project agent (by its token), the Hive Assistant, a script with the workspace token, or
 * Hive itself (its merge queue's checks, #1349: no agent and no token reports them).
 */
export type ProgressSource = 'agent' | 'assistant' | 'api' | 'hive'

/**
 * A merge slot (#350): one merge at a time into a project's branch. `holder` is who merges now (an agent, or the user's
 * merge from the Merge dialog); `taken` false while it is an agent's turn that hasn't claimed it again yet. Times are
 * epoch ms.
 */
export interface MergeSlotInfo {
  project: string
  branch: string
  /** `id` is this hold's own: Release names it, so a hold that came after is never released for it. */
  holder: { id: string; kind: 'agent' | 'user'; agentId?: string; name: string; cards: number[]; since: number; until: number; taken: boolean } | null
  waiting: { agentId: string; name: string; cards: number[]; since: number }[]
}

/**
 * A long run an agent reports (tests, a build), for the Progress panel. `step` counts finished steps (0 to `total`),
 * `stepName` is the one running now, and `estimateMs` the time left as of `updatedAt` (epoch ms throughout).
 */
/**
 * The window's telling of a workspace's runs (#1108): `whole`, every run (newest first); else only the runs that changed,
 * to put in place by id (a new one by when it started). `seq` counts a workspace's tellings: one skipped means read the
 * list again.
 */
export interface ProgressTelling {
  type: 'progress-runs'
  workspacePath: string
  seq: number
  whole: boolean
  runs: ProgressRun[]
}

/** A workspace's runs as a window reads them, with the number of the last telling sent before (#1108). */
export interface ProgressSnapshot {
  workspacePath: string
  seq: number
  runs: ProgressRun[]
}

export interface ProgressRun {
  id: string
  workspacePath: string
  /** The reporting agent's project (null for the Assistant and scripts). */
  projectPath: string | null
  agentId: string | null
  /** Its agent's name, "Hive Assistant", or "Script". */
  agentName: string
  /**
   * `agentName` is a name Hive gave the run, not one its caller has (#872): "Script" for an Agent API script, "Agent"
   * for a kept run with no name, "Hive (slot <name>)" for a slot's warming (#1429, its `slot`). The window shows it in its
   * language; the Agent API leaves this out (publicRun).
   */
  defaultName?: 'script' | 'agent' | 'mergeQueue' | 'slot' | 'copy'
  provider: ProviderId | null
  source: ProgressSource
  title: string
  command: string | null
  total: number | null
  step: number | null
  stepName: string | null
  estimateMs: number | null
  startedAt: number
  updatedAt: number
  finishedAt: number | null
  /**
   * stale: running, but no report for longer than expected, or its agent stopped. stopped (#549): ended without passing
   * or failing: its command was interrupted (Ctrl+C), or its reporter's process is gone without a finish.
   */
  state: 'running' | 'stale' | 'passed' | 'failed' | 'stopped'
  /** Why a stale run is stale: no report for too long, or its agent's session stopped. */
  staleReason: 'quiet' | 'agent-stopped' | null
  /** Why a stopped run stopped: interrupted (its reporter said so), or gone (its process ended without a report). */
  stopReason: 'interrupted' | 'gone' | null
  /**
   * What a running run waits for before it can go on ("waiting for a test slot: …", #549), or null. While it waits it
   * has no time left (estimateMs null; the time that was left resumes when it stops waiting) and never goes stale.
   */
  waiting: string | null
  /** Since when it waits (ms), while it does. */
  waitingSince: number | null
  /** The time that was left when it began to wait, given back when it stops (null: none). Not shown. */
  heldEstimateMs: number | null
  /** The reporting process, when the reporter gave it: once it is gone, an open run ends as stopped (gone). */
  pid: number | null
  summary: string | null
  /** The user dismissed it: listed under Recent only. */
  dismissed: boolean
  /** When the user saw it failed or stale (the panel open, Hive focused): it folds into Recent a few seconds later. */
  seenAt: number | null
  /** How long it was expected to take in all (ms), from its first estimate; null without one. */
  expectedMs: number | null
  /** The command's exit code, when its reporter gave one. */
  exitCode: number | null
  /** A log or run record the reporter named (a path). */
  logPath: string | null
  /**
   * Its title is its command line (hive-progress without --title), as its reporter said (#620): the Agent API names it by
   * its program alone, since a command's arguments can hold a token or a prompt.
   */
  titleFromCommand?: true
  /**
   * The card it ran for (its number, #1220): named (`hive-progress --card`, `card`), or the reporting agent's card in
   * Doing when it has one and named none. Absent for a run with no card.
   */
  card?: number
  /** The revision it ran for (a full commit id): named (`--revision`, which must be what's checked out), else the folder's head at the start. */
  revision?: string
  /** What was checked out where it ran when it started (a full commit id): the revision it actually tested (SPEC §16.13). */
  testedCheckout?: string
  /** The check it was started as (`hive-progress --check <name>`: the project's configured command for that name ran). */
  check?: string
  /** The folder it ran in, as its reporter said. */
  folder?: string
  /** A finished run for a card (#1222): how it counted as a check of the card's revision (its `CheckRan`). */
  counts?: RunCheck
  /** Hive's own run (#1349): nothing was installed before the merge checks (no setup command and no lock file). */
  noInstall?: true
  /** Hive's own install run (#1349): the setup command as written, after node_modules was removed (Hive has no clean form of it). */
  installAsWritten?: true
  /** Hive's own failed merge check or install that counts as temporary (#1362): why, and the network error code that said so. */
  transient?: TransientFailure
  /** Hive's own run warming a slot (#1429: its setup, an install, its archive script): the slot's name. */
  slot?: string
  /**
   * A review or check copy (#1435): Hive's own run warming it, or an agent's isolated check run in it (its details name
   * it, and it can be stopped from the panel: its processes are in the copy's job).
   */
  copy?: string
}

/**
 * Why a failed merge check counts as the environment's failure, not the work's (#1349, #1362): it couldn't start, its
 * program wasn't found, it ran out of time, it was ended from outside, it exited 75 (the project's own "temporary
 * failure, try again"), or a network error code was in its last 40 lines.
 */
export type TransientCause = 'spawn' | 'notFound' | 'timeout' | 'killed' | 'exit75' | 'network'

/** A transient failure's cause, with the network error code found (`network`). */
export interface TransientFailure {
  cause: TransientCause
  code?: string
}

/** Why a run doesn't count as a check (SPEC §16.13), as its `CheckRan` says. */
export type CheckWhyNot = 'notCheck' | 'notContained' | 'dirty' | 'changed' | 'moved' | 'revisionChanged'

/** How a run counted as a check: the check's name, and why not when it didn't. */
export interface RunCheck {
  name: string
  counted: boolean
  whyNot?: CheckWhyNot
  /** A failed check the card's rules require before a gate (#1279): it blocks that gate (review) for the card. */
  blocks?: 'review'
}
