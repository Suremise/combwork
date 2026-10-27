import { DEFAULT_PERF_FILTERS, type PerfFilters } from '@shared/metricsView'
import { create } from 'zustand'
import { useMemo, type ReactNode } from 'react'
import type { Period } from '@shared/usageTotals'
import type { StartFailure } from '@shared/startFailure'
import { cardLabel, setCardNaming } from '@shared/projectKeys'
import type { AdvancedState } from '@shared/advanced'
import type { StageId } from '@shared/workflow/facts'
import type { AgentLeftovers } from '@shared/agentProcesses'
import { EMPTY_TIPS_STATE, type TipsState } from '@shared/tips'
import { agentPtyKey, agentsPerPage, layoutFitting, layoutPanes, mostUrgent, projectLayout, projectSessionView } from '@shared/defaults'
import { cellPage, cellPageCount, pageCells, pageIds, placedCells, type PaneCells } from '@shared/paneCells'
import { projectAgentStates, type AgentState } from '@shared/agentState'
import { tileOrder, tilePageOf, tilePageShown, tilesOnPage } from '@shared/tiles'
import { agentProvider, providersInUse, providerWarnings, setInstalledCheck } from '@shared/providers'
import { setDateStyle } from '@shared/dates'
import { language as shownLanguage, msg, onLanguageChange, tr } from '@shared/i18n'
import { chooseFocus, deferredFocus } from './deferredFocus'
import type { ProjectTab } from '@shared/projectTabs'
import type { VcSection } from '@shared/gitRepo'
import type { ProgressFilter } from '@shared/progress'
import type { TemplateAgent, TemplateRef } from '@shared/templates'
import type { GitTool } from '@shared/gitTool'
import type { RunsFilter } from '@shared/progressTabs'
import { loadActivityView, saveActivityView, type ActivityView } from './activityView'
import { cardWorker } from '@shared/activity'
import { boardReader } from './boardReads'
import type { AgentBranchStatus, AssistantPanelSide, BoardFold, BoardState, PageLayout, ProjectStages, QuitScope, SessionBulkProgress, SessionLayout, TaskCard, TaskColumn, UpdateState, WorkflowForm, WorkspaceUsage, RecentWorkspace } from '@shared/types'
import type { PresetId } from '@shared/workflow/options'
import type {
  AgentApiInfo,
  AgentInfo,
  AssistantAction,
  AssistantChangeGroup,
  AssistantUndoResult,
  AssistantQuestion,
  ProgressRun,
  MergeSlotInfo,
  LaneInfo,
  AgentInstallInfo,
  ProviderId,
  AppInfo,
  AppSettings,
  LiveSessionState,
  PlanUsage,
  ProjectInfo,
  QuitSession,
  ToastMessage,
  Notice,
  OpenProgress,
  WorkspaceInfo
} from '@shared/types'
import type { QueueView } from '@shared/workflow/queue'
import type { KeptReturn } from '@shared/progressQueue'
import type { SessionAction } from './util'
import { storeUpdated } from './pageMarks'
import { keepSame } from '@shared/keepSame'
import { rememberTab, shownTab } from '@shared/tabs'

export type Activity = 'projects' | 'overview' | 'performance' | 'board' | 'notes' | 'skills' | 'templates' | 'mcp' | 'assistant' | 'docs' | 'settings'
export type { ProjectTab } from '@shared/projectTabs'

/**
 * A template agent's Agent Settings (#271): `agent` to edit (null: a new one, named `suggestedName`), the template's other
 * agents (names to keep unique, roles to suggest), the project whose settings an empty choice shows (a project's
 * Templates tab; none in the Templates view), and where the answer goes (the agent as saved, or null: cancelled).
 */
/** A template being edited (#510): its revision and content as saved (what a save expects there), and the draft. */
/** A template being edited: `pairs` by the agents' places (#1440), so they follow a move, a removal or a renumbering. */
export type TemplateDraft = { name: string; description: string; layout: PageLayout; agents: TemplateAgent[]; pairs?: { builder: number; reviewer: number }[] }
export interface TemplateEdit {
  /** The template (where it is kept). */
  ref: TemplateRef
  savedAt: string | null
  /** The revision this editor's last save replaced: the list shows it until it reads the template again. */
  was?: string | null
  saved: TemplateDraft
  draft: TemplateDraft
}

export interface TemplateAgentRequest {
  key: number
  template: string
  agent: TemplateAgent | null
  suggestedName: string
  others: TemplateAgent[]
  project?: string
  resolve: (agent: TemplateAgent | null) => void
}

/**
 * Archive All in a column, or Archive All Cards (column null), as the board shows them (#351): the project it shows
 * (null: every project) and its search. `scope` is the board it is part of (a project's Tasks tab: that project; the
 * Board view: null, its project choice being a filter): when the filter or search hides some of those cards, only the
 * cards shown are archived.
 */
export interface ArchiveAllRequest {
  column: TaskColumn | null
  /** A stage column's (#1420: Approved beside Merging): only cards in that stage, named as the column is (`name`). */
  stage?: StageId
  name?: string
  project: string | null
  scope: string | null
  query: string
}

export interface ConfirmRequest {
  kind: 'confirm'
  title: string
  message: string
  /** Items (paths) under the message, one per line, with a Copy button (#347): never lines joined into message. */
  list?: readonly string[]
  /** The list is to read, not to copy (a CLI's clipboard text Hive asks about, #1292): no Copy button. */
  listOnly?: boolean
  /** The list is text as it was written (a CLI's clipboard text, #1292): monospace, its spacing kept, even with listOnly. */
  listMono?: boolean
  detail?: string
  /** A long detail scrolls in its own box, the dialog's buttons staying in view (a template's agents, #268). */
  scrollDetail?: boolean
  /** Shown in the detail's place, rendered (a template's plan as a table, #511), in a wider dialog with `wide`. */
  content?: ReactNode
  wide?: boolean
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  /** The session action it confirms (Stop, Remove…): the confirm button takes its colour (#344). */
  action?: SessionAction
  /** The action, run with the dialog open (a spinner, no closing) until it's done: a failure stays in the dialog. */
  run?: () => Promise<unknown>
  /** The confirm button's label while `run` runs ("Deleting…"). */
  busyLabel?: string
  /** A tick box under the detail; `set` gets the user's choice before the dialog resolves (confirmed or not). */
  check?: { label: string; initial: boolean; set: (checked: boolean) => void }
  resolve: (ok: boolean) => void
}

export interface PromptRequest {
  kind: 'prompt'
  title: string
  message?: string
  placeholder?: string
  initial?: string
  confirmLabel?: string
  validate?: (value: string) => string | null
  /** Items under the message, one per line, with a Copy button (what an MCP server runs, #550). */
  list?: readonly string[]
  /** The list is to read, not to copy (the rules a move skips, #1275): no Copy button. */
  listOnly?: boolean
  /** Under the list: what else to know (warnings). */
  detail?: string
  /** The field's label, above it (and its accessible name): "Reason (optional)". */
  fieldLabel?: string
  /** A tick box under the field; `set` gets the user's choice before the dialog resolves. */
  check?: { label: string; initial: boolean; set: (checked: boolean) => void }
  /** A second tick box under the first (Save Template's "Use the project key in names", #1440), alike. */
  check2?: { label: string; initial: boolean; set: (checked: boolean) => void }
  /** A drop-down under the field (where to turn a new MCP server on, #713); `set` gets the pick before the dialog resolves with a value. */
  select?: { label: string; options: { label: string; value: string }[]; initial: string; set: (value: string) => void }
  /**
   * A second box under the field (a new project's key, #1221): it follows the field (`follow`) until the user types in
   * it, is checked as it changes (`validate`: why it can't be, or null), and `set` gets it before the dialog resolves.
   */
  second?: { label: string; hint?: (second: string) => string; follow: (value: string) => string; validate: (second: string) => string | null; set: (second: string) => void }
  resolve: (value: string | null) => void
}

/** A question with several answers (buttons); Esc or × cancels (null). */
export interface ChoiceRequest {
  kind: 'choice'
  title: string
  message: string
  detail?: string
  danger?: boolean
  /** Buttons left to right; the last is the default. A session action's button takes its colour (#344). */
  choices: { label: string; value: string; action?: SessionAction }[]
  /** A drop-down above the buttons (where to put something); `set` gets the user's pick before the dialog resolves with a button. */
  select?: { label: string; options: { label: string; value: string }[]; initial: string; set: (value: string) => void }
  resolve: (value: string | null) => void
}

export type DialogRequest = ConfirmRequest | PromptRequest | ChoiceRequest

/**
 * A card the user moves into Doing (a drag, Move to, or the card dialog's Column): the Move to Doing dialog asks
 * whether nobody has it, an agent, or an agent that starts on it, and makes the change. project and agent: as the
 * user has them (the card dialog's unsaved fields). before: where a drag dropped it. prepare: saves the card dialog's
 * other edits first, once the user has chosen; done: after the change.
 */
export interface DoingRequest {
  n: number
  project: string
  agent: string | null
  before?: number | null
  prepare?: () => Promise<void>
  done?: () => void
}

interface State {
  settings: AppSettings | null
  /** Settings → Advanced (#367): advanced.json's overrides, this window's workspace's own values and the installed CLIs. */
  advanced: AdvancedState | null
  /** Moves on each time main says Hive's accounts changed (HI-980): Settings → Accounts reads them again. */
  connectionsChanged: number
  workspace: WorkspaceInfo | null
  /** The recent workspaces as this window sees them (#144). */
  recent: RecentWorkspace[]
  /** This window's workspace opening, its step now (HI-1694), or null. */
  openProgress: OpenProgress | null
  /** Each provider's installed CLI (install state, version, sign-in, readiness). */
  providers: Record<ProviderId, AgentInstallInfo>
  /** Whether git itself runs (#346); null until asked. */
  gitTool: GitTool | null
  /** Subscription limits each provider last reported (account-wide), by provider. */
  planUsage: Record<ProviderId, PlanUsage>
  /** Subscription limits each connection's sessions last reported (that login's own, HI-1756), by connection id. */
  connectionPlanUsage: Record<string, PlanUsage>
  /** Worktree agents' unmerged work, by projectKey (null: git couldn't check it). */
  branchStatus: Record<string, AgentBranchStatus | null>
  /** Agents whose CLI exited before its session started, by projectKey: why, until the next launch or ✕. */
  startFailures: Record<string, StartFailure>
  /** What agents' stopped launches left running, by projectKey (#507): until ended, kept, or they end. */
  leftovers: Record<string, AgentLeftovers>
  /** What the tips know (saved in the profile), the tip in the card, and whether Help → Tips… is open. */
  tips: TipsState
  tipShown: string | null
  tipsOpen: boolean
  api: AgentApiInfo | null
  appInfo: AppInfo | null
  /** The language Hive shows (#767): components render again when it changes (useLanguage). */
  language: string

  activity: Activity
  lastSideActivity: Exclude<Activity, 'docs' | 'settings'>
  sidebarVisible: boolean
  sidebarWidth: number
  /** Projects sidebar collapsed to a rail of status dots. */
  sidebarCompact: boolean
  /**
   * The Projects sidebar folded to its rail for now (HI-1737): the window too narrow for it beside the side panels and
   * the work (layoutRoom.ts). Never saved; `sidebarUnfolded`: the user's Expand Sidebar meanwhile, until there's room.
   */
  sidebarFolded: boolean
  sidebarUnfolded: boolean
  /**
   * The Progress panel folded to its strip for now (HI-1737, the Assistant's rule): the work short of its least width
   * even with the sidebar given way. Never saved (the panel stays open in what is kept); `progressUnfolded`: the user
   * opened it meanwhile, until there's room.
   */
  progressFolded: boolean
  progressUnfolded: boolean
  /** Set to select a session in its project's Sessions tab. */
  /** Open the Sessions tab on a session, and in it at its nth compaction (from 0, oldest first) when given. */
  sessionsJump: { project: string; id: string; nonce: number; compaction?: number } | null
  /** A link into a project's Attachments tab (HI-1841): its tab, at a card's or a session's files; cleared once shown. */
  attachmentsJump: AttachmentsJump | null
  /** The Activity tab's view per project (#1254, HI-1677): its range, agents' and cards' filters, Hide finished, paused by hand. */
  activityFilters: Record<string, ActivityView>
  /** A file to show in a project's Files tab (a terminal's file link): whose folder (`root`, a worktree agent's id or ''), the file and the line. */
  filesJump: { project: string; root: string; rel: string; line?: number; col?: number; nonce: number } | null
  /** Resizable pane sizes, saved with the window layout. */
  panes: Record<string, number>
  /** The provider each project's Skills tab last showed, by project path in lower case (#118; saved in ui). */
  skillsProvider: Record<string, string>
  /** Each project's Skills tab groups, open or folded as last left (#118; saved in ui). */
  skillsFold: Record<string, { hive?: boolean; provider?: boolean }>
  sessionsTree: Record<string, Record<string, boolean>>
  hiveVcsNotice: Record<string, string>
  assistantFold: Record<string, boolean>
  /** Each workspace's board: collapsed columns and folded cards (#170; saved in ui), by workspace path in lower case. */
  boardFold: Record<string, BoardFold>
  /** Each workspace's Progress panel filter (#251; saved in ui), by workspace path in lower case. */
  progressFilter: Record<string, ProgressFilter>
  /** Each workspace's running lanes in the user's order (#568; saved in ui), lane ids by workspace path in lower case. */
  laneOrder: Record<string, string[]>
  /** The tab each remembered row of tabs last showed (HI-1837; saved in ui), by the row's key. */
  tabs: Record<string, string>
  selectedProject: string | null
  projectTabs: Record<string, ProjectTab>
  selectedNote: string | null
  selectedSkill: string | null
  /** The template the Templates view shows (templateKey), and which ones its list shows: all, workspace or a project's path. */
  selectedTemplate: string | null
  templateFilter: string
  /** A Hive skill to open for editing (not preview) when the Skills view shows it: from a project's Edit in workspace. */
  skillEdit: string | null
  selectedMcp: string | null
  /** The mode open in the Modes view (its file). */
  selectedMode: string | null
  /** What the Assistant view's main area shows: its conversations or the selected mode. */
  /** 'images' is its Attachments (#387; the id from before, kept). */
  /** The Assistant view's main area: its conversations, a mode, its attachments, its journal or the journal's weekly digests (#1033). */
  assistantSection: 'conversations' | 'modes' | 'images' | 'journal' | 'digests'
  /** Bumped when this window's workspace's Assistant journal changes (#1033): its browser reads it again. */
  journalVersion: number
  /** The Hive Assistant's panel is shown (per workspace, saved in the pane sizes as assistant-open:<path>). */
  assistantOpen: boolean
  /** This window's workspace's progress runs (newest first), for the Progress panel. */
  progressRuns: ProgressRun[]
  /** This window's workspace's merge slots (#350): those held or waited for. */
  mergeSlots: MergeSlotInfo[]
  /** This window's workspace's merge queues (#1356), every project's, as `queue:list` gives them (queueSource.ts). */
  queues: QueueView[]
  /** The returns this window showed and marked seen, kept until their own 10 s are up (#1356 round 6: queueSource.ts). */
  queueKept: KeptReturn[]
  /** Bumped on each `queue-changed` (#1357): the card's Work section and the Git tab's Merge queue section read again. */
  queueVersion: number
  /** Bumped on each `workflow-changed` (#1417): views that show a project's stages (`workflow:stages`) read them again. */
  workflowVersion: number
  /** This window's workspace's lanes (#483), for the Progress panel (#484): running ones and those ended lately. */
  lanes: LaneInfo[]
  /** A pane (an agent's, or the Assistant's panel) briefly highlighted because something asked to show it: its pty key. */
  paneFlash: { key: string; at: number } | null
  /** How many panes fit side by side in the Session tab at its width now (#1037), each wide enough for a terminal; null before it is measured. */
  paneColumns: number | null
  /**
   * How wide the focus view's strip may be beside a pane wide enough for a terminal (#1037): 0 hides it; null before it
   * is measured. Its chosen width (#1021) is kept, and shown again once there is room.
   */
  tileStripRoom: number | null
  /** Assistant Settings is open. */
  assistantSettingsOpen: boolean
  /** What the Hive Assistant did in this window's workspace (oldest first), and what it is asking the user. */
  assistantActions: AssistantAction[]
  assistantQuestions: AssistantQuestion[]
  /** The Assistant's changes kept for undo, by the user's message (#1283), and what each undo in this window did. */
  assistantChanges: AssistantChangeGroup[]
  assistantUndone: Record<string, AssistantUndoResult>
  /** Agents the Assistant added that the user hasn't looked at yet, by project path (their page's button shows a dot). */
  newAgents: Record<string, string[]>
  modesVersion: number
  docsPage: string
  /** The id of a heading of the shown doc to scroll to (Learn more on a tip, #1535), cleared once there. */
  docsAnchor: string | null
  settingsSection: string
  settingsQuery: string
  /** Settings' Modified only (Settings → Advanced's list follows it too, #367). */
  settingsModifiedOnly: boolean

  toasts: ToastMessage[]
  /** In-app banners showing in this window (components/NoticeBanners.tsx), the newest first. */
  notices: Notice[]
  notifications: ToastMessage[]
  unread: number
  showNotifications: boolean
  /** The status bar's attention inbox popover. */
  inboxOpen: boolean
  paletteOpen: boolean
  /** What the palette lists: every command and project, or projects only (Go to Project). */
  paletteMode: 'commands' | 'projects'
  /** The permission mode menu, open for an agent at a point. */
  modeMenu: { project: string; agentId: string; x: number; y: number; above?: number } | null
  /** A shortcut is being recorded in the keyboard shortcuts editor: app shortcuts are paused. */
  recordingKeys: boolean
  aboutOpen: boolean
  /** Help → Copy Diagnostics: the preview dialog. */
  diagnosticsOpen: boolean
  /** Hive's own update state, and whether its dialog is open. */
  update: UpdateState | null
  updateOpen: boolean
  /** The Agent Setup dialog, open at a provider (or at the first one). */
  setupOpen: ProviderId | true | false
  /** Repair… for a moved workspace (#146), and the move whose banner was hidden (until Hive restarts). */
  moveRepairOpen: boolean
  /** The Review… dialog for cards an older Hive saved (#1044). */
  setAsideOpen: boolean
  moveBannerHidden: string | null
  shortcutsOpen: boolean
  dialog: DialogRequest | null
  /** Why the open confirm can't be confirmed yet, set by its content (#702: a template's names that clash): its button is greyed out. */
  dialogBlocked: string | null
  /** Sessions listed in the quit dialog while main waits for a decision. */
  quitRequest: QuitSession[] | null
  /** Files with unsaved edits listed in the quit dialog (absolute paths). */
  quitUnsaved: string[]
  /** 'window': the dialog is for closing this window (its workspace's sessions), not quitting Hive. */
  quitScope: QuitScope
  /** Hive will quit once no agent is working. */
  quitPending: { working: number } | null
  /** How many Hive windows are open (File → Exit closes them all). */
  windowCount: number
  /** Working agents keeping the PC awake (0: none). */
  keepAwake: number
  /** Bulk actions under way on hosts' sessions, by host path lower-cased (#1659): none, no entry. */
  sessionBulk: Record<string, SessionBulkProgress[]>
  /** The agent whose Compact dialog is open. */
  compactFor: AgentRef | null
  /** Project whose Add Agent dialog is open. */
  addAgentFor: string | null
  /** Agent whose settings dialog (name, model, effort, permission mode) is open. */
  agentSettingsFor: AgentRef | null
  /** The Agent Settings dialog for a template's agent (#271): open while set; it answers the template editor. */
  templateAgentFor: TemplateAgentRequest | null
  /**
   * Template editors open in this window (#510), by workspace and template (templateEditKey): the template as saved and
   * the draft. Kept while the window is open, so leaving the editor (another template, another view) loses nothing: it
   * opens again with its changes, and the list marks a template with changes not saved.
   */
  templateEdits: Record<string, TemplateEdit>
  /** Worktree agent whose Merge dialog is open. */
  mergeFor: AgentRef | null
  /** The Merge dialog for merges outside cards (#1450): its project, and the branch it opened on (else the first). */
  branchMergeFor: { project: string; branch?: string } | null
  /** The project whose Initialise repository dialog is open (#701): kept while the Git tab changes under it. */
  gitInitFor: string | null
  /** The agent whose work "Hand Over to…" hands to another agent. */
  handOverFor: AgentRef | null
  /** Shows this agent's session in its project's Overview and scrolls to it (the footer's context count); `at` makes each click count. */
  /** Open the Overview on an agent's session, at its compaction history (the footer's context) or its details (its cost). */
  overviewJump: (AgentRef & { at: number; target?: 'history' | 'session' }) | null
  /** Opens Project Settings on this section (Settings → Workspace's Storage links); `at` makes each click count. */
  projectSettingsJump: { project: string; section: string; at: number } | null
  /** Per project: the agent that session commands (header buttons, shortcuts, Insert into Session) act on. */
  focusedAgent: Record<string, string>
  /** An agent being dragged (its strip tab or pane header) to move it in its project's order. */
  agentDrag: { project: string; id: string } | null
  /** Said to screen readers when a pane moves from the keyboard (#762); `n` counts them, so the same words are said again. */
  paneSaid: { text: string; n: number } | null
  /** Actions without a dialog that are running (runOnce): their buttons show a spinner and ignore clicks. */
  running: Record<string, true>
  /** Agents whose session is starting or resuming ("<path>#<agent>", startingKey), from the click until it runs or fails: their buttons show it (#1177). */
  starting: Record<string, Starting>
  /** Per project and agent page ("<path>#<page>"): the agent last focused there, focused again on going back. */
  pageFocus: Record<string, string>
  /** Per project, in the Tiles view (#976): the agent its focus view shows (none: the grid of tiles). */
  tileFocus: Record<string, string>
  /** Per project: the page of tiles the Tiles view shows (from 0). */
  tilePage: Record<string, number>
  /**
   * Per project: whose folder the Changes and Files tabs show (a worktree agent's id; anything else = the project
   * folder). Changes also takes an unused worktree (#400): `unused:<its folder>`, or `unused` for the list of them all.
   */
  changesRoot: Record<string, string>
  /** Per project: the Version Control tab's section shown (#607, #1416; none: Changes for Git, Workflow for None). */
  vcSection: Record<string, VcSection>
  /** "How do you work?"'s Customise… (#1423): the Workflow section opens with this preset filled in, not saved. */
  workflowPrefill: { path: string; preset: PresetId } | null
  /** Projects added from this window (Add Project, New Project): their Version Control tab shows the step, so no notice (#1423). */
  presetStepShown: string[]
  /** Per project: bumped after a Git action in this window, so the Version Control tab and the status bar read git again. */
  gitVersion: Record<string, number>
  /** Per project: bumped when its unused worktrees change outside the list (a merge of one, #400): the list reloads. */
  unusedVersion: Record<string, number>
  filesRoot: Record<string, string>

  /** The workspace's task board (archived cards too), and the board view's filters. */
  tasks: TaskCard[]
  /**
   * Bumped by each read of the board (HI-1859): a change that writes only a card's facts (an agent's refusal) leaves
   * `tasks` the same object (keepSame, HI-1806), so what is made from the facts (the work badges, a card's work) reads
   * again on this.
   */
  boardReads: number
  /** Whether the board is read-only and why, and its kept 0.9 copy (#1207): read with the board. */
  boardState: BoardState | null
  /**
   * Every project's stages for the board's columns (`board:stages`, HI-1682), by path in lower case: read with the
   * board when what they were read for (`for`, boardStagesFor) has changed, so its columns come with its cards.
   */
  boardStages: { for: string; byPath: Record<string, ProjectStages | null>; forms: Record<string, WorkflowForm> } | null
  /** Each project's key and its old keys (#1221), read with the board (a key change is a board change). */
  projectKeys: ProjectKeys[]
  /** The names moved cards keep in the projects they left (`HI-1` → card), read with the board too (#1221). */
  movedCardNames: Record<string, number>
  /**
   * The Performance view's filters (activity bar: the workspace, a project filter) and each project's Performance tab's
   * (fixed to that project), kept while you move around.
   */
  perfWorkspace: PerfFilters
  perfProjects: Record<string, PerfFilters>
  /** The Workspace Overview's period, and the workspace's usage it last loaded (with when). */
  overviewPeriod: Period
  workspaceUsage: WorkspaceUsage | null
  workspaceUsageAt: number
  /** Why its last load failed (for that workspace), shown with Retry in place of, or over, the last figures. */
  workspaceUsageError: { workspacePath: string; error: string } | null
  /** The Board view's filter: a project's folder name, '' for workspace cards, null for all. */
  boardProject: string | null
  boardQuery: string
  boardArchived: boolean
  /** The Task Board shows only the cards something waits on the user for (#1276). */
  boardForYou: boolean
  /** The card open in the card dialog, or a new card (with the project it's for). */
  taskOpen: number | { project: string } | null
  /** The card whose Start dialog is open. */
  taskStartFor: number | null
  /** Start lane… (#1280): open for a project (its path; null: the first with agents), with these cards chosen first. */
  laneStartFor: { project: string | null; cards: number[] } | null
  /** The Progress panel's Runs tab asked for with this filter (#1446: what a lane waits for); the panel takes it and clears it. */
  runsShow: RunsFilter | null
  /** The Archive All dialog (#351): a column's (or the whole board's, column null) cards as the board shows them. */
  boardArchiveAll: ArchiveAllRequest | null
  /** A card being moved to Doing: the Move to Doing dialog asks who has it. */
  taskDoing: DoingRequest | null
  /** The project whose Remove Project dialog is open. */
  removeProjectFor: string | null

  windowFocused: boolean
  maximized: boolean
  /** This window is Always on Top (pin.ts in main). */
  alwaysOnTop: boolean
  notesVersion: number
  skillsVersion: number
  /** Bumped when this window changes a template (saved, renamed, imported…): its lists read them again. */
  templatesVersion: number
  usageVersion: Record<string, number>
  /** Incremented per agent terminal (pty key) whenever a new session starts, so its terminal is recreated. */
  sessionEpoch: Record<string, number>
}

export const useStore = create<State>(() => ({
  settings: null,
  advanced: null,
  connectionsChanged: 0,
  workspace: null,
  recent: [],
  openProgress: null,
  providers: {},
  gitTool: null,
  planUsage: {},
  connectionPlanUsage: {},
  branchStatus: {},
  startFailures: {},
  leftovers: {},
  tips: EMPTY_TIPS_STATE,
  tipShown: null,
  tipsOpen: false,
  api: null,
  appInfo: null,
  language: shownLanguage(),

  activity: 'projects',
  lastSideActivity: 'projects',
  sidebarVisible: true,
  sidebarWidth: 280,
  sidebarCompact: false,
  sidebarFolded: false,
  sidebarUnfolded: false,
  progressFolded: false,
  progressUnfolded: false,
  sessionsJump: null,
  attachmentsJump: null,
  activityFilters: {},
  filesJump: null,
  panes: {},
  skillsProvider: {},
  skillsFold: {},
  sessionsTree: {},
  hiveVcsNotice: {},
  assistantFold: {},
  boardFold: {},
  progressFilter: {},
  laneOrder: {},
  tabs: {},
  selectedProject: null,
  projectTabs: {},
  selectedNote: null,
  selectedSkill: null,
  selectedTemplate: null,
  templateFilter: 'all',
  skillEdit: null,
  selectedMcp: null,
  selectedMode: null,
  assistantSection: 'conversations',
  journalVersion: 0,
  assistantOpen: false,
  progressRuns: [],
  mergeSlots: [],
  queues: [],
  queueKept: [],
  queueVersion: 0,
  workflowVersion: 0,
  lanes: [],
  paneFlash: null,
  paneColumns: null,
  tileStripRoom: null,
  assistantSettingsOpen: false,
  assistantActions: [],
  assistantQuestions: [],
  assistantChanges: [],
  assistantUndone: {},
  newAgents: {},
  modesVersion: 0,
  docsPage: 'guide',
  docsAnchor: null,
  settingsSection: 'general',
  settingsQuery: '',
  settingsModifiedOnly: false,

  toasts: [],
  notices: [],
  notifications: [],
  unread: 0,
  showNotifications: false,
  inboxOpen: false,
  paletteOpen: false,
  paletteMode: 'commands',
  modeMenu: null,
  recordingKeys: false,
  aboutOpen: false,
  diagnosticsOpen: false,
  update: null,
  updateOpen: false,
  setupOpen: false,
  moveRepairOpen: false,
  setAsideOpen: false,
  moveBannerHidden: null,
  shortcutsOpen: false,
  dialog: null,
  dialogBlocked: null,
  quitRequest: null,
  quitUnsaved: [],
  quitScope: 'app',
  quitPending: null,
  windowCount: 1,
  keepAwake: 0,
  sessionBulk: {},
  compactFor: null,
  addAgentFor: null,
  agentSettingsFor: null,
  templateAgentFor: null,
  templateEdits: {},
  mergeFor: null,
  branchMergeFor: null,
  gitInitFor: null,
  handOverFor: null,
  overviewJump: null,
  projectSettingsJump: null,
  focusedAgent: {},
  agentDrag: null,
  paneSaid: null,
  running: {},
  starting: {},
  pageFocus: {},
  tileFocus: {},
  tilePage: {},
  changesRoot: {},
  vcSection: {},
  workflowPrefill: null,
  presetStepShown: [],
  gitVersion: {},
  unusedVersion: {},
  filesRoot: {},

  tasks: [],
  boardReads: 0,
  boardState: null,
  boardStages: null,
  projectKeys: [],
  movedCardNames: {},
  perfWorkspace: DEFAULT_PERF_FILTERS,
  perfProjects: {},
  overviewPeriod: 'week',
  workspaceUsage: null,
  workspaceUsageAt: 0,
  workspaceUsageError: null,
  boardProject: null,
  boardQuery: '',
  boardArchived: false,
  boardForYou: false,
  taskOpen: null,
  taskStartFor: null,
  laneStartFor: null,
  runsShow: null,
  boardArchiveAll: null,
  taskDoing: null,
  removeProjectFor: null,

  windowFocused: true,
  maximized: false,
  alwaysOnTop: false,
  notesVersion: 0,
  skillsVersion: 0,
  templatesVersion: 0,
  usageVersion: {},
  sessionEpoch: {}
}))

// Automatic's default provider (#474) follows what Hive found, as this window last heard: unknown until it has said (#506).
setInstalledCheck((id) => {
  const i = useStore.getState().providers[id]
  return !i ? null : i.found ? true : i.checking ? null : false
})

/** The store's parts set kept the same where they are equal (keepSame). */
const KEPT_SAME = ['workspace', 'tasks', 'boardState', 'projectKeys', 'movedCardNames'] as const satisfies readonly (keyof State)[]

/** How long agents' states wait to be shown together (HI-1806): a dozen agents send dozens a second. */
const LIVE_BATCH_MS = 250
/** Agents' states not shown yet (applyLiveState), by projectKey, the newest of each. */
const pendingLive = new Map<string, LiveSessionState>()
let liveTimer: ReturnType<typeof setTimeout> | null = null

/** Sets the store, noting which of its parts changed (HI-1775): a long task's line in hive.log names the updates made in it. */
export const set: typeof useStore.setState = ((partial: Parameters<typeof useStore.setState>[0], replace?: boolean) => {
  let before = useStore.getState()
  let update = typeof partial === 'function' ? partial(before) : partial
  // A workspace set (main's newer report, a change made here): the agents' states waiting are older, so shown first.
  if (pendingLive.size && update && 'workspace' in update) {
    flushLiveStates()
    before = useStore.getState()
    if (typeof partial === 'function') update = partial(before)
  }
  if (replace || !update) useStore.setState(update as never, replace as never)
  else {
    // Parts main sends again whole (HI-1806: a workspace with one agent's state changed, the board after each change):
    // the parts unchanged stay the objects the window has, so only what shows a changed one renders again, and a part
    // the same throughout changes nothing.
    const rest: Partial<State> = { ...update }
    for (const k of KEPT_SAME) {
      if (!(k in rest) || !rest[k] || !before[k]) continue
      const kept = keepSame(before[k], rest[k])
      if (kept === before[k]) delete rest[k]
      else (rest as Record<string, unknown>)[k] = kept
    }
    if (Object.keys(rest).length) useStore.setState(rest as never)
  }
  const after = useStore.getState()
  // The parts it changed (an update by a function too): what re-renders their readers.
  if (after !== before) storeUpdated(Object.keys(after).filter((k) => after[k as keyof State] !== before[k as keyof State]))
}) as typeof useStore.setState
export const get = useStore.getState

// A change of language (Settings → General → Language) renders the window again in it (#767).
onLanguageChange((code) => useStore.setState({ language: code }))

// Dates follow Settings → General. Subscribed before any component, so the formatters have the new choice by the
// time anything renders with the new settings (components that show dates read the choice with useDateStyle()).
useStore.subscribe((s, prev) => {
  if (s.settings !== prev.settings) setDateStyle({ date: s.settings?.general.dateFormat, time: s.settings?.general.timeFormat })
})

/** The language Hive shows, for a component that shows translated text: it renders again when it changes (#767). */
export function useLanguage(): string {
  return useStore((s) => s.language)
}

/** The user's date and time format, for a component that shows dates: it renders again when they change. */
export function useDateStyle(): string {
  return useStore((s) => `${s.settings?.general.dateFormat}/${s.settings?.general.timeFormat}`)
}

export interface AgentRef {
  project: string
  agentId: string
  /** The Merge dialog on an unused worktree (#400): its folder and branch; agentId is then empty. */
  worktree?: { path: string; branch: string }
}

/** Terminal key of an agent's session. */
/** Sets what an agent left running (none: removes it). */
export function applyLeftovers(l: AgentLeftovers): void {
  const key = projectKey(l.projectPath, l.agentId)
  set((s) => {
    const { [key]: _old, ...rest } = s.leftovers
    return { leftovers: l.processes.length || l.more ? { ...rest, [key]: l } : rest }
  })
}

/** Forgets an agent's failed start (✕, or a new launch). */
export function clearStartFailure(path: string, agentId: string): void {
  const key = projectKey(path, agentId)
  if (!(key in get().startFailures)) return
  set((s) => {
    const { [key]: _gone, ...rest } = s.startFailures
    return { startFailures: rest }
  })
}

/** Whether an agent's pane is shown in this window, focused or not (agentsOnScreen counts a focused window only). */
export function agentOnScreen(path: string, agentId: string): boolean {
  return !!agentsOnScreen({ ...get(), windowFocused: true }).get(path)?.includes(agentId)
}

export function projectKey(path: string, agentId: string): string {
  return agentPtyKey(path, agentId)
}

/** The agent session commands act on in this project: the focused one, else the first; null with no agents. */
export function focusedAgentId(p: ProjectInfo | null | undefined): string | null {
  if (!p) return null
  const id = get().focusedAgent[p.path]
  return id && p.agents.some((a) => a.id === id) ? id : (p.agents[0]?.id ?? null)
}

export function agentOf(p: ProjectInfo | null | undefined, agentId: string): AgentInfo | null {
  return p?.agents.find((a) => a.id === agentId) ?? null
}

/** The focused agent, re-rendering when focus changes. */
export function useFocusedAgent(p: ProjectInfo | null | undefined): AgentInfo | null {
  const id = useStore((s) => (p ? s.focusedAgent[p.path] : undefined))
  if (!p) return null
  return p.agents.find((a) => a.id === id) ?? p.agents[0] ?? null
}

/**
 * Which providers' problems this window shows (#474): none of those turned on installed, or else those turned on that
 * new agents or this workspace's agents (the Assistant's too) use. Recomputed when settings, what's installed or the
 * workspace change.
 */
export function useProviderWarnings(): ReturnType<typeof providerWarnings> {
  const settings = useStore((s) => s.settings)
  const providers = useStore((s) => s.providers)
  const workspace = useStore((s) => s.workspace)
  return useMemo(() => {
    const hosts = [...(workspace?.projects ?? []), ...(workspace?.assistant ? [workspace.assistant] : [])]
    return providerWarnings(settings, (id) => providers[id], providersInUse(settings, hosts))
  }, [settings, providers, workspace])
}

/** The provider an agent runs (its own, else the project's default, else the global default). */
export function agentProviderOf(p: ProjectInfo | null | undefined, a: Pick<AgentInfo, 'provider' | 'live'> | null | undefined): ProviderId {
  return a?.live?.provider || agentProvider(a, p?.config, get().settings)
}

/** The combined state shown by a project's single status dot: its most urgent agent. */
export function projectState(p: ProjectInfo | null | undefined) {
  return p ? mostUrgent(p.agents.map((a) => a.live)) : null
}

export function focusAgent(path: string, agentId: string): void {
  set((s) => {
    const p = findProject(s, path)
    const on = p?.agents.some((a) => a.id === agentId)
    return { focusedAgent: { ...s.focusedAgent, [path]: agentId }, ...(p && on ? { pageFocus: { ...s.pageFocus, [`${path}#${cellPage(paneCells(p, s), agentId, shownPerPage(p, s))}`]: agentId } } : {}) }
  })
}

/**
 * The layout a project's panes are shown in: the one chosen, with fewer columns while the Session tab is too narrow for
 * them (#1037), back to the chosen one once there is room. The choice itself isn't changed.
 */
export function shownLayout(p: Pick<ProjectInfo, 'config'>, s: Pick<State, 'paneColumns'> = get()): SessionLayout {
  return layoutFitting(projectLayout(p.config), s.paneColumns)
}

/** How many agents a page of a project's panes holds, in the layout shown (#134, #1037). */
export const shownPerPage = (p: Pick<ProjectInfo, 'config'>, s: Pick<State, 'paneColumns'> = get()): number => agentsPerPage(shownLayout(p, s))

/**
 * The cells of a project's panes in the layout shown (#762): where the user put each agent in that layout, else the
 * agents in order. Its pages hold as many cells as the layout has panes (#134).
 */
export function paneCells(p: Pick<ProjectInfo, 'config' | 'agents'>, s: Pick<State, 'paneColumns'> = get()): PaneCells {
  const layout = shownLayout(p, s)
  return placedCells(p.agents.map((a) => a.id), layout === 'single' ? undefined : p.config.placement?.[layout], agentsPerPage(layout))
}

/** How many agent pages a project's panes take, in the layout shown. */
export const panePageCount = (p: Pick<ProjectInfo, 'config' | 'agents'>, s: Pick<State, 'paneColumns'> = get()): number => cellPageCount(paneCells(p, s), shownPerPage(p, s))

/** The agent page a project shows: the focused agent's (a page holds as many cells as the layout has panes, #134). */
export function agentPage(p: ProjectInfo, focused: string | null): number {
  return cellPage(paneCells(p), focused, shownPerPage(p))
}

/**
 * Which agent each pane shows: the focused agent's page's cells (a pane each, #134, placed by the user, #762), empty
 * ones null. One at a time (Single) shows the focused agent.
 */
export function paneAssignment(p: ProjectInfo, focused: string | null): (string | null)[] {
  const n = layoutPanes(shownLayout(p))
  if (n === 1) return [focused]
  return pageCells(paneCells(p), agentPage(p, focused), n)
}

/**
 * The agents the user can see now, by project path: the selected project's panes on its Session tab, and the
 * Assistant's while its panel is open. None while the window isn't focused.
 */
export function agentsOnScreen(s: State = get()): Map<string, string[]> {
  const out = new Map<string, string[]>()
  if (!s.windowFocused || !s.workspace) return out
  const p = s.activity === 'projects' ? s.workspace.projects.find((x) => x.path === s.selectedProject) : undefined
  // The Tiles view (#976): the agent its focus view shows, else the page of tiles.
  if (p && (s.projectTabs[p.path] ?? 'session') === 'session' && projectSessionView(p.config, s.settings) === 'tiles') {
    const focus = tileFocusOf(p, s)
    out.set(p.path, focus ? [focus] : tilesOnPage(tileAgents(p, s), tilePage(p, s)).map((t) => t.a.id))
  } else if (p && (s.projectTabs[p.path] ?? 'session') === 'session') {
    const focused = s.focusedAgent[p.path]
    const shown = paneAssignment(p, focused && p.agents.some((a) => a.id === focused) ? focused : (p.agents[0]?.id ?? null))
    out.set(p.path, shown.filter((id): id is string => !!id))
  }
  const a = s.workspace.assistant
  if (a && s.assistantOpen) out.set(a.path, a.agents.map((x) => x.id))
  return out
}

/**
 * Shows an agent: focuses its pane, which is on its page (a page shows all its agents, #134); one on another page
 * goes to that page. One at a time (Single), it becomes the one shown.
 */
export function showAgent(p: ProjectInfo, agentId: string, how: 'show' | 'select' = 'show'): void {
  focusAgent(p.path, agentId)
  // In the Tiles view (#976) it opens the agent's focus view, unless it is only chosen (an agent just added: its tile).
  if (how === 'show' && !isAssistantPath(p.path) && projectSessionView(p.config, get().settings) === 'tiles') openTile(p, agentId)
}

/** A project's agents in the Tiles view's order (#976; Settings → Sessions → Tile order), each with its state. */
export function tileAgents(p: Pick<ProjectInfo, 'path' | 'name' | 'agents'>, s: Pick<State, 'tasks' | 'startFailures' | 'settings'> = get()): { a: AgentInfo; state: AgentState }[] {
  const states = projectAgentStates(p, s.tasks, (id) => !!s.startFailures[projectKey(p.path, id)])
  return tileOrder(states, s.settings?.sessions.tileOrder ?? 'panes').map((i) => ({ a: p.agents[i], state: states[i] }))
}

/** The page of tiles a project's Tiles view shows. */
export const tilePage = (p: Pick<ProjectInfo, 'path' | 'agents'>, s: Pick<State, 'tilePage'> = get()): number => tilePageShown(s.tilePage[p.path] ?? 0, p.agents.length)

/** Shows a page of a project's tiles. */
export function showTilePage(p: Pick<ProjectInfo, 'path' | 'agents'>, page: number): void {
  set((s) => ({ tilePage: { ...s.tilePage, [p.path]: tilePageShown(page, p.agents.length) } }))
}

/** The agent a project's focus view shows (#976), while it is one of its agents; null: the grid of tiles. */
export function tileFocusOf(p: Pick<ProjectInfo, 'path' | 'agents'> | null | undefined, s: Pick<State, 'tileFocus'> = get()): string | null {
  const id = p ? s.tileFocus[p.path] : undefined
  return id && p!.agents.some((a) => a.id === id) ? id : null
}

/** Opens an agent's focus view (#976): its pane large, the other agents in a strip beside it. */
export function openTile(p: ProjectInfo, agentId: string): void {
  set((s) => ({ tileFocus: { ...s.tileFocus, [p.path]: agentId } }))
  focusAgent(p.path, agentId)
}

/** Back from the focus view to the grid, on the page of the agent it showed; returns that agent, for its tile to take the focus. */
export function closeTile(p: ProjectInfo): string | null {
  const id = tileFocusOf(p)
  set((s) => {
    const { [p.path]: _, ...rest } = s.tileFocus
    const at = id ? tileAgents(p, s).findIndex((t) => t.a.id === id) : -1
    return { tileFocus: rest, ...(at >= 0 ? { tilePage: { ...s.tilePage, [p.path]: tilePageOf(at) } } : {}) }
  })
  return id
}

/**
 * Before an agent is removed: if it has focus, focus the agent that takes its place (the next), else the one
 * before it, so the view stays on its page unless that page empties. `p` is the project before the removal.
 */
export function focusAfterRemoving(p: ProjectInfo, agentId: string): void {
  if (focusedAgentId(p) !== agentId) return
  const i = p.agents.findIndex((a) => a.id === agentId)
  const next = p.agents[i + 1] ?? p.agents[i - 1]
  if (next) set((s) => ({ focusedAgent: { ...s.focusedAgent, [p.path]: next.id } }))
}

/** Goes to one of a project's agent pages, focusing the agent last focused there (else its first). */
export function showPage(p: ProjectInfo, page: number): void {
  const ids = pageIds(paneCells(p), page, shownPerPage(p))
  if (!ids.length) return
  const last = get().pageFocus[`${p.path}#${page}`]
  focusAgent(p.path, last && ids.includes(last) ? last : ids[0])
}

/** A project, or the Hive Assistant (a session host like a project), by path. */
export function findProject(s: Pick<State, 'workspace'>, path: string | null | undefined): ProjectInfo | null {
  if (!path || !s.workspace) return null
  const p = path.toLowerCase()
  return s.workspace.projects.find((x) => x.path.toLowerCase() === p) ?? (s.workspace.assistant?.path.toLowerCase() === p ? s.workspace.assistant : null)
}

/** Whether a path is the open workspace's Hive Assistant. */
export function isAssistantPath(path: string | null | undefined): boolean {
  const a = get().workspace?.assistant
  return !!path && !!a && a.path.toLowerCase() === path.toLowerCase()
}

const assistantOpenKey = (ws: string): string => `assistant-open:${ws.toLowerCase()}`

/** Shows or hides the Hive Assistant's panel, remembered per workspace. */
export function setAssistantOpen(open: boolean): void {
  const ws = get().workspace?.path
  set({ assistantOpen: open })
  if (!ws) return
  set((s) => ({ panes: { ...s.panes, [assistantOpenKey(ws)]: open ? 1 : 0 } }))
  void window.hive.invoke('ui:setPane', assistantOpenKey(ws), open ? 1 : 0)
}

/** Whether the Assistant's panel is on the left of the window (Settings → Assistant → Panel side; right by default). */
export const assistantOnLeft = (s: State): boolean => s.settings?.assistant.panelSide === 'left'

/** Moves the Assistant's panel to that side of the window: a setting, so every window and workspace follows. */
export async function setAssistantSide(side: AssistantPanelSide): Promise<void> {
  set({ settings: await window.hive.invoke('settings:update', { assistant: { panelSide: side } }) })
}

const progressOpenKey = (ws: string): string => `progress-open:${ws.toLowerCase()}`

/** Whether this window's workspace's Progress panel shows open (else it is folded to its strip, by the user or for the room). */
export function useProgressOpen(): boolean {
  return useStore((s) => !!s.workspace && s.panes[progressOpenKey(s.workspace.path)] === 1 && !(s.progressFolded && !s.progressUnfolded))
}

/** Whether the user left the Progress panel open (what is kept), folded for the room or not (HI-1737's layoutRoom). */
export function progressWanted(): boolean {
  const ws = get().workspace?.path
  return !!ws && get().panes[progressOpenKey(ws)] === 1
}

/** The Progress panel's filter as chosen for this window's workspace (#251), if any. */
export function useProgressFilter(): ProgressFilter | undefined {
  return useStore((s) => (s.workspace ? s.progressFilter[s.workspace.path.toLowerCase()] : undefined))
}

/** Chooses the Progress panel's filter, remembered per workspace (at most 100 workspaces, the oldest go). */
export function setProgressFilter(f: ProgressFilter): void {
  const ws = get().workspace?.path.toLowerCase()
  if (!ws) return
  const next = { ...get().progressFilter }
  delete next[ws]
  next[ws] = f
  const kept = Object.fromEntries(Object.entries(next).slice(-100))
  set({ progressFilter: kept })
  void window.hive.invoke('ui:set', { progressFilter: kept }).catch(() => undefined)
}

/** The tab a remembered row of tabs shows (HI-1837): the one last chosen while it is offered, else `fallback`. */
export function useRememberedTab<T extends string>(key: string, ids: readonly T[], fallback: T): T {
  const wanted = useStore((s) => s.tabs[key])
  return shownTab(ids, wanted, fallback)
}

/** Chooses a remembered row's tab (a click, or a link to it), kept across restarts (at most 100 rows, the oldest go). */
export function chooseTab(key: string, id: string): void {
  const kept = rememberTab(get().tabs, key, id)
  set({ tabs: kept })
  void window.hive.invoke('ui:set', { tabs: kept }).catch(() => undefined)
}

/** Settings → Version Control's tabs (HI-1837): Hive defaults and the open workspace's, by their rows' ids. */
export const WORKFLOW_DEFAULTS_TABS = 'settings.workflow'
export const WORKFLOW_DEFAULTS_TAB = { global: 'workflow.defaults', workspace: 'workflow.workspaceDefaults' } as const

/** Opens Settings → Version Control on a level's tab (a "From Hive defaults" or "From the workspace" origin's link). */
export function showWorkflowDefaults(level: keyof typeof WORKFLOW_DEFAULTS_TAB): void {
  chooseTab(WORKFLOW_DEFAULTS_TABS, WORKFLOW_DEFAULTS_TAB[level])
  set({ settingsSection: 'workflow', settingsQuery: '', settingsModifiedOnly: false })
  setActivity('settings')
}

/** Shows or folds the Progress panel, remembered per workspace. */
export function setProgressOpen(open: boolean): void {
  const ws = get().workspace?.path
  if (!ws) return
  // Folded for the room (HI-1737): opening it shows it anyway, until there's room; folding it is the user's again.
  set((s) => ({ panes: { ...s.panes, [progressOpenKey(ws)]: open ? 1 : 0 }, progressUnfolded: open && s.progressFolded }))
  void window.hive.invoke('ui:setPane', progressOpenKey(ws), open ? 1 : 0)
}

/** Whether the Progress panel is open now (for commands). */
export function progressIsOpen(): boolean {
  const s = get()
  return progressWanted() && !(s.progressFolded && !s.progressUnfolded)
}

/** Whether a workspace's Assistant panel was left open. */
export function assistantWasOpen(ws: string | null | undefined): boolean {
  return !!ws && get().panes[assistantOpenKey(ws)] === 1
}

export function selectedProjectInfo() {
  const s = get()
  return s.workspace?.projects.find((p) => p.path === s.selectedProject) ?? null
}

export function setActivity(a: Activity): void {
  set((s) => ({
    activity: a,
    lastSideActivity: a === 'docs' || a === 'settings' ? s.lastSideActivity : a,
    sidebarVisible: a === s.activity && a !== 'docs' && a !== 'settings' ? !s.sidebarVisible : true
  }))
}

/** Collapses the Projects sidebar to a rail of status dots, or expands it again. Either way the Projects list is shown. */
export function toggleCompactSidebar(compact = !(get().sidebarCompact || (get().sidebarFolded && !get().sidebarUnfolded))): void {
  set((s) => ({
    sidebarCompact: compact,
    // Folded for the room (HI-1737): Expand shows the list anyway, until there's room again; Collapse folds it back.
    sidebarUnfolded: s.sidebarFolded && !compact,
    sidebarVisible: true,
    lastSideActivity: 'projects',
    activity: s.activity === 'docs' || s.activity === 'settings' ? s.activity : 'projects'
  }))
}

/** Shows a project's settings on one section (e.g. Storage). */
export function openProjectSettings(path: string, section: string): void {
  set({ selectedProject: path, projectSettingsJump: { project: path, section, at: Date.now() } })
  showView('projects')
  setProjectTab(path, 'settings')
}

/** Where a link into the Attachments tab goes (HI-1841): Card attachments at a card, or Pane attachments at a session. */
export type AttachmentsJump = { project: string; nonce: number } & ({ tab: 'card'; card: number } | { tab: 'pane'; session: string })

/** Opens a project's Attachments tab on Card attachments at a card, or Pane attachments at a session (HI-1841). */
export function showAttachments(path: string, at: { card: number } | { session: string }): void {
  set({ selectedProject: path, attachmentsJump: { project: path, nonce: Date.now(), ...('card' in at ? { tab: 'card' as const, card: at.card } : { tab: 'pane' as const, session: at.session }) } })
  showView('projects')
  setProjectTab(path, 'images')
}

/** Opens the Sessions tab on one session; with `compaction`, at that compaction's divider (its nth, from 0). */
export function openInSessionsTab(path: string, id: string, compaction?: number): void {
  set({ sessionsJump: { project: path, id, nonce: Date.now(), ...(compaction !== undefined ? { compaction } : {}) } })
  setProjectTab(path, 'sessions')
}

/**
 * Opens a project's Activity tab (#1254), frozen (HI-1743): filtered to an agent, its tab shown; or to a card, on the tab
 * of the agent working on it (`agentId`); null: as it was left. Hide finished and the zoom stay as they were.
 */
export function openActivity(path: string, filter: { agentId?: string; card?: number } | null): void {
  set((s) => {
    const was = s.activityFilters[path] ?? loadActivityView(path)
    const opened = Date.now()
    const view: ActivityView = filter ? { ...was, agents: filter.agentId && filter.card === undefined ? [filter.agentId] : [], cards: filter.card !== undefined ? [filter.card] : [], ...(filter.agentId ? { tab: filter.agentId } : {}), opened } : { ...was, opened }
    saveActivityView(path, view)
    return { activityFilters: { ...s.activityFilters, [path]: view }, selectedProject: path }
  })
  showView('projects')
  setProjectTab(path, 'activity')
}

/** Whether a card has an Activity to open (HI-1743): in progress (Doing or Review) in a project of this window. */
export const cardHasActivity = (c: Pick<TaskCard, 'column' | 'project' | 'archived'>): boolean => !c.archived && !!c.project && (c.column === 'doing' || c.column === 'review')

/** Opens a card's Activity (HI-1743): its project's tab, frozen, on the agent working on it (its builder while it runs, else its reviewer). */
export function openCardActivity(c: TaskCard): void {
  const p = get().workspace?.projects.find((x) => x.name.toLowerCase() === c.project.toLowerCase())
  if (!p || !cardHasActivity(c)) return
  // The agent on this card now: a builder gone on to its next card isn't (HR6's round 1).
  const asActivity = (t: TaskCard) => ({ number: t.number, label: '', title: t.title, column: t.column, builder: t.agent, reviewer: t.review?.agent ?? null })
  const cards = get().tasks.filter((t) => !t.archived && t.project.toLowerCase() === c.project.toLowerCase()).map(asActivity)
  const worker = cardWorker(asActivity(c), cards, (id) => !!p.agents.find((a) => a.id === id)?.live)
  openActivity(p.path, { card: c.number, ...(worker ? { agentId: worker } : {}) })
}

/** Shows an agent's pane on the Session tab and focuses it. */
export function revealAgent(p: ProjectInfo, agentId: string): void {
  showAgent(p, agentId)
  setProjectTab(p.path, 'session')
}

/** How long a pane stays highlighted after it was asked for (flashPane). */
export const PANE_FLASH_MS = 1200

/**
 * Says "here it is" for an agent (or the Assistant) just shown: its pane is highlighted for a moment, and its terminal
 * takes the keyboard, so showing one that was already on screen visibly does something.
 */
export function flashPane(key: string): void {
  const at = Date.now()
  set({ paneFlash: { key, at } })
  setTimeout(() => {
    if (get().paneFlash?.at === at) set({ paneFlash: null })
  }, PANE_FLASH_MS)
  // Once its terminal is on screen (it may be on another page, or its project only now shown), for up to a second.
  // Timers, not animation frames: those wait while the window is behind others. Only while nothing newer chose where
  // the keyboard goes (#327): the user pressing a key or clicking meanwhile, or another agent shown.
  chooseFocus()
  const host = (): HTMLElement | undefined => [...document.querySelectorAll<HTMLElement>('.terminal-host[data-pty]')].find((h) => h.dataset.pty === key && !h.classList.contains('hidden'))
  const current = deferredFocus(host)
  let tries = 0
  const focus = (): void => {
    if (!current()) return
    const input = host()?.querySelector<HTMLTextAreaElement>('textarea')
    if (input) input.focus()
    else if (++tries < 20) setTimeout(focus, 50)
  }
  setTimeout(focus, 30)
}

/** Shows a sidebar view without toggling it (setActivity hides the sidebar when that view is already shown). */
export function showView(a: Exclude<Activity, 'docs' | 'settings'>): void {
  set({ activity: a, lastSideActivity: a, sidebarVisible: true })
}

/** Shows the Hive Assistant view (activity bar) on its conversations, its modes, its attachments ('images') or its journal. */
export function showAssistantView(section: 'conversations' | 'modes' | 'images' | 'journal' | 'digests'): void {
  set({ assistantSection: section })
  showView('assistant')
}

export function setProjectTab(path: string, tab: ProjectTab): void {
  set((s) => ({ projectTabs: { ...s.projectTabs, [path]: tab } }))
}

/**
 * Opens a project's Version Control tab at a section (#607, #1416): the status bar's item, whose changes to review
 * (Changes), the merge queue's links (Merge queue) and the presets notice (Workflow).
 */
export function showVersionControl(path: string, section: VcSection): void {
  set((s) => ({ projectTabs: { ...s.projectTabs, [path]: 'changes' }, vcSection: { ...s.vcSection, [path]: section } }))
}

/** Selects the project and shows its Version Control tab at a section, from anywhere (Project Settings, the presets notice). */
export function openVersionControl(path: string, section: VcSection): void {
  set({ selectedProject: path })
  showView('projects')
  showVersionControl(path, section)
}

/** After a Git action: the project's Version Control tab and status bar item read git again. */
export function bumpGit(path: string): void {
  set((s) => ({ gitVersion: { ...s.gitVersion, [path]: (s.gitVersion[path] ?? 0) + 1 } }))
}

/** The Changes tab's folder for the list of a project's unused worktrees, and for one of them (#400). */
export const UNUSED_ROOT = 'unused'
export const unusedRoot = (worktreePath: string): string => `${UNUSED_ROOT}:${worktreePath}`

/** Opens a project's Changes tab at its unused worktrees (#353, #400: they live in Changes). */
export function showUnusedWorktrees(path: string): void {
  set((s) => ({ projectTabs: { ...s.projectTabs, [path]: 'changes' }, vcSection: { ...s.vcSection, [path]: 'changes' }, changesRoot: { ...s.changesRoot, [path]: UNUSED_ROOT } }))
}

/** The project's unused worktrees changed outside their list (#400): it reloads. */
export function bumpUnused(path: string): void {
  set((s) => ({ unusedVersion: { ...s.unusedVersion, [path]: (s.unusedVersion[path] ?? 0) + 1 } }))
}

/** Opens a project's Overview at one agent's session (picked there, and scrolled to). */
export function showInOverview(path: string, agentId: string, target: 'history' | 'session' = 'history'): void {
  set((s) => ({ projectTabs: { ...s.projectTabs, [path]: 'overview' }, overviewJump: { project: path, agentId, at: Date.now(), target } }))
}

/**
 * Each project's name by its path in lower case: with useShallow, what reads only the names stays still while the
 * projects' agents change state (HI-1806).
 */
export function projectNames(projects: readonly ProjectInfo[] | undefined): Record<string, string> {
  return Object.fromEntries((projects ?? []).map((p) => [p.path.toLowerCase(), p.name]))
}

/**
 * Shows an agent's new state (a session-status event): at once, then those that come within LIVE_BATCH_MS of it
 * together at its end, in one update of the store (HI-1806), so a dozen agents changing state render the window a few
 * times a second, not dozens, and one change on its own shows without waiting.
 */
export function applyLiveState(state: LiveSessionState): void {
  pendingLive.set(projectKey(state.projectPath, state.agentId), state)
  if (liveTimer) return
  flushLiveStates()
  liveTimer = setTimeout(liveWindowEnds, LIVE_BATCH_MS)
}

/** The batch's time is up: the states that came meanwhile are shown, and the next ones wait a while again. */
function liveWindowEnds(): void {
  liveTimer = null
  if (!pendingLive.size) return
  flushLiveStates()
  liveTimer = setTimeout(liveWindowEnds, LIVE_BATCH_MS)
}

/** An agent's state as last told, shown yet or not. */
export function liveStateOf(projectPath: string, agentId: string): LiveSessionState | null | undefined {
  const pending = pendingLive.get(projectKey(projectPath, agentId))
  if (pending) return pending.status === 'stopped' ? null : pending
  return findProject(get(), projectPath)?.agents.find((a) => a.id === agentId)?.live
}

/** Shows the agents' states waiting (applyLiveState) now; also before the workspace is set, which they are older than. */
export function flushLiveStates(): void {
  if (!pendingLive.size) return
  const states = [...pendingLive.values()]
  pendingLive.clear()
  set((s) => (s.workspace ? { workspace: states.reduce(withLiveState, s.workspace) } : {}))
}

function withLiveState(workspace: WorkspaceInfo, state: LiveSessionState): WorkspaceInfo {
  const agentId = state.agentId
  const live = state.status === 'stopped' ? null : state
  const projects = workspace.projects.map((p) => {
    if (p.path.toLowerCase() !== state.projectPath.toLowerCase()) return p
    const known = p.agents.some((a) => a.id === agentId)
    const agents = known
      ? p.agents.map((a) => (a.id === agentId ? { ...a, live, restartNeeded: live ? a.restartNeeded : false } : a))
      : live
        ? [...p.agents, { id: agentId, name: state.agentName ?? 'Agent', live, restartNeeded: false, resume: null, place: { folder: state.cwd, is: 'project' as const, name: null, branch: null } }] // i18n-ignore: a stand-in agent name until the project's own list arrives
        : p.agents
    const primary = agents.find((a) => a.live)
    return { ...p, agents, live: primary?.live ?? null, restartNeeded: primary?.restartNeeded ?? false, active: live ? true : p.active }
  })
  // The Hive Assistant's one agent.
  const a = workspace.assistant
  const assistant =
    a && a.path.toLowerCase() === state.projectPath.toLowerCase()
      ? { ...a, live, agents: a.agents.map((x) => (x.id === agentId ? { ...x, live, restartNeeded: live ? x.restartNeeded : false } : x)) }
      : a
  return { ...workspace, projects, assistant }
}

export function pushToast(t: ToastMessage): void {
  set((s) => ({
    // A quiet one is for the Notifications panel only (told as a banner, a Windows notification, or not at all).
    toasts: t.quiet ? s.toasts : [...s.toasts.filter((x) => x.id !== t.id), t].slice(-5),
    notifications: [t, ...s.notifications].slice(0, 100),
    unread: s.showNotifications ? s.unread : s.unread + 1
  }))
  if (t.quiet) return
  const timeout = t.timeoutMs ?? (t.level === 'error' ? 12000 : t.actions?.length ? 15000 : 6000)
  // This toast's own time: one that replaced it under the same id (a project's newer notice, #1419) keeps its own.
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x !== t) })), timeout)
}

export function dismissToast(id: string): void {
  set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}

let toastSeq = 0

/**
 * Runs an action that has no dialog (a header button, a menu item) once at a time: a second call while it runs is
 * ignored. `key` names it, so its button can show a spinner (`useStore((s) => s.running[key])`).
 */
export async function runOnce<T>(key: string, fn: () => Promise<T>): Promise<T | undefined> {
  if (get().running[key]) return undefined
  set((s) => ({ running: { ...s.running, [key]: true } }))
  try {
    return await fn()
  } finally {
    set((s) => {
      const { [key]: _, ...rest } = s.running
      return { running: rest }
    })
  }
}
/** A start or resume under way for an agent (#1177): which, and the session it resumes. */
export interface Starting {
  kind: 'start' | 'resume'
  sessionId?: string
  /** Started without its worktree's setup (Start Without Setup). */
  skipSetup?: boolean
}

/** What a start is held under while an agent is added for it (a project without agents, a session no agent can run). */
export const ADDING_AGENT = ':adding'

const STARTING = msg({ id: 'panes.session.starting', defaultMessage: '{kind, select, resume {Resuming…} other {Starting…}}', description: "A start (other) or Resume (resume) button's label while the agent's session starts, from the click until it runs (it shows a spinner and takes no clicks). Keep it short." })

/** The label a start or resume button shows while its agent starts (#1177). */
export function startingLabel(st: Starting): string {
  return tr(STARTING, { kind: st.kind })
}

export function startingKey(path: string, agentId: string): string {
  return `${path.toLowerCase()}#${agentId}`
}

/**
 * Runs an agent's start or resume, marked as starting until it ends (the call that starts it answers once the
 * session runs, or fails), so every button that starts it shows that it's working and ignores clicks: a second
 * start of an agent already starting is ignored.
 */
export async function whileStarting<T>(path: string, agentId: string, what: Starting, fn: () => Promise<T>): Promise<T | undefined> {
  const key = startingKey(path, agentId)
  if (get().starting[key]) return undefined
  set((s) => ({ starting: { ...s.starting, [key]: what } }))
  try {
    return await fn()
  } finally {
    set((s) => {
      const { [key]: _, ...rest } = s.starting
      return { starting: rest }
    })
  }
}

/** The agent's start or resume under way (none for no agent). */
export function useStarting(path: string, agentId: string | null): Starting | null {
  return useStore((s) => (agentId ? (s.starting[startingKey(path, agentId)] ?? null) : null))
}

/** The resume of this session under way, by whichever of the project's agents (the Sessions tab's buttons). */
export function useSessionStarting(path: string, sessionId: string | null): Starting | null {
  return useStore((s) => {
    if (!sessionId) return null
    const prefix = `${path.toLowerCase()}#`
    for (const k in s.starting) if (k.startsWith(prefix) && s.starting[k].sessionId === sessionId) return s.starting[k]
    return null
  })
}

/** Any start or resume under way in the project (an agent's, or one adding its agent): for its buttons that name no agent. */
export function useProjectStarting(path: string): Starting | null {
  return useStore((s) => startingIn(s.starting, path))
}

function startingIn(starting: Record<string, Starting>, path: string): Starting | null {
  const prefix = `${path.toLowerCase()}#`
  for (const k in starting) if (k.startsWith(prefix)) return starting[k]
  return null
}

/** Any start or resume under way in the project: for its menu items that name no agent. */
export function projectStarting(path: string): Starting | null {
  return startingIn(get().starting, path)
}

export function notify(level: ToastMessage['level'], title: string, message?: string, actions?: ToastMessage['actions']): void {
  pushToast({ id: `local-${++toastSeq}-${Date.now()}`, level, title, message, actions, timestamp: new Date().toISOString() })
}

/** Dialogs asked for while another is open: each is shown in turn, so none is left unanswered. */
const dialogQueue: DialogRequest[] = []

function openDialog(d: DialogRequest): void {
  if (get().dialog) dialogQueue.push(d)
  else set({ dialog: d })
}

/** Closes the dialog shown (its caller resolves it) and shows the next one waiting, if any. */
export function closeDialog(): void {
  set({ dialog: dialogQueue.shift() ?? null, dialogBlocked: null })
}

export function confirm(opts: Omit<ConfirmRequest, 'kind' | 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => openDialog({ kind: 'confirm', ...opts, resolve }))
}

export function choose(opts: Omit<ChoiceRequest, 'kind' | 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => openDialog({ kind: 'choice', ...opts, resolve }))
}

export function prompt(opts: Omit<PromptRequest, 'kind' | 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => openDialog({ kind: 'prompt', ...opts, resolve }))
}

/** Listeners for 'files-changed' events (Files and Attachments tabs). */
export const filesListeners = new Set<(projectPath: string, dirs: string[]) => void>()

let tasksLoad = 0
/**
 * How many views need the archived cards in full (#1017): the Archived view, an archived card's dialog. Otherwise the
 * board comes with them in short (TaskCard.summary), so a change of the board doesn't send every archived card's comments
 * and history again.
 */
let fullArchive = 0

/** Asks for the archived cards in full while a view needs them: read again now; the returned function says it is done. */
export function wantFullArchive(): () => void {
  fullArchive++
  void loadTasks()
  let done = false
  return () => {
    if (done) return
    done = true
    fullArchive--
  }
}
/** The board's read going on, and the one asked for meanwhile (#1011). */
let tasksReading: Promise<void> | null = null
let tasksNext: Promise<void> | null = null

/**
 * Reads the board again (after a change here or a tasks-changed event), one read at a time (#1011): asked while one is
 * going on, it reads once more after it, however often it was asked meanwhile, and resolves with that read. Started for
 * each event while slow ones went on, reads of the whole board piled up in the main process (#988).
 */
export function loadTasks(): Promise<void> {
  if (!tasksReading) {
    tasksReading = readTasks().finally(() => (tasksReading = null))
    return tasksReading
  }
  tasksNext ??= tasksReading.then(() => {
    tasksNext = null
    return loadTasks()
  })
  return tasksNext
}

/**
 * Reads the board. Only the latest read is kept, and only for the workspace it was made for: an older answer, or one
 * for a workspace this window has since left, is dropped.
 */
async function readTasks(): Promise<void> {
  const ws = get().workspace?.path
  const mine = ++tasksLoad
  if (!ws) {
    boardReads.clear()
    return set({ tasks: [], boardState: null, boardStages: null, projectKeys: [], movedCardNames: {} })
  }
  try {
    // The stages too when a workflow was written or the projects changed since they were read (HI-1682); a failed read
    // of them leaves each project's columns as its cards' stages give them.
    const stagesFor = boardStagesFor(get())
    const readStages = get().boardStages?.for !== stagesFor
    // What changed since this window's copy of the board (HI-1715), or the whole board while the archived cards are wanted in full.
    const board = boardReads.begin(ws, fullArchive > 0)
    // With them, each project's workflow line for the toolbar's link (#1420): it came after the board's first paint, and
    // a toolbar it made wrap moved every column down under the pointer (HI-1852).
    const forms = readStages ? workflowForms() : null
    const [cards, boardState, projectKeys, movedCardNames, stages, formsRead] = await Promise.all([board.request, window.hive.invoke('board:state'), window.hive.invoke('project:keys'), window.hive.invoke('project:movedCardNames'), readStages ? window.hive.invoke('board:stages').catch(() => ({})) : null, forms])
    if (mine !== tasksLoad) return
    const tasks = board.take(cards, { ws: get().workspace?.path ?? null, whole: fullArchive > 0 })
    if (tasks === 'again') return void loadTasks()
    if (tasks) set({ tasks, boardReads: get().boardReads + 1, boardState, projectKeys, movedCardNames, ...(stages ? { boardStages: { for: stagesFor, byPath: stages, forms: formsRead ?? {} } } : {}) })
  } catch {
    // The workspace closed meanwhile.
  }
}

/** The window's board reads, with the board as main last sent it (HI-1715). */
const boardReads = boardReader({ list: () => window.hive.invoke('tasks:list', true), changes: (since) => window.hive.invoke('tasks:changes', since) })

/**
 * What the board's stages are read for: the workspace, its projects and their version control, and the workflows
 * written since the window opened (`workflow-changed`). Stages read for another are read again with the board.
 */
/** Each project with version control's workflow form, by path in lower case; one that can't be read is left out. */
async function workflowForms(): Promise<Record<string, WorkflowForm>> {
  const projects = (get().workspace?.projects ?? []).filter((p) => p.platform)
  const read = await Promise.all(projects.map((p) => window.hive.invoke('workflow:form', p.path).then((f) => [p.path.toLowerCase(), f] as const, () => null)))
  return Object.fromEntries(read.filter((x) => !!x))
}

export const boardStagesFor =(s: Pick<State, 'workspace' | 'workflowVersion'>): string => `${s.workspace?.path ?? ''}|${s.workflowVersion}|${(s.workspace?.projects ?? []).map((p) => `${p.path}:${p.platform?.id ?? ''}`).join('|')}`

/** A project's key and its old keys, as the board has them (#1221). */
export type ProjectKeys = { projectPath: string; key: string; aliases: string[] }

/** A project's key (null before it has one). */
export const projectKeyOf = (s: Pick<State, 'projectKeys'>, projectPath: string | null | undefined): string | null => (projectPath ? (s.projectKeys.find((k) => k.projectPath.toLowerCase() === projectPath.toLowerCase())?.key ?? null) : null)

/**
 * A card named by its number as the window names it (#1221): its key when the board has the card, else `#12`. For a
 * card in hand, cardLabel(card).
 */
export const cardLabelOf = (s: Pick<State, 'tasks'>, n: number): string => {
  const c = s.tasks.find((t) => t.number === n)
  return c ? cardLabel(c) : `#${n}`
}

// Shared code the window runs names a card by its number with cardRef: by the board's key here too (HI-1661 round 1).
setCardNaming(() => (n) => cardLabelOf(get(), n))

/** Stable empty list for selectors — a fresh [] on every call makes zustand re-render forever. */
export const NO_PROJECTS: ProjectInfo[] = []
export const NO_IDS: string[] = []

/**
 * The Assistant added an agent. The user's view doesn't move: on the project they're looking at, its page's
 * button gets a dot; another project opens on the new agent's page next time.
 */
export function noteAgentAdded(path: string, agentId: string): void {
  set((s) => {
    const shown = s.selectedProject?.toLowerCase() === path.toLowerCase() && s.activity === 'projects'
    return {
      newAgents: { ...s.newAgents, [path]: [...(s.newAgents[path] ?? []), agentId] },
      ...(shown ? {} : { focusedAgent: { ...s.focusedAgent, [path]: agentId } })
    }
  })
}

/** The user saw these new agents (their page is shown). */
export function seenAgents(path: string, ids: string[]): void {
  set((s) => {
    const left = (s.newAgents[path] ?? []).filter((id) => !ids.includes(id))
    const next = { ...s.newAgents }
    if (left.length) next[path] = left
    else delete next[path]
    return { newAgents: next }
  })
}
