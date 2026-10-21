// Types shared by the main process, preload bridge and renderer.

import type { JournalSettings } from './journal'
import type { Text, TextPart } from './advanced'
import type { AvOffer } from './antivirus'
import type { ActivityTarget } from './assistantActivity'
import type { AttachmentKind } from './attachments'
import type { StartFailure } from './startFailure'
import type { TipsState } from './tips'
import type { TemplateAgent, TemplateScope } from './templates'
import type { KeepAwakeSetting } from './keepAwake'
import type { DateFormat, TimeFormat } from './dates'
import type { ProjectPref } from './uiPrefs'
import type { GitTool } from './gitTool'
import type { ConsoleEvent, ConsoleRecordingInfo } from './devConsole'
import type { SafeguardNote, ScreenStop } from './safeguards'
import type { AgentLeftovers, LeftoverProcessMode } from './agentProcesses'
import type { UsageTimeline } from './usageTimeline'
import type { PlatformId, ProjectPlatform } from './platform/descriptors'
import type { PresetId, WorkflowOptions } from './workflow/options'
import type { Refusal } from './workflow/refusals'

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
/** Settings → Notifications, *While Hive is focused*: Show in Hive, Show nothing, or a Windows notification. */
export type WhileFocused = 'inApp' | 'nothing' | 'windows'
/** Settings → Notifications, *Show banners for*. */
export type BannerScope = 'all' | 'workspace' | 'project'
export type BannerPosition = 'top-left' | 'top-center' | 'top-right' | 'bottom-left' | 'bottom-center' | 'bottom-right'

/** A notice shown as a banner in the focused window (#157): an agent finished or waiting, or another notice. */
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
  /** The global default workflow options (SPEC §16.6.6), under each workspace's and project's own; absent: all off. */
  workflow?: WorkflowDefaults
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
  notifications: {
    chimeEnabled: boolean
    chimeSound: ChimeSound
    chimeVolume: number
    desktopNotifications: boolean
    notifyOnFinished: boolean
    notifyOnWaiting: boolean
    /** While a Hive window is focused: a banner in it, nothing, or a Windows notification (shared/bursts.ts noticeRoute). */
    whileFocused: WhileFocused
    /** Which notices the focused window shows as banners: from every window, its workspace, or the project it shows. */
    bannerScope: BannerScope
    bannerPosition: BannerPosition
    /** How long a banner for a finished agent (or another notice) stays, in seconds; kept while the pointer is on it. */
    bannerSeconds: number
    /** Banners for an agent waiting for you stay until handled (clicked, dismissed or answered); off: they close like the others. */
    waitingBannerStays: boolean
    /** A badge with the count of agents that need you on the window's taskbar button, and the count in its title. */
    taskbarCount: boolean
    /** Flash the taskbar button when an agent starts waiting for your input and the window isn't focused. */
    flashOnWaiting: boolean
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
    /** Per-file locks between agents working in the same folder. */
    fileLocks: FileLockMode
    /** Git-ignored files copied into new worktrees: glob patterns, one per line or comma separated. */
    worktreeCopy: string
    /** Default for merging a worktree agent's branch. */
    mergeStyle: MergeStyle
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
  version: 8
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
    /** The active projects folded in the Assistant panel's Workspace list (#399), by `assistantFoldKey` (workspace and project path); unfolded ones aren't kept. */
    assistantFold?: Record<string, boolean>
    /** Each workspace's board as the user left it, by workspace path in lower case (#170): collapsed columns, folded cards. */
    boardFold?: Record<string, BoardFold>
    /** Each workspace's Progress panel filter (#251), by workspace path in lower case: one project's runs (and agent's), or all. */
    progressFilter?: Record<string, { project: string; agent?: string }>
    /** Each workspace's running lanes in the order the user put them in the Progress panel (#568), by workspace path in lower case: lane ids. */
    laneOrder?: Record<string, string[]>
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
  /** Per provider: the plan usage it last reported (account-wide). */
  planUsage: Record<ProviderId, PlanUsage>
  /** Highest warning shown per "provider:limit", and for which reset period. */
  planWarnings: Record<string, { resetsAt: string | null; level: number }>
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
export interface PlanUsage {
  provider: ProviderId
  /** The plan's name when the provider says (e.g. "plus"). */
  plan: string | null
  limits: PlanLimit[]
  updatedAt: string
}

export interface WorkspaceConfig {
  version: 1
  /** Where the workspace was last opened (#146): a different folder now means it was moved, and Repair… is offered. */
  lastPath?: string
  /** The last project rename (#514, `project-names.json`'s number) its hidden and removed projects follow. */
  renamesApplied?: number
  /**
   * The MCP servers on in the workspace (#1093): its master switch. A server runs in a project only when it is on here
   * and on in the project (mcpOnInProject). `model` 2: the settings are #1093's (before, `enabled` meant on for all
   * projects, unless a project turned it off); absent, they are moved to it when the workspace opens.
   */
  mcp: { enabled: string[]; model?: 2 }
  /** Project folders Hive leaves out (Hide, or Remove from Hive while the folder is still in the workspace), by folder name. */
  hiddenProjects?: HiddenProject[]
  /** Card loops' rounds and wait in hours when a request doesn't say (#412, Settings → Workspace); absent: 10 and 6. */
  loops?: { rounds?: number; waitHours?: number }
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

/** A board as the user left it (a view preference, never in the cards' files): collapsed columns and folded cards. */
export interface BoardFold {
  columns?: TaskColumn[]
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
export interface ArchiveRequest {
  /** What it was, in a few words (ArchiveBatch.label). */
  label: string
  /** The column it was for; null: the whole board. */
  column: TaskColumn | null
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
   * A column move across workflow rules (#1265, SPEC §16.8.4), with why: the Assistant's, required when its move skips
   * a rule (else refused, naming them); the user's reason, optional. Never an agent's.
   */
  override?: { reason: string }
}

/**
 * What the window's move of a card came to (`tasks:move`, #1265): moved (the card as saved; `stopped`: it went only as
 * far as it could, the step after refused for what no override makes true, such as nothing to submit, §16.8.4), or a
 * question first (the rules the move would skip: nothing written; move again with `confirm`), or refused.
 */
export type TaskMoveResult = { moved: TaskCard; stopped?: Refusal } | { ask: string[] } | { refused: Refusal }

/** Which agent Start gives a card to. */
export type TaskStartTarget = { kind: 'agent'; agentId: string } | { kind: 'new-agent'; worktree: boolean; name?: string; provider?: ProviderId }

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

/** A project's workflow options as project.json keeps them (SPEC §16.6.6). */
export interface ProjectWorkflow {
  platform: PlatformId
  preset: PresetId | null
  options: WorkflowOptions
}

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
   * The workspace's MCP servers this project has on (#1093, its MCP tab): each runs here only while it is on in the
   * workspace too (mcpOnInProject). `disabled` is from before #1093 (a project turning off a server on for all
   * projects): read once when the workspace's settings are moved to #1093's model, then emptied.
   */
  mcp: { disabled: string[]; enabled: string[] }
  chime: 'inherit' | 'on' | 'off'
  /** The provider new agents get (Add Agent's quick add); inherit uses the global default. */
  defaultProvider: Inherit<ProviderId>
  /** The project's settings per provider, over the global ones. */
  providers: Record<ProviderId, ProjectProviderConfig>
  /** Overrides settings.sessions.compactSuggestTokens for this project; null inherits. */
  compactSuggestTokens: number | null
  /** Overrides settings.sessions.transcriptWarnMB for this project; null inherits. */
  transcriptWarnMB: number | null
  /** The project's agents, in the order they were added. All are equal; a new project has none. */
  agents: AgentDef[]
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
   * Folders that moved (an agent's worktree repaired or recreated at a new place) whose CLI data (copyPathData) isn't
   * all copied yet (#146): kept until a copy works, so Repair tries again, after a restart too.
   */
  pendingCopies?: { from: string; to: string; of: string; owner?: MoveOwner }[]
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
   * The project's workflow options (SPEC §16.6.6, OP-5): its platform, the preset they came from (null: set one by one,
   * or the upgrade's), and the options. The upgrade to 1.0 writes them from how the project works today (#1218, §16.17);
   * read-only in P3 (P4's Version Control tab edits them).
   */
  workflow?: ProjectWorkflow
  fileLocks: Inherit<FileLockMode>
  /** Overrides settings.agents.worktreeCopy; null inherits. */
  worktreeCopy: string | null
  /** Command run in a new worktree before its agent's first session, e.g. "npm install". */
  worktreeSetup: string
  /** Hive wakes a card loop's reviewer when a card arrives in Review, and its builder on a verdict (#405). */
  loopWakes: boolean
  /** Card loops' rounds and wait in hours for this project (#412); null inherits the workspace's. */
  loopRounds: number | null
  loopWaitHours: number | null
}

export interface ProjectProviderConfig {
  model: string // 'inherit' or a model alias / id
  effort: Inherit<EffortLevel>
  permissionMode: Inherit<PermissionMode>
  extraArgs: string
  /** 200K context instead of 1M (capabilities.contextLimit). */
  use200kContext: Inherit<'on' | 'off'>
}

/** A worktree an agent works in: its own checkout of the project on its own branch. */
export interface AgentWorktree {
  path: string
  branch: string
  /** Branch it was created from, and merges back into. */
  base: string
}

/** One of a project's agents (up to Agents per project, #562). Settings left undefined follow the project's. */
export interface AgentDef {
  /** Random and never reused, so session records of removed agents don't attach to new ones. */
  id: string
  name: string
  /** The CLI this agent runs. Always stored when the agent is added. */
  provider?: ProviderId
  worktree?: AgentWorktree
  model?: string
  effort?: EffortLevel
  permissionMode?: PermissionMode
  /** 200K context instead of 1M (capabilities.contextLimit). */
  use200kContext?: boolean
  /** Session to resume for this agent. */
  lastSessionId?: string
  /** The worktree's setup command hasn't run successfully yet. */
  needsSetup?: boolean
  /** The Hive Assistant only: this workspace's mode, over Settings → Assistant. */
  mode?: string
  /** What the agent is for ("builder", "reviewer"; free text, #126): saved in templates; empty, its name is its role. */
  role?: string
  /**
   * Only these of the project's MCP servers (#537, shared/agentMcp.ts), saved in templates; absent: all of them. The
   * built-in hive server is given whatever this says.
   */
  mcpServers?: string[]
}

/** A change to an agent's settings: empty values (null for use200kContext and mcpServers) clear an override so it follows the project. */
export type AgentPatch = Partial<Pick<AgentDef, 'name' | 'provider' | 'model' | 'effort' | 'permissionMode' | 'mode' | 'role'>> & { use200kContext?: boolean | null; mcpServers?: string[] | null }

/** What loading a template into a project would do (#126), and what stops it now. */
/**
 * What happened to an old worktree the user chose to remove with a template's load (#289, #313): `removed` (the folder
 * went), and `branchKept` when its branch stayed all the same (a ref moved in the last step); `why` it was kept, or why
 * the branch was.
 */
export interface OldWorktreeOutcome {
  branch: string
  removed: boolean
  branchKept?: true
  why?: string
}

export interface TemplateLoadPlan {
  scope: TemplateScope
  file: string
  name: string
  layout: PageLayout
  /** The project's agents, all removed: running ones and uncommitted worktree work block the load. */
  remove: { id: string; name: string; running: boolean; dirty: number; worktree?: { path: string; branch: string } }[]
  /** The agents it creates, with the names chosen in the dialog (#702) when it gave some. */
  create: TemplateAgent[]
  /** The template's own names for them, by `create`'s order: what a prefix goes in front of (#702). */
  templateNames: string[]
  /** Created names another project's agent has (#702): the load is refused until they are renamed. */
  taken: { name: string; project: string }[]
  /**
   * Where each created agent's worktree is (#268), by `create`'s order: a branch in this project's repository and a folder
   * in its worktree location; null for an agent in the project folder. `reuse`: a clean worktree of that name it works in
   * again, its branch left as it is (#289); else a new one, with `notReused` saying why the one of that name can't be.
   */
  worktrees: ({ branch: string; path: string; base: string; reuse?: true; notReused?: string } | null)[]
  /**
   * The removed agents' worktrees no created agent works in again (#289): `removable` when merged into the main branch
   * (`mergedInto`) and clean (`worktreeCheck`), which the load can remove with their branches if asked; else kept, `why`.
   */
  oldWorktrees: { agent: string; path: string; branch: string; removable: boolean; why?: string }[]
  /** The main branch the old worktrees were checked against: a removal is refused if it is another by then. */
  mergedInto: string | null
  /** The project's worktree setup command, which each new worktree runs before its agent first starts (null: none). */
  setup: string | null
  /** Providers the template needs that are off or not installed, and which of its agents need each. */
  missing: { provider: ProviderId; reason: string; agents: string[]; problem?: 'unknown' | 'off' | 'notInstalled' }[]
  /** Why it can't be loaded now (empty: it can). */
  blocked: string[]
}

export interface AgentInfo extends AgentDef {
  live: LiveSessionState | null
  restartNeeded: boolean
  /** The session Resume opens for this agent while it isn't running (null: nothing to resume). */
  resume: ResumeTarget | null
}

export interface ResumeTarget {
  id: string
  name: string
  lastActiveAt: string
  createdAt?: string
  titleAtRename?: string | null
}

export interface AddAgentOptions {
  name?: string
  location: 'project' | 'new-worktree' | 'existing-worktree'
  /** new-worktree: branch to create (default hive/<workspace>/<project>/<name>, #703) and the branch to base it on (default the current one). */
  branch?: string
  base?: string
  /** existing-worktree: its folder. */
  worktreePath?: string
  provider?: ProviderId
  model?: string
  effort?: EffortLevel
  permissionMode?: PermissionMode
  use200kContext?: boolean
  role?: string
  /** Only these of the project's MCP servers (#537); absent: all of them. */
  mcpServers?: string[]
  /**
   * #456: new-worktree, work in the project's unused worktree on that branch instead when it is merged into the base and
   * clean, brought up to the base; existing-worktree, bring the one chosen up to the base when it is merged and clean.
   * The Add Agent dialog and the Agent API ask for it; templates reuse their own way (#289).
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
  /** The worktree and branch were removed afterwards. */
  cleanedUp?: boolean
  /** An unused worktree's merge asked to remove it afterwards, but it was kept: why (#400). */
  cleanupKept?: string
  /** After a squash merge, the agent's branch was moved to the merged branch; or why it wasn't. */
  branchMoved?: boolean
  moveError?: string
}

export interface SessionRecord {
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
  /** Folder it ran in, when not the project folder (a worktree). Claude Code files transcripts by folder. */
  cwd?: string
  branch?: string
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
  changes: ('column' | 'comment' | 'verdict' | 'agent' | 'blocked')[]
  column?: TaskColumn
  /** An agent watch's agents, by name (#416: its cards are none). */
  agents?: string[]
  /** A lane watch's lanes, by id, or ["all"] (#531; its cards are those beside the lanes, #726). */
  lanes?: string[]
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

export interface LiveSessionState {
  provider: ProviderId
  /** This launch, until the process exits; hooks name it so they reach the right agent. */
  runId: string
  projectPath: string
  /** Which of the project's agents this is. */
  agentId: string
  agentName?: string
  /** Folder the session runs in: the project folder or the agent's worktree. */
  cwd: string
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
  pid?: number
  startedAt: string
  /** Effective settings the session launched with — used to detect "restart to apply". */
  launchSignature: string
  /**
   * What it was given at launch (GET /v1/projects/{name}): Hive's guidance revision, the content hash of each Hive skill's
   * copy it reads, and why a skill isn't as asked for (a folder of the user's has its name, an old copy kept while in use).
   */
  launched?: { guidance: string; skills: Record<string, string>; problems?: Record<string, string> }
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
export interface WorkspaceMoved {
  /** The workspace's old folder; null when only projects moved (renamed or moved in from elsewhere). */
  from: string | null
  /** The projects that moved, by name. */
  projects: string[]
  /** Projects that didn't move but have a worktree's sessions or data still to follow it to a new folder (#146). */
  pending: string[]
  /**
   * Cards left under a project's old name (#508): saved before projects had ids, by a project renamed or moved since.
   * Repair gives them to the project they belong to now. Absent when there are none.
   */
  cards?: MoveCards[]
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
}

/**
 * An agent's worktree whose links need repairing. moved: found at a new place; stayed: still where it was (outside the
 * moved folder), its links to the repository repaired; located: the folder the user picked; missing: not found
 * (Recreate, Locate… or Remove the link); recreate: to be made again on its branch, or new from its base when the
 * branch is gone (`to`: where, if that place can be used); unlink: the agent's worktree link is to be removed;
 * original: the project is still at its old folder too (a copy), which keeps the worktree.
 */
export interface MoveWorktree {
  agentId: string
  agentName: string
  from: string
  to: string | null
  how: 'moved' | 'stayed' | 'located' | 'missing' | 'recreate' | 'unlink' | 'original'
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
}

/** What Repair did: each line a step, for the dialog and the log. */
export interface MoveReport {
  done: string[]
  skipped: string[]
  failed: string[]
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
  [key: string]: unknown
}

export interface McpServerInfo {
  name: string
  path: string
  def: McpServerDef | null
  /** In English, or the reason a read failed as Node gave it; `errorText` is Hive's own as the window shows it (#845). */
  error?: string
  errorText?: Text
  /** On in the workspace (#1093, its master switch): it runs in the projects that have it on, and nowhere while off. */
  globallyEnabled: boolean
  secretWarnings: string[]
  /** What it runs, shown before it is enabled (#550): the command or URL, folder, environment and header names. */
  runs: string[]
  /** Which copy of its definition this is (a replace or an edit changes it): an enable says which it showed. */
  revision?: string
}

/** The server an enable showed the user (#550): refused if its definition has been replaced or edited since. */
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
  /** Files pasted or dropped into sessions (.hive/attachments). */
  attachments: number
  /** The agents' worktree folders. */
  worktrees: { agent: string; path: string; bytes: number }[]
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
  /** Short notes Agent Setup shows under the sign-in (Copilot's Free plan runs Auto only). */
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
  /** Shown in Agent Setup with the button: what the task will ask and how to choose (paragraphs, `code` allowed). */
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
  kind: 'text' | 'binary' | 'too-large'
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
}

export interface ToastMessage {
  id: string
  level: ToastLevel
  title: string
  message?: string
  actions?: ToastAction[]
  timestamp: string
  source?: string
  /** Kept in the Notifications panel (the bell) only, not shown as a toast: a notice told another way, or not at all (#157). */
  quiet?: boolean
  /** How long the toast stays (ms), when not the usual for its kind (an Undo's ~10 s, #351). */
  timeoutMs?: number
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

/** Events pushed from main to renderer. */
export type HiveEvent =
  | { type: 'workspace-changed'; workspace: WorkspaceInfo | null }
  /** The recent workspaces changed (opened, removed, cleared): each window asks for its own view of them (#144). */
  | { type: 'recent-changed' }
  | { type: 'session-status'; state: LiveSessionState }
  /** `failure`: the CLI exited before its session started (and nobody stopped it): why, for the agent's pane. */
  | { type: 'session-exit'; projectPath: string; agentId: string; sessionId: string; exitCode: number; failure?: StartFailure }
  /** What an agent's stopped launches left running changed (#507): found, ended, kept, or ended by themselves (no processes). */
  | { type: 'agent-leftovers'; leftovers: AgentLeftovers }
  | { type: 'toast'; toast: ToastMessage }
  | { type: 'chime'; projectPath: string; silent?: boolean }
  | { type: 'settings-changed'; settings: AppSettings }
  /** Advanced settings (#367) changed: an override, advanced.json, a workspace's own or an installed CLI's version. */
  | { type: 'advanced-changed' }
  /** One project's view preference saved (ui:setProjectPref): every window's store follows. */
  | { type: 'ui-pref-changed'; pref: ProjectPref; project: string; value: unknown }
  /** What the tips know changed (ui:changeTips): every window's store follows. */
  | { type: 'tips-changed'; tips: TipsState }
  | { type: 'provider-install'; provider: ProviderId; info: AgentInstallInfo }
  /** Whether git runs changed (#346): every window's store follows. */
  | { type: 'git-tool'; git: GitTool }
  | { type: 'menu-command'; command: string; args?: unknown[] }
  | { type: 'usage-changed'; projectPath: string; sessionId: string }
  /** A workspace's usage history: its one-time import of existing sessions under way, or done (#1106). */
  | { type: 'usage-history'; workspacePath: string; progress: UsageHistoryProgress }
  | { type: 'notes-changed' }
  /** The workspace's task board changed (its path names the window). */
  | { type: 'tasks-changed'; workspacePath: string }
  /** Quitting needs the user's decision: the renderer shows the quit dialog and answers with app:quitDecision. */
  | { type: 'quit-request'; sessions: QuitSession[]; unsaved: string[]; /** Anything but 'app' stops only this window's workspace's sessions. */ scope?: QuitScope }
  /** Hive is waiting for working agents to finish before quitting (or stopped waiting). */
  | { type: 'quit-pending'; pending: boolean; working: number }
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
  /** A worktree agent's unmerged work changed (null: git couldn't check it). */
  | { type: 'branch-status'; projectPath: string; agentId: string; status: AgentBranchStatus | null }
  | { type: 'plan-usage'; provider: ProviderId; usage: PlanUsage }
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
}

export interface LaneInfo {
  id: string
  /** The project's folder name. */
  project: string
  name: string | null
  builder: { id: string; name: string }
  reviewer: { id: string; name: string } | null
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
}

/** Who reported a progress run: a project agent (by its token), the Hive Assistant, or a script with the workspace token. */
export type ProgressSource = 'agent' | 'assistant' | 'api'

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
   * for a kept run with no name. The window shows it in its language; the Agent API leaves this out (publicRun).
   */
  defaultName?: 'script' | 'agent'
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
}

/** Why a run doesn't count as a check (SPEC §16.13), as its `CheckRan` says. */
export type CheckWhyNot = 'notCheck' | 'notContained' | 'dirty' | 'changed' | 'moved' | 'revisionChanged'

/** How a run counted as a check: the check's name, and why not when it didn't. */
export interface RunCheck {
  name: string
  counted: boolean
  whyNot?: CheckWhyNot
}
