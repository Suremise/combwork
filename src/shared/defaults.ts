import type { AgentBranchStatus, AgentDef, AppConfig, AppSettings, CompactionEvent, KeybindingOverrides, FileLockMode, PageLayout, PlanLimit, PlanUsage, ProjectConfig, ProjectProviderConfig, ProviderId, ProviderSettings, SessionLayout, SessionRecord, SessionStatus, SessionView, WorkspaceConfig } from './types'
import { CLAUDE_CODE } from './claude'
import { MIGRATED_QUIT, migrateCombworkCommands } from './commands'
import { AGENT_LIMIT_DEFAULT, AGENT_LIMIT_MAX } from './agentLimits'
import { DEFAULT_COLUMN_COLORS } from './tasks'
import { formatDateTime } from './dates'
import { formatGigabytes, formatSize } from './units'
import { AUTO_PROVIDER, DEFAULT_PROVIDER, PROVIDERS, defaultProviderSettings, isDefaultProviderValue, providerDescriptor } from './providers'
import { chosenName, effortName, modelIdName, resolvedModel, runsAsName, type ModelInfo } from './models'
import { msg, tr as trNow, type Msg } from './i18n'
import type { Tr } from './tasks'
import { samePath } from './movePaths'
import { legacyWorktree } from './agentFolders'
import { migrateGlobalFileLocks, migrateProjectPreferences } from './workflow/preferences'

export const CW_DIR = '.combwork'

/** Session ids are UUIDs (Claude Code, Codex); this also accepts other plain ids but never anything that could be a path. */
export const isSessionId = (id: unknown): id is string => typeof id === 'string' && /^[\w-]{1,100}$/.test(id)

/** Throws unless id is a valid session id (see isSessionId). Session ids end up in file names. */
export function assertSessionId(id: unknown): string {
  if (!isSessionId(id)) throw new Error('Invalid session id') // i18n-ignore: a programming error's message (E10 formats errors)
  return id
}
export const DEFAULT_API_PORT = 47821

/**
 * Personas Hive shipped until working modes replaced them (#259), and the mode each became. A workspace's copy Hive
 * never changed goes; one the user changed is theirs and stays. A choice of a removed one moves to its mode.
 */
export const RETIRED_PERSONAS: Record<string, string> = { overseer: 'coordinator', orchestrator: 'coordinator', reviewer: 'qa-triager' }

/**
 * Bundled skills shipped under another name now (HI-2463: what agents see says Combwork): a workspace copy of the old
 * one that is a version Combwork shipped, never changed, goes when the new one is added; one the user changed stays.
 */
export const RETIRED_SKILLS: Record<string, string> = { 'use-hive-api': 'use-cw-api' }

export const DEFAULT_SETTINGS: AppSettings = {
  keybindings: {},
  commands: { list: [], onQuit: { run: [] } },
  mcpCatalogs: { oursOn: true, sources: [] },
  updates: {
    checkAutomatically: true,
    downloadAutomatically: true,
    install: 'auto',
    prerelease: false
  },
  general: {
    closeToTray: true,
    minimizeToTray: false,
    startMinimized: false,
    launchAtLogin: false,
    reopenLastWorkspace: true,
    confirmOnQuit: 'working',
    showTips: true,
    keepAwake: 'plugged-in',
    progressPanel: true,
    progressCommands: true,
    dateFormat: 'ymd',
    timeFormat: '24h',
    userName: 'User', // i18n-ignore: a stored default name, which agents' wake lines quote
    language: 'auto'
  },
  appearance: {
    theme: 'dark',
    uiFontSize: 13,
    terminalFontFamily: "'Cascadia Code', 'Cascadia Mono', Consolas, 'Courier New', monospace", // i18n-ignore: CSS font names
    terminalFontSize: 13,
    terminalScrollback: 10000,
    terminalCursorBlink: true
  },
  providers: Object.fromEntries(PROVIDERS.map((p) => [p.id, defaultProviderSettings(p)])),
  // Automatic (#474): the first provider turned on and installed, in the order below.
  defaultProvider: AUTO_PROVIDER,
  providerOrder: [],
  // Hive's own order: no screen sets it since decision A (HI-2113); a 0.9 order is still read.
  notifications: {
    chimeEnabled: true,
    chimeSound: 'chime',
    chimeVolume: 0.6,
    desktopNotifications: true,
    notifyOnFinished: true,
    notifyOnWaiting: true,
    bannerScope: 'all',
    bannerPosition: 'bottom-right',
    bannerSeconds: 6,
    waitingBannerStays: true,
    taskbarCount: true,
    flashOnWaiting: true,
    suggestFreshStart: true
  },
  sessions: {
    backupTranscripts: true,
    backupRetention: 'off',
    cacheTtl: 'auto',
    confirmStop: true,
    compactSuggestTokens: 200000,
    transcriptWarnMB: 20,
    usageCacheSize: 5000,
    followTranscripts: false,
    overviewRefresh: 'live',
    defaultView: 'panes',
    tileOrder: 'panes',
    recordPerformance: true,
    resumeAfterUnexpectedClose: false
  },
  agentApi: {
    enabled: true,
    port: DEFAULT_API_PORT,
    provideCombworkMcp: true,
    allowSessionInput: false,
    devConsole: false
  },
  // The agents' model and effort (empty): a lighter choice saves tokens but makes the Assistant careless.
  assistant: {
    provider: '',
    mode: 'coordinator',
    control: 'projects',
    changeSettings: false,
    typingPause: 15,
    enterEndsPause: true,
    tellReplies: true,
    panelSide: 'right',
    compactSuggestTokens: 500000,
    providers: Object.fromEntries(PROVIDERS.map((p) => [p.id, { model: '', effort: '', permissionMode: '', extraArgs: '', use200kContext: '' }]))
  },
  agents: {
    backgroundTaskMinutes: 60,
    leftoverProcesses: 'ask'
  },
  board: {
    archiveDoneDays: 14,
    columnColors: true,
    colors: { ...DEFAULT_COLUMN_COLORS }
  },
  advanced: {
    showDeveloperFeatures: false
  }
}

export const DEFAULT_APP_CONFIG: AppConfig = {
  version: 9,
  settings: DEFAULT_SETTINGS,
  recentWorkspaces: [],
  lastWorkspace: null,
  activeProjects: {},
  window: { width: 1400, height: 900, maximized: false },
  ui: { sidebarWidth: 280, sidebarVisible: true },
  observedDefaultModel: {},
  planUsage: {},
  planWarnings: {}
}

export const DEFAULT_WORKSPACE_CONFIG: WorkspaceConfig = {
  version: 1,
  mcp: { enabled: [] }
}

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  version: 2,
  mcp: { disabled: [], enabled: [] },
  chime: 'inherit',
  suggestFreshStart: 'inherit',
  inboxCheckpoints: 'inherit',
  inboxStopContinuation: 'inherit',
  inboxIdleWakes: 'inherit',
  defaultProvider: 'inherit',
  providers: {},
  compactSuggestTokens: null,
  transcriptWarnMB: null,
  cardAttachmentCleanup: '30',
  agents: [],
  layout: 'auto',
  worktreeCopy: null,
  worktreeSetup: ''
}

/** The transcript viewer loads this many items at a time (the latest first, earlier ones as you scroll up). */
export const TRANSCRIPT_WINDOW = 200

export { AGENT_LIMIT_DEFAULT, AGENT_LIMIT_MAX }
/**
 * Why the user can't add another agent (HI-2058: Maximum agents binds the user too): the project's workflow allows `max`
 * (its Maximum agents), and where to raise it; at AGENT_LIMIT_MAX, the most any project can have.
 */
export const agentLimitText = (tr?: Tr, max: number = AGENT_LIMIT_MAX): string => {
  if (max >= AGENT_LIMIT_MAX)
    return tr
      ? tr(msg({ id: 'agents.limit.most', defaultMessage: 'A project can have up to {most, number} agents.', description: "Why another agent can't be added to a project: it has as many as Combwork allows ({most}, 24)." }), { most: AGENT_LIMIT_MAX })
      : `A project can have up to ${AGENT_LIMIT_MAX} agents.` // i18n-ignore: English for main's error (the window passes tr)
  return tr
    ? tr(msg({ id: 'agents.limit.workflow', defaultMessage: 'This project’s workflow allows {max, plural, one {# agent} other {# agents}}: raise Maximum agents in Version Control → Workflow.', description: "Why another agent can't be added to a project (HI-2058): its workflow option Maximum agents allows {max} and it has that many. Maximum agents, Version Control and Workflow are names in the window: as translated there." }), { max })
    : `This project's workflow sets Maximum agents to ${max}: raise it in Version Control → Workflow.` // i18n-ignore: English for main's error (the window passes tr)
}
/** The link beside agentLimitText at a project's Maximum agents (HI-2058): opens Version Control → Workflow. */
export const OPEN_WORKFLOW_OPTIONS = msg({ id: 'agents.limit.openWorkflow', defaultMessage: 'Open Workflow Options', description: "A button or link beside why another agent can't be added (HI-2058: the project is at its Maximum agents): opens the project's Version Control tab at Workflow, where Maximum agents is set." })
/**
 * Why the Assistant or the Agent API can't add another agent (HI-2001): the project's workflow allows `max` (Maximum
 * agents), and where the user raises it. Only agents read it, so it stays English.
 */
export const agentMaxText = (max: number): string =>
  `This project's workflow sets Maximum agents to ${max}, the user's team size, and the project has that many. Ask the user to raise Maximum agents in Version Control → Workflow.` // i18n-ignore: English for the Assistant and the Agent API (agents read it)
/** Memory as the agents note says it: MB, or GB from 1 GB. */
const memoryText = (n: number): string => (n >= 1024 ** 3 ? formatGigabytes(n) : formatSize(n))

/**
 * The note under Maximum agents (Version Control → Workflow, HI-2001; before, Settings → Advanced's Agents per project)
 * once it goes over the default (Darren, 11 Oct): what more agents cost, in
 * the machine's own figures (the memory running agents take now, measured; the computer's), and the plans' limits.
 */
export function manyAgentsNote(m: { running: { agents: number; bytes: number } | null; total: number; free: number }): string {
  const machine = { limit: AGENT_LIMIT_DEFAULT, total: memoryText(m.total), free: memoryText(m.free) }
  if (m.running && m.running.agents > 0) {
    return trNow(msg({ id: 'agents.limit.manyMeasured', defaultMessage: "More than {limit} agents: each runs its own copy of its CLI. {running, plural, one {Your # running agent takes} other {Your # running agents take}} {used} now (about {each} each); this computer has {total} of memory, {free} free. They all share your plans' usage limits, so they reach them sooner.", description: "Version Control → Workflow, under Maximum agents once it is over the default ({limit}): what more agents cost. {running} agents run now and take {used} of memory ({each} each); {total} and {free} are the computer's memory (\"16.0 GB\")." }), { ...machine, running: m.running.agents, used: memoryText(m.running.bytes), each: memoryText(m.running.bytes / m.running.agents) })
  }
  return trNow(msg({ id: 'agents.limit.many', defaultMessage: "More than {limit} agents: each runs its own copy of its CLI, roughly 200–500 MB of memory each; this computer has {total} of memory, {free} free. They all share your plans' usage limits, so they reach them sooner.", description: "Version Control → Workflow, under Maximum agents once it is over the default ({limit}): what more agents cost. {total} and {free} are the computer's memory (\"16.0 GB\")." }), machine)
}
/** An agent's role (#126) is at most this long. */
export const ROLE_MAX = 60
/** Adding the agent that makes this many: a note that each is its own CLI process. */
export const MANY_AGENTS = 7

/**
 * How many agents one page of the Session tab holds (#134): a pane each, so a page shows all its agents. One at a time
 * (Single) is one page of every agent, its tabs choosing which is shown, so it never has page buttons.
 */
export function agentsPerPage(layout: SessionLayout): number {
  return layout === 'single' ? AGENT_LIMIT_MAX : layoutPanes(layout)
}

/** How many agent pages `count` agents take, `perPage` to a page (at least one). */
export function agentPageCount(count: number, perPage: number): number {
  return Math.max(1, Math.ceil(count / Math.max(1, perPage)))
}

/** The page of the agent at this position (0 is page 1). */
export function pageOfAgent(index: number, perPage: number): number {
  return Math.max(0, Math.floor(index / Math.max(1, perPage)))
}

/** The agents on one page. */
export function pageAgents<T>(agents: T[], page: number, perPage: number): T[] {
  const n = Math.max(1, perPage)
  return agents.slice(page * n, (page + 1) * n)
}

/** The agents with one moved to `index`, its position afterwards (clamped). An unknown id leaves the order as it is. */
export function moveAgentTo<T extends { id: string }>(agents: readonly T[], id: string, index: number): T[] {
  const from = agents.findIndex((a) => a.id === id)
  if (from < 0) return [...agents]
  const rest = agents.filter((a) => a.id !== id)
  const to = Math.max(0, Math.min(rest.length, Math.round(index)))
  return [...rest.slice(0, to), agents[from], ...rest.slice(to)]
}

/**
 * The agents with two of them swapped (#135: an agent dropped on another's pane): each takes the other's place, across
 * pages too. An unknown id, or the same one twice, leaves the order as it is.
 */
export function swapAgentsIn<T extends { id: string }>(agents: readonly T[], a: string, b: string): T[] {
  const i = agents.findIndex((x) => x.id === a)
  const j = agents.findIndex((x) => x.id === b)
  if (i < 0 || j < 0 || i === j) return [...agents]
  const out = [...agents]
  ;[out[i], out[j]] = [out[j], out[i]]
  return out
}

/** Where an agent dropped before another one ends up (`before` null, or itself: at the end, or where it is). */
export function dropIndex(ids: readonly string[], id: string, before: string | null): number {
  if (before === id) return Math.max(0, ids.indexOf(id))
  const rest = ids.filter((x) => x !== id)
  const i = before === null ? -1 : rest.indexOf(before)
  return i < 0 ? rest.length : i
}

/** Where an agent dropped on a page's button ends up: that page's last place (the last agent's, on the last page). */
export function pageEndIndex(count: number, page: number, perPage: number): number {
  return Math.max(0, Math.min((page + 1) * Math.max(1, perPage) - 1, count - 1))
}

/** The project's agents, in the order the user put them (the order they were added, until moved). All are equal; a project can have none. */
export function projectAgents(cfg: Pick<ProjectConfig, 'agents'>): AgentDef[] {
  return Array.isArray(cfg.agents) ? cfg.agents.filter((a) => a && typeof a.id === 'string' && typeof a.name === 'string') : []
}

/** Terminal key of an agent's session. */
export function agentPtyKey(projectPath: string, agentId: string): string {
  return `session:${projectPath.toLowerCase()}#${agentId}`
}

/** The layout that shows this many agents (up to the 3×2 grid): the automatic layout. */
export function layoutForAgents(count: number): SessionLayout {
  return count >= 5 ? 'grid6' : count === 4 ? 'grid' : count === 3 ? 'columns3' : count === 2 ? 'columns2' : 'single'
}

/** Whether a saved layout is one Hive knows ('auto' included). */
const isLayout = (v: unknown): v is PageLayout => v === 'auto' || SESSION_LAYOUTS.some((l) => l.value === v)

/**
 * The project's layout (#134: one for the project, not one a page): the one chosen by hand, else the one that shows its
 * agents, up to the 3×2 grid. Its pages hold `agentsPerPage` agents each.
 */
export function projectLayout(cfg: Pick<ProjectConfig, 'agents' | 'layout'>): SessionLayout {
  const chosen = cfg.layout
  if (chosen && chosen !== 'auto' && isLayout(chosen)) return chosen
  return layoutForAgents(projectAgents(cfg).length)
}

/** How many agents a page of this project's Session tab holds. */
export const projectPerPage = (cfg: Pick<ProjectConfig, 'agents' | 'layout'>): number => agentsPerPage(projectLayout(cfg))

/** How many panes a layout has side by side. */
export function layoutColumns(layout: SessionLayout): number {
  return layout === 'grid' ? 2 : layout === 'grid6' ? 3 : layoutPanes(layout)
}

/** The layout with a column fewer: the grids keep two rows, then one at a time. */
const NARROWER: Record<SessionLayout, SessionLayout> = { single: 'single', columns2: 'single', columns3: 'columns2', grid: 'single', grid6: 'grid' }

/**
 * How many panes fit side by side in `width`, each `paneMin` wide, given how many did (`was`): fewer as soon as they
 * don't fit, more only `margin` past where they would, so a pixel either way at the boundary doesn't flip the layout.
 */
export function paneColumnsFor(width: number, paneMin: number, was: number | null, margin: number): number {
  const fit = Math.max(1, Math.floor(width / paneMin))
  if (was === null || fit < was) return fit
  return Math.max(was, Math.floor((width - margin) / paneMin))
}

/** The most of the Session tab's width the focus view's strip takes, above its least (#1050): the terminal comes first. */
export const TILE_STRIP_SHARE = 0.4

/**
 * How wide the focus view's strip may be in a Session tab `width` wide, beside a pane `paneMin` wide, given what it was
 * (`was`). The terminal comes first (#1050): the strip takes at most TILE_STRIP_SHARE of the width, and of the room above
 * both least widths (its `least` and `paneMin`) at most half, past `margin`, so it is at its least while the pane still
 * has `margin` over its own, whatever the terminal's font. Hidden (0) when even its least leaves the pane too little, and
 * shown again only `margin` past that, so a pixel either way doesn't toggle it (#1037).
 */
export function tileStripRoom(width: number, paneMin: number, least: number, was: number | null, margin: number): number {
  const spare = width - paneMin - least
  if (spare < (was === 0 ? margin : 0)) return 0
  return least + Math.max(0, Math.min(Math.floor(width * TILE_STRIP_SHARE) - least, Math.floor((spare - margin) / 2)))
}

/**
 * The layout shown for the one chosen when only `columns` panes fit side by side (#1037: narrower, a terminal can't be
 * fitted to its pane): it drops columns until they fit, down to one at a time. null: no limit.
 */
export function layoutFitting(layout: SessionLayout, columns: number | null): SessionLayout {
  if (columns === null) return layout
  let l = layout
  while (l !== 'single' && layoutColumns(l) > columns) l = NARROWER[l]
  return l
}

/**
 * The Session tab's view for a project (#975): the one its Panes | Tiles toggle chose, else Settings → Sessions → Default
 * session view, else Panes.
 */
export function projectSessionView(cfg: Pick<ProjectConfig, 'sessionView'>, settings: Pick<AppSettings, 'sessions'> | null | undefined): SessionView {
  const chosen = cfg.sessionView
  if (chosen === 'panes' || chosen === 'tiles') return chosen
  return settings?.sessions.defaultView === 'tiles' ? 'tiles' : 'panes'
}

/** The layout to save when one is chosen: choosing the one that shows the agents makes it automatic again. */
export function chosenLayout(cfg: Pick<ProjectConfig, 'agents'>, layout: SessionLayout): PageLayout {
  return layout === layoutForAgents(projectAgents(cfg).length) ? 'auto' : layout
}

/**
 * The file lock modes (#71). Their English is the settings catalogue's, which the Assistant's tools read; `text` is the
 * window's words (#800), shown with shownText().
 */
export const FILE_LOCK_MODES: { value: FileLockMode; label: string; description: string; text: { label: Msg; description: Msg } }[] = [
  {
    value: 'block',
    label: 'Block', // i18n-ignore: the catalogue's English (text is the window's)
    description: 'An agent that tries to edit a file another agent is editing is told to wait or work on something else.', // i18n-ignore: the catalogue's English (text is the window's)
    text: {
      label: msg({ id: 'agents.fileLock.block', defaultMessage: 'Block', description: "A file lock mode (Settings, a project's settings): an agent may not edit a file another agent is editing. Keep it short." }),
      description: msg({ id: 'agents.fileLock.blockDescription', defaultMessage: 'An agent that tries to edit a file another agent is editing is told to wait or work on something else.', description: 'What the Block file lock mode does.' })
    }
  },
  {
    value: 'ask',
    label: 'Ask me', // i18n-ignore: the catalogue's English (text is the window's)
    description: 'The edit waits for your approval, like a permission prompt.', // i18n-ignore: the catalogue's English (text is the window's)
    text: {
      label: msg({ id: 'agents.fileLock.ask', defaultMessage: 'Ask me', description: "A file lock mode (Settings, a project's settings): the user approves an edit of a file another agent is editing. Keep it short." }),
      description: msg({ id: 'agents.fileLock.askDescription', defaultMessage: 'The edit waits for your approval, like a permission prompt.', description: 'What the Ask me file lock mode does.' })
    }
  },
  {
    value: 'warn',
    label: 'Warn', // i18n-ignore: the catalogue's English (text is the window's)
    description: 'The edit goes ahead, and the agent is told another agent is editing the file.', // i18n-ignore: the catalogue's English (text is the window's)
    text: {
      label: msg({ id: 'agents.fileLock.warn', defaultMessage: 'Warn', description: "A file lock mode (Settings, a project's settings): the edit goes ahead with a warning to the agent. Keep it short." }),
      description: msg({ id: 'agents.fileLock.warnDescription', defaultMessage: 'The edit goes ahead, and the agent is told another agent is editing the file.', description: 'What the Warn file lock mode does.' })
    }
  },
  {
    value: 'off',
    label: 'Off', // i18n-ignore: the catalogue's English (text is the window's)
    description: 'Agents edit freely. Use with care when several agents share the project folder.', // i18n-ignore: the catalogue's English (text is the window's)
    text: {
      label: msg({ id: 'agents.fileLock.off', defaultMessage: 'Off', description: "A file lock mode (Settings, a project's settings): no locking. Keep it short." }),
      description: msg({ id: 'agents.fileLock.offDescription', defaultMessage: 'Agents edit freely. Use with care when several agents share the project folder.', description: 'What the Off file lock mode does.' })
    }
  }
]

/** The session layouts. `label` is the English templates and commands keep (#800: `text` is the window's words). */
export const SESSION_LAYOUTS: { value: SessionLayout; label: string; text: Msg; panes: number; icon: string }[] = [
  { value: 'single', label: 'One at a time', text: msg({ id: 'agents.layout.single', defaultMessage: 'One at a time', description: 'A session layout: one agent pane at a time. Keep it short.' }), panes: 1, icon: 'layout-single' }, // i18n-ignore: the English label (text is the window's)
  { value: 'columns2', label: 'Two columns', text: msg({ id: 'agents.layout.columns2', defaultMessage: 'Two columns', description: 'A session layout: two agent panes side by side. Keep it short.' }), panes: 2, icon: 'layout-columns2' }, // i18n-ignore: the English label (text is the window's)
  { value: 'columns3', label: 'Three columns', text: msg({ id: 'agents.layout.columns3', defaultMessage: 'Three columns', description: 'A session layout: three agent panes side by side. Keep it short.' }), panes: 3, icon: 'layout-columns3' }, // i18n-ignore: the English label (text is the window's)
  { value: 'grid', label: 'Grid of four', text: msg({ id: 'agents.layout.grid', defaultMessage: 'Grid of four', description: 'A session layout: four agent panes, two by two. Keep it short.' }), panes: 4, icon: 'layout-grid' }, // i18n-ignore: the English label (text is the window's)
  { value: 'grid6', label: 'Grid of six', text: msg({ id: 'agents.layout.grid6', defaultMessage: 'Grid of six', description: 'A session layout: six agent panes, three by two. Keep it short.' }), panes: 6, icon: 'layout-grid6' } // i18n-ignore: the English label (text is the window's)
]

export function layoutPanes(layout: SessionLayout | undefined): number {
  return SESSION_LAYOUTS.find((l) => l.value === layout)?.panes ?? 1
}

const URGENCY: Record<string, number> = { signin: 8, waiting: 7, working: 6, background: 5, error: 4, starting: 3, finished: 2, ready: 1, stopped: 0 }

/**
 * The state that speaks for several agents in one dot: the most urgent status (needs input, then
 * working…), marked unseen if any agent has something you haven't looked at.
 */
export function mostUrgent<T extends { status: string; unseen?: boolean }>(states: (T | null | undefined)[]): T | null {
  const list = states.filter((s): s is T => !!s)
  if (!list.length) return null
  const top = list.reduce((a, b) => ((URGENCY[b.status] ?? 0) > (URGENCY[a.status] ?? 0) ? b : a))
  return list.some((s) => s.unseen) && !top.unseen ? { ...top, unseen: true } : top
}

/** The status message of a session while it compacts its conversation (started from Hive or by the CLI itself). */
export const COMPACTING_MESSAGE = 'Compacting the conversation…' // i18n-ignore: a stored status message that isCompacting compares (the window's words are the session statuses', E10c)

/** Whether a session is compacting its conversation now. */
export function isCompacting(live: { status: SessionStatus; statusMessage?: string } | null | undefined): boolean {
  return live?.status === 'working' && live.statusMessage === COMPACTING_MESSAGE
}

/**
 * Why a worktree agent's work can't be merged now, or null. A merge takes its branch as committed (#1347), so not while
 * the agent may still be committing to it, in the middle of a task (working, asking you something, waiting on background tasks or on cards).
 */
export function mergeBlocked(name: string, status: SessionStatus | null | undefined, tr?: Tr): string | null {
  const why = status === 'starting' ? 'working' : status
  if (why !== 'working' && why !== 'waiting' && why !== 'background' && why !== 'watching' && why !== 'signin') return null
  if (tr) return tr(msg({ id: 'agents.merge.blocked', defaultMessage: '{why, select, waiting {{agent} is waiting for your answer. Merge once it has finished.} background {{agent} is waiting on background tasks it started. Merge once it has finished.} watching {{agent} is waiting for cards to change (a card watch) and carries on when they do. Merge once it has finished, or cancel its watch first.} signin {{agent} stopped in the middle of a task when its sign-in expired. Sign in again and let it finish first.} other {{agent} is working. Merge once it has finished.}}', description: "Why a worktree agent's work can't be merged now ({agent}: its name), by what it is doing: answering the user (waiting), waiting on its own background tasks, waiting for cards to change (a card watch), stopped by an expired sign-in, or working (other)." }), { agent: name, why })
  switch (why) {
    case 'working':
      return `${name} is working. Merge once it has finished.` // i18n-ignore: English for main's error (the window passes tr)
    case 'waiting':
      return `${name} is waiting for your answer. Merge once it has finished.` // i18n-ignore: English for main's error (the window passes tr)
    case 'background':
      return `${name} is waiting on background tasks it started. Merge once it has finished.` // i18n-ignore: English for main's error (the window passes tr)
    case 'watching':
      return `${name} is waiting for cards to change (a card watch) and carries on when they do. Merge once it has finished, or cancel its watch first.` // i18n-ignore: English for main's error (the window passes tr)
    case 'signin':
      return `${name} stopped in the middle of a task when its sign-in expired. Sign in again and let it finish first.` // i18n-ignore: English for main's error (the window passes tr)
  }
}

/**
 * Whether stopping an agent at the Assistant's request asks the user first: when it is in the middle of something
 * (starting, working, asking, waiting on background tasks). One only watching cards or agents is idle (HI-1994): no
 * turn runs and its conversation is kept, so it is stopped without asking, as an idle one is.
 */
export const stopAsksUser = (status: SessionStatus | null | undefined): boolean =>
  status === 'starting' || status === 'working' || status === 'waiting' || status === 'background'

/** Folder-safe slug for branch and worktree names: "Agent 2" → "agent-2". */
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 40) || 'agent'
}

/** Friendly model name, as the provider names it ("claude-opus-5-5" → "Opus 5.5"). */
export function modelLabel(model: string, provider: string = DEFAULT_PROVIDER): string {
  return providerDescriptor(provider).modelLabel(model)
}

/** The model an agent runs, for display (#248): its name, and the choice it came from when that reads differently. */
export interface ModelShown {
  /** "Opus 5.5", "Opus 5.5 (default)" when nothing chose it (the CLI's own), "Claude Code default" when unknown. */
  label: string
  /** The choice's own name when it isn't the model's ("Opus", an alias), else null. */
  chosenAs: string | null
}

/**
 * The model an agent's sessions run, for display (#248): the running session's model when it reports one (`running`:
 * the status line's or the transcript's model id), else what the choice resolves to (an alias by the model the CLI says
 * it stands for), else the CLI's default model. Never guessed: what nothing resolves shows as the CLI or provider names
 * it. A model chosen (its connection's) shows plainly; one the CLI picks is marked "(default)".
 */
export function agentModelShown(provider: ProviderId, chosen: string | undefined, globalModel: string, info: ModelInfo, running?: string | null): ModelShown {
  const own = chosen && chosen !== 'inherit' ? chosen : ''
  // Nothing chosen in Hive: the CLI's default, which its own settings may give as an alias too (Claude Code's `model`).
  const choice = own || globalModel || info?.defaultModel || ''
  const name = running ? modelIdName(provider, running, info) : choice ? runsAsName(provider, choice, info) : null
  if (!name) return { label: trNow(msg({ id: 'agents.model.cliDefault', defaultMessage: '{cli} default', description: "An agent's model when nothing is chosen and the CLI doesn't say which it uses: the CLI's own default ({cli}: \"Claude Code\")." }), { cli: providerDescriptor(provider).name }), chosenAs: null }
  // The CLI's default is named in the tooltip only when it is an alias ("chosen as Opus"): an id was nobody's choice.
  const fromCli = !own && !globalModel
  const picked = choice && (!fromCli || resolvedModel(info, choice) !== choice) ? chosenName(provider, choice, info) : null
  return { label: own ? name : trNow(msg({ id: 'agents.model.inherited', defaultMessage: '{model} (default)', description: "An agent's model when nothing chose it, so its coding agent (CLI) runs its own default: {model} is its name (\"Opus 5.5\"). A model chosen on the agent's connection is shown without this." }), { model: name }), chosenAs: picked && picked !== name ? picked : null }
}

/**
 * What a pane's footer resolves its model and effort from (HI-1996): a running session's own launch (`launchedWith`:
 * the model and effort it was given, after HI-1770's dropped effort), never the settings as they are now; a new
 * session's, the agent's as the window reads it (its connection's values, agentLaunchView): HI-2106 launches with no
 * project or Settings layer, so none is shown (HI-2398). The CLI's reports come first either way.
 * `modelGlobal` is a model the agent didn't choose itself (shown "(default)"); empty, with no model, its CLI's default.
 */
export function footerChoices(
  a: { model?: string; effort?: string },
  live: { launchedWith?: { model: string | null; effort: string | null; own?: true } } | null | undefined
): { model: string | undefined; modelGlobal: string; effort: string | undefined; effortGlobal: string | undefined } {
  const launched = live?.launchedWith
  if (launched) {
    const own = !!launched.model && !!launched.own
    return { model: own ? launched.model! : undefined, modelGlobal: own ? '' : (launched.model ?? ''), effort: launched.effort ?? undefined, effortGlobal: undefined }
  }
  return { model: a.model, modelGlobal: '', effort: a.effort, effortGlobal: undefined }
}

/**
 * A launch's record of the model and effort it was given (HI-1996, LiveSessionState.launchedWith): a model given is its
 * connection's, chosen there (HI-2106 launches with no other layer), so its own; none, its CLI's default (HI-2398).
 */
export function launchedWithOf(model: string | null | undefined, effort: string | null | undefined): { model: string | null; effort: string | null; own?: true } {
  return { model: model ?? null, effort: effort ?? null, ...(model && model !== 'inherit' ? { own: true as const } : {}) }
}

/** agentModelShown's label for new sessions (no running model). */
export function effectiveModelLabel(provider: ProviderId, chosen: string | undefined, globalModel: string, info: ModelInfo): string {
  return agentModelShown(provider, chosen, globalModel, info).label
}

/** Context size at which a project's Compact button is highlighted (0 = never). */
export function compactThreshold(project: { compactSuggestTokens?: number | null } | null | undefined, globalTokens: number): number {
  const p = project?.compactSuggestTokens
  return typeof p === 'number' && p >= 0 ? p : globalTokens
}

/**
 * How full the context window is, in whole percent (0–100), or null when the window isn't known. The window is
 * only ever what the CLI reports for the session (Claude Code's status line, Codex's rollout), never guessed from
 * the model: Claude Code's 1M window depends on the model and the plan.
 */
export function contextPercent(tokens: number, window: number | null | undefined): number | null {
  if (!window || window <= 0) return null
  return Math.min(100, Math.round((Math.max(0, tokens) / window) * 100))
}

/** The transcript size (MB) past which a session is flagged in a project (its own setting, else the global one); 0 never. */
export function transcriptWarnLimit(project: { transcriptWarnMB?: number | null } | null | undefined, globalMB: number): number {
  const p = project?.transcriptWarnMB
  return typeof p === 'number' && p >= 0 ? p : globalMB
}

/** A session's transcript size in the Sessions list (#671), as the footer shows it: "—" with no file to measure; long once past limitMB (0 never). */
export function transcriptSizeInfo(bytes: number | null | undefined, limitMB: number): { text: string; long: boolean } {
  if (typeof bytes !== 'number' || !(bytes >= 0)) return { text: '—', long: false }
  return { text: formatSize(bytes), long: limitMB > 0 && bytes >= limitMB * 1024 * 1024 }
}

/** Claude Code's plan limits as 0.1 stored them. */
const V1_LIMITS: Record<string, Pick<PlanLimit, 'id' | 'label' | 'windowMinutes'>> = {
  fiveHour: { id: 'five_hour', label: '5-hour', windowMinutes: 300 }, // i18n-ignore: labels as 0.1 stored them (a migration)
  sevenDay: { id: 'seven_day', label: 'weekly', windowMinutes: 10080 } // i18n-ignore: labels as 0.1 stored them (a migration)
}

/**
 * Upgrades a config saved by an older version. `raw` is the file as read (before defaults were merged
 * in), so version 1 (Claude Code only, 0.1.x) can be told apart from a fresh install.
 */
/** The Assistant's model and effort defaults before 0.3, saved into every config. */
const OLD_ASSISTANT_DEFAULTS: Record<string, { model?: string; effort: string }> = { 'claude-code': { model: 'sonnet', effort: 'low' }, codex: { effort: 'low' } }

export function migrateConfig(cfg: AppConfig, raw?: Record<string, any>): AppConfig {
  // HI-1954: Hive's commands cleaned, and HI-1368's When Hive quits, run adopted as one of them (once; written next save).
  cfg.settings.commands = migrateCombworkCommands({ commands: raw?.settings?.commands, onQuit: raw?.settings?.general?.onQuit }, trNow(MIGRATED_QUIT))
  delete cfg.settings.general.onQuit
  const g = cfg.settings.general
  const q = g.confirmOnQuit as unknown
  // 0.1 stored on/off; "on" asked whenever sessions ran, which maps to asking when an agent is working.
  if (typeof q === 'boolean') g.confirmOnQuit = q ? 'working' : 'never'
  else if (q !== 'working' && q !== 'always' && q !== 'never') g.confirmOnQuit = 'working'

  if (raw && (raw.version ?? 1) < 2) {
    // 0.1.x ran Claude Code only: its settings become Claude Code's, and it stays enabled.
    const old = (raw.settings?.claude ?? {}) as Record<string, any>
    const c: ProviderSettings = { ...cfg.settings.providers[CLAUDE_CODE], enabled: true }
    for (const k of ['executablePath', 'defaultModel', 'defaultEffort', 'defaultPermissionMode', 'extraArgs', 'checkUpdatesOnLaunch'] as const) {
      if (old[k] !== undefined) (c as unknown as Record<string, unknown>)[k] = old[k]
    }
    if (typeof old.enableBypassOption === 'boolean') c.enableDangerousMode = old.enableBypassOption
    cfg.settings.providers[CLAUDE_CODE] = c
    cfg.settings.defaultProvider = CLAUDE_CODE
    const oldModel = raw.observedDefaultModel
    cfg.observedDefaultModel = typeof oldModel === 'string' && oldModel ? { [CLAUDE_CODE]: oldModel } : {}
    const oldUsage = raw.planUsage
    cfg.planUsage = {}
    if (oldUsage && typeof oldUsage === 'object' && !('limits' in oldUsage)) {
      const limits: PlanLimit[] = []
      for (const [key, meta] of Object.entries(V1_LIMITS)) {
        const l = oldUsage[key]
        if (l && typeof l.usedPercent === 'number') limits.push({ ...meta, usedPercent: l.usedPercent, resetsAt: l.resetsAt ?? null })
      }
      if (limits.length) cfg.planUsage[CLAUDE_CODE] = { provider: CLAUDE_CODE, plan: null, limits, updatedAt: oldUsage.updatedAt ?? new Date(0).toISOString() } as PlanUsage
    }
    const warnings: AppConfig['planWarnings'] = {}
    for (const [k, v] of Object.entries(raw.planWarnings ?? {})) {
      const meta = V1_LIMITS[k]
      warnings[meta ? `${CLAUDE_CODE}:${meta.id}` : k] = v as AppConfig['planWarnings'][string]
    }
    cfg.planWarnings = warnings
  }
  if (raw && (raw.version ?? 1) < 3) {
    // 0.2 saved a lighter model and effort as the Assistant's defaults; they now follow the agents'.
    for (const [id, old] of Object.entries(OLD_ASSISTANT_DEFAULTS)) {
      const a = cfg.settings.assistant.providers[id]
      if (!a) continue
      if (old.model && a.model === old.model) a.model = ''
      if (a.effort === old.effort) a.effort = ''
    }
  }
  migrateAgentsWorktreeSettings(cfg)
  // HI-1766: Settings → Agents → File locks is Hive's workflow default.
  migrateGlobalFileLocks(cfg.settings)
  if (raw && (raw.version ?? 1) < 5 && cfg.settings.sessions.transcriptWarnMB === 50) {
    // 50 MB was the default up to 0.3.x (saved into every config); long transcripts slow things well before that.
    // Anyone who wants 50 sets it again.
    cfg.settings.sessions.transcriptWarnMB = 20
  }
  migratePersonaNames(cfg, raw)
  if (raw && (raw.version ?? 1) < 7) {
    // Up to 0.3.x Hive shipped character personas; working modes replaced them (#259): a default persona that went
    // becomes the closest mode.
    const was = cfg.settings.assistant.mode
    if (RETIRED_PERSONAS[was]) cfg.settings.assistant.mode = RETIRED_PERSONAS[was]
  }
  if (raw && (raw.version ?? 1) < 8 && cfg.settings.defaultProvider === CLAUDE_CODE) {
    // Claude Code was the default up to 0.4.x (saved into every config), so nobody could tell it from a choice: it
    // becomes Automatic (#474), which still picks Claude Code wherever it is turned on and installed. A Codex or
    // Copilot default was chosen, and stays.
    cfg.settings.defaultProvider = AUTO_PROVIDER
  }
  const notifications = cfg.settings.notifications as unknown as Record<string, unknown>
  if (raw && (raw.version ?? 1) < 9) {
    // HI-2320: one notification system. *While Hive is focused* went: Windows notifications only with no Hive window
    // focused. Show nothing (version 6 on; before it, "Only when Hive is in the background" moved everyone to Show in
    // Hive) becomes *Only in the bell* for agents' pop-ups, which keeps the Windows notifications in the background;
    // a Windows notification while focused becomes a pop-up. The banners' old default place, top centre, moves to the
    // pop-ups' corner, bottom right (Darren, 2 Nov); any other place chosen is kept.
    const was = (raw.version ?? 1) < 6 ? 'inApp' : notifications.whileFocused
    if (was === 'nothing') notifications.bannerScope = 'none'
    if (notifications.bannerPosition === 'top-center') notifications.bannerPosition = 'bottom-right'
  }
  delete notifications.whileFocused
  delete notifications.onlyWhenUnfocused
  cfg.version = 9
  // Settings for providers this version doesn't know are kept (a newer Hive wrote them), but never used.
  if (!isDefaultProviderValue(cfg.settings.defaultProvider)) cfg.settings.defaultProvider = AUTO_PROVIDER
  // 0.9's providers' order (HI-1965): no list follows it since HI-2139, but the migration reads it (what Automatic
  // picked), so it is kept as it was saved: a list of ids, each once; ids this Hive doesn't know are kept (a newer Hive's).
  const order: unknown = cfg.settings.providerOrder
  cfg.settings.providerOrder = Array.isArray(order) ? [...new Set(order.filter((x): x is ProviderId => typeof x === 'string' && x.length > 0 && x.length <= 64))] : []
  // Its revision went with the window's moves (HI-2113).
  delete (cfg.settings as unknown as Record<string, unknown>).providerOrderRevision
  return cfg
}

/**
 * The settings as 0.1.x reads them: `claude` mirrors Claude Code's provider settings, so going back to
 * an older Hive keeps them. Newer versions ignore it.
 */
export function withLegacySettings(cfg: AppConfig): AppConfig & { settings: AppSettings & { claude: Record<string, unknown> } } {
  const c = cfg.settings.providers[CLAUDE_CODE] ?? defaultProviderSettings(providerDescriptor(CLAUDE_CODE))
  const legacyMode = c.defaultPermissionMode === 'bypassPermissions' ? 'auto' : c.defaultPermissionMode
  return {
    ...cfg,
    settings: {
      ...cfg.settings,
      claude: {
        executablePath: c.executablePath,
        defaultModel: c.defaultModel,
        defaultEffort: c.defaultEffort,
        defaultPermissionMode: legacyMode,
        enableBypassOption: c.enableDangerousMode,
        extraArgs: c.extraArgs,
        checkUpdatesOnLaunch: c.checkUpdatesOnLaunch
      }
    }
  }
}

/** Hive's own default for the git-ignored files copied into each new slot and review copy (HI-1765). */
export const SLOT_COPY_DEFAULT = '.env*'

/**
 * Until 1.0's HI-1765, Settings → Agents & Worktrees had "Copy into new worktrees" (`agents.worktreeCopy`) and "Default
 * merge style" (`agents.mergeStyle`). The copy is now Hive's slot default (`slotDefaults.copy`, a workflow default for
 * Git): a value saved there moves over, unless the new one is already set or it is the old default (saved into every
 * config, so nobody chose it: the built-in default stands). The merge style went: the merge dialogs follow each
 * project's own. Both old keys are dropped on every load, so they can't come back.
 */
function migrateAgentsWorktreeSettings(cfg: AppConfig): void {
  const agents = cfg.settings.agents as AppSettings['agents'] & { worktreeCopy?: unknown; mergeStyle?: unknown }
  const old = agents.worktreeCopy
  if (typeof old === 'string' && old !== SLOT_COPY_DEFAULT && cfg.settings.slotDefaults?.copy === undefined) cfg.settings.slotDefaults = { ...cfg.settings.slotDefaults, copy: old }
  delete agents.worktreeCopy
  delete agents.mergeStyle
}

/**
 * Until 0.9.3 the Assistant's modes were called personas (#1084): its default mode was `assistant.persona`, and the
 * command and tip that show them were `view.personas` and `personas`. Their new names take over what the old ones had
 * (a shortcut given to the command, a tip seen), unless the new ones already have something.
 */
function migratePersonaNames(cfg: AppConfig, raw: Record<string, any> | undefined): void {
  const a = cfg.settings.assistant as AppSettings['assistant'] & { persona?: unknown }
  const was = raw?.settings?.assistant?.persona
  if (typeof was === 'string' && was && raw?.settings?.assistant?.mode === undefined) a.mode = was
  delete a.persona
  const keys = cfg.settings.keybindings
  if (keys && 'view.personas' in keys) {
    if (!('view.modes' in keys)) keys['view.modes'] = keys['view.personas']
    delete keys['view.personas']
  }
  const tips = cfg.ui?.tips as { seen?: unknown; used?: unknown } | undefined
  const rename = (list: unknown, from: string, to: string): unknown => (Array.isArray(list) && list.includes(from) ? [...new Set(list.map((x) => (x === from ? to : x)))] : list)
  if (tips && typeof tips === 'object') {
    tips.seen = rename(tips.seen, 'personas', 'modes')
    tips.used = rename(tips.used, 'view.personas', 'view.modes')
  }
}

/**
 * Upgrades a project.json read from disk (before defaults are merged in). Projects from 0.1.x ran
 * Claude Code only: their model, effort, mode and arguments become Claude Code's, and the project's
 * default provider is Claude Code, so its existing agents (which name no provider) stay on it.
 */
export function migrateProjectConfig(raw: Record<string, any>): Record<string, any> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  let out = withoutSkillSwitches(raw)
  // Since the accounts migration (HI-2106) a project has no provider settings: never made again from 0.1's fields.
  if (out.providers === undefined && !out.migrations?.accounts1) {
    // 0.1's model, effort, mode and arguments were Claude Code's.
    const legacy: Partial<ProjectProviderConfig> = {}
    for (const k of ['model', 'effort', 'permissionMode', 'extraArgs'] as const) if (out[k] !== undefined) legacy[k] = out[k]
    const { model: _m, effort: _e, permissionMode: _p, extraArgs: _x, ...rest } = out
    out = { ...rest, providers: Object.keys(legacy).length ? { [CLAUDE_CODE]: legacy } : {} }
  }
  if ((Number(out.version) || 1) < 2) {
    // 0.2.0: agents are all equal and none is made by default, so 0.1's agents (and their layout) are
    // cleared. Their sessions stay in sessions.json and can be resumed by an agent added again.
    out = { ...out, version: 2, agents: [], sessionLayout: 'single' }
  }
  if (out.layouts === undefined && out.layout === undefined) {
    // Before agent pages, one layout was set to show every agent whenever one was added. One that does (or
    // none) becomes automatic; any other was chosen by hand and is kept.
    const { sessionLayout: legacy, ...rest } = out
    const count = Array.isArray(rest.agents) ? rest.agents.length : 0
    const chosen = SESSION_LAYOUTS.some((l) => l.value === legacy) && legacy !== layoutForAgents(count)
    out = { ...rest, layout: chosen ? legacy : 'auto' }
  }
  if (out.layout === undefined) {
    // One layout a page (0.3) becomes one for the project (#134): page 1's, else automatic.
    const { layouts, ...rest } = out
    const first = Array.isArray(layouts) ? layouts[0] : undefined
    out = { ...rest, layout: isLayout(first) ? first : 'auto' }
  } else if (out.layouts !== undefined) {
    const { layouts: _old, ...rest } = out
    out = rest
  }
  if (!isLayout(out.layout)) out = { ...out, layout: 'auto' }
  if (Array.isArray(out.agents) && out.agents.some((a: unknown) => !!a && typeof a === 'object' && 'persona' in a)) {
    // Until 0.9.3 the Hive Assistant's mode was its persona (#1084).
    out = { ...out, agents: out.agents.map((a: unknown) => (a && typeof a === 'object' && 'persona' in a ? withMode(a as Record<string, unknown>) : a)) }
  }
  // HI-1766: Card loops and File locks are the project's workflow options.
  return migrateProjectPreferences(out)
}

/** A record from before 0.9.3 (an agent, a session) with its `persona` as its `mode` (#1084). */
export function withMode<T extends Record<string, unknown>>(rec: T): T {
  const { persona, ...rest } = rec
  return (typeof persona === 'string' && rest.mode === undefined ? { ...rest, mode: persona } : rest) as unknown as T
}

/**
 * project.json as written: Claude Code's project settings are also kept in 0.1.x's flat fields. Once the accounts
 * migration removed the project's launch settings (HI-2106: its agents' connections hold them), neither they nor its
 * default provider are written again.
 */
export function withLegacyProjectFields(cfg: ProjectConfig): ProjectConfig & Partial<ProjectProviderConfig> {
  if (cfg.migrations?.accounts1) {
    const { providers: _p, defaultProvider: _d, model: _m, effort: _e, permissionMode: _pm, extraArgs: _x, ...rest } = cfg as ProjectConfig & Partial<ProjectProviderConfig>
    return rest as ProjectConfig
  }
  const c = cfg.providers?.[CLAUDE_CODE]
  return c ? { ...cfg, model: c.model, effort: c.effort, permissionMode: c.permissionMode, extraArgs: c.extraArgs } : cfg
}

/**
 * A workspace.json or project.json without the skill switches from before 0.2 (`skills.enabled` / `skills.disabled`),
 * which nothing reads: every skill is available to its audience. They go when the file is next saved.
 */
export function withoutSkillSwitches<T extends Record<string, any>>(raw: T): T {
  if (!raw || typeof raw !== 'object' || !('skills' in raw)) return raw
  const { skills: _skills, ...rest } = raw
  return rest as T
}

export function mergeDefaults<T>(defaults: T, saved: unknown): T {
  if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) {
    return (saved === undefined ? defaults : (saved as T)) ?? defaults
  }
  if (defaults === null || typeof defaults !== 'object' || Array.isArray(defaults)) return saved as T
  const out: Record<string, unknown> = { ...(defaults as Record<string, unknown>) }
  for (const [k, v] of Object.entries(saved as Record<string, unknown>)) {
    const d = (defaults as Record<string, unknown>)[k]
    out[k] = d !== undefined && d !== null && typeof d === 'object' && !Array.isArray(d) ? mergeDefaults(d, v) : v
  }
  return out as T
}

/**
 * Effort to show next to the model: what the running session reports, else what new sessions use
 * (the agent's or project's choice, then the global default). With none of those, the model's own default when the
 * CLI said what it is ("Medium (default)", models.ts modelCaps); else null.
 */
export function effortLabel(provider: string, live: string | undefined, chosen: string | undefined, global: string | undefined, modelDefault?: string | null, settings?: Pick<AppSettings, 'providers'> | null): string | null {
  // The names the pickers use: the effort fallback as the user named it, else the descriptor's (#230).
  const name = (v: string): string => effortName(provider, v, settings, trNow)
  const v = live || (chosen && chosen !== 'inherit' ? chosen : global)
  if (v) return name(v)
  return modelDefault ? trNow(msg({ id: 'agents.effort.inherited', defaultMessage: '{effort} (default)', description: "An agent's effort level when nobody chose one: the model's default ({effort}: \"High\")." }), { effort: name(modelDefault) }) : null
}

/** Whether a session record ran in the folder an agent works in (its worktree, or the project folder). */
export function sessionInAgentFolder(projectPath: string, a: object, rec: Pick<SessionRecord, 'cwd'>): boolean {
  const folder = (legacyWorktree(a)?.path ?? projectPath).toLowerCase()
  return (rec.cwd ?? projectPath).toLowerCase() === folder
}

/**
 * The session an agent's Resume opens: its last session, else the latest one it ran, else the latest
 * one no current agent owns (its agent was removed, e.g. by the 0.2 upgrade). Archived sessions,
 * sessions from another folder and sessions open in another agent are skipped; the agent's own in the
 * project's slots (`slotFolders`, #1434) count, wherever they are (whether they may resume there is
 * agentFolders' hold). Callers pass only records of the agent's provider.
 */
export function resumeRecord<R extends Pick<SessionRecord, 'id' | 'archived' | 'lastActiveAt'> & Partial<Pick<SessionRecord, 'cwd' | 'agentId' | 'sub'>>>(
  projectPath: string,
  a: Pick<AgentDef, 'id' | 'lastSessionId'>,
  records: R[],
  open: Set<string>,
  agentIds: Set<string> = new Set([a.id]),
  slotFolders: readonly string[] = []
): R | null {
  const inSlot = (r: R): boolean => !!r.cwd && r.agentId === a.id && slotFolders.some((f) => samePath(f, r.cwd!))
  const usable = records
    .filter((r) => !r.archived && !r.sub && !open.has(r.id) && (sessionInAgentFolder(projectPath, a, r) || inSlot(r)))
    .sort((x, y) => (y.lastActiveAt ?? '').localeCompare(x.lastActiveAt ?? ''))
  return (
    usable.find((r) => r.id === a.lastSessionId) ??
    usable.find((r) => !!legacyWorktree(a) || r.agentId === a.id) ??
    usable.find((r) => !r.agentId || !agentIds.has(r.agentId)) ??
    null
  )
}

/** What sessionLabel reads: a session record, list item, live session or resume target, with what is known of its titles. */
export interface SessionNaming {
  id: string
  /** Hive's name for it. */
  name?: string | null
  /** The CLI's title (a /rename, else its own). */
  title?: string | null
  /** The CLI's /rename name; undefined when not known (then it doesn't override Hive's name). */
  customTitle?: string | null
  titleAtRename?: string | null
  /** When it started, for sessions with no name yet: the live session's start, else the record's creation. */
  startedAt?: string | null
  createdAt?: string | null
  usage?: { customTitle?: string | null; firstActivity?: string | null } | null
}

/** Hive's automatic name for a new session ("<project> · <agent> · <date>"), which counts as no name. */
export function isAutoSessionName(name: string | null | undefined, projectName: string): boolean {
  return !name || (name.startsWith(`${projectName} · `) && /\d{1,4}[/.-]\d{1,2}/.test(name))
}

/**
 * The name the session was given in the CLI (/rename) when it is newer than Hive's: Hive's name is automatic, or
 * the CLI's changed after the session was last renamed in Hive. Null when Hive's name stands. Hive passes its own
 * name to the CLI at launch (Claude Code's --name), so a CLI name that is Hive's, or automatic, is no rename.
 */
export function cliRename(s: SessionNaming, projectName: string): string | null {
  const custom = s.customTitle !== undefined ? s.customTitle : s.usage?.customTitle
  if (!custom || custom === s.name || isAutoSessionName(custom, projectName)) return null
  if (isAutoSessionName(s.name, projectName)) return custom
  return s.titleAtRename !== undefined && custom !== s.titleAtRename ? custom : null
}

/**
 * Whether one turn's output (thinking included) explains a compaction: at least 20K tokens, and at least half of the
 * jump from what the context showed before that turn (its input) to where it was compacted. The context gauge showed the
 * input, so without this the compaction looks early (#154).
 */
export function turnPushedCompaction(c: Pick<CompactionEvent, 'preTokens' | 'lastInputTokens' | 'lastOutputTokens'>): boolean {
  const out = c.lastOutputTokens ?? 0
  return out >= 20_000 && out * 2 >= c.preTokens - (c.lastInputTokens ?? c.preTokens)
}

/**
 * A session's display name. The latest rename wins: a name given in Hive, until the CLI's own name (/rename)
 * changes after it; then the CLI's. Without either, the CLI's title, else when the session started ("2026-10-04 14:05",
 * in the user's date and time format).
 */
export function sessionLabel(s: SessionNaming, projectName: string, tr?: Tr): string {
  const cli = cliRename(s, projectName)
  if (cli) return cli
  if (!isAutoSessionName(s.name, projectName)) return s.name!
  if (s.title && !isAutoSessionName(s.title, projectName)) return s.title
  const at = s.startedAt || s.createdAt || s.usage?.firstActivity
  if (at && formatDateTime(at)) return formatDateTime(at)
  if (tr) return tr(msg({ id: 'agents.session.unnamed', defaultMessage: 'Session {id}', description: 'A session with no name and no start time, named by the start of its id ({id}: "3f9a1c2b").' }), { id: s.id.slice(0, 8) })
  return `Session ${s.id.slice(0, 8)}` // i18n-ignore: English for main (the window passes tr)
}

/**
 * A worktree agent's work not yet merged, for its Merge… button and tab: `badge` is the number of commits
 * (• when there are only uncommitted files, null when there is nothing to merge) and `text` says it in words.
 */
export function unmergedWork(st: AgentBranchStatus | null | undefined, tr?: Tr): { badge: string | null; text: string } | null {
  if (!st) return null
  const into = st.into ?? st.base
  const parts: string[] = []
  if (tr) {
    if (st.ahead > 0) parts.push(tr(msg({ id: 'agents.merge.commits', defaultMessage: '{n, plural, one {# commit} other {# commits}} not merged into {into}', description: "A worktree agent's unmerged work: commits not yet merged into a branch ({into})." }), { n: st.ahead, into }))
    if (st.dirty > 0) parts.push(tr(msg({ id: 'agents.merge.uncommitted', defaultMessage: '{n, plural, one {# uncommitted file} other {# uncommitted files}}', description: "A worktree agent's unmerged work: files changed and not committed yet." }), { n: st.dirty }))
    if (!parts.length) return { badge: null, text: tr(msg({ id: 'agents.merge.nothing', defaultMessage: 'Nothing to merge into {into}', description: "A worktree agent's Merge button when it has no work to merge into a branch ({into})." }), { into }) }
  } else {
    if (st.ahead > 0) parts.push(`${st.ahead} commit${st.ahead === 1 ? '' : 's'} not merged into ${into}`) // i18n-ignore: English for main (the window passes tr)
    if (st.dirty > 0) parts.push(`${st.dirty} uncommitted file${st.dirty === 1 ? '' : 's'}`) // i18n-ignore: English for main (the window passes tr)
    if (!parts.length) return { badge: null, text: `Nothing to merge into ${into}` } // i18n-ignore: English for main (the window passes tr)
  }
  return { badge: st.ahead > 0 ? String(st.ahead) : '•', text: parts.join(' · ') }
}

/** Where Hive's releases (and its update feed) are published. */
export const RELEASES_URL = 'https://github.com/Suremise/combwork/releases'
/** The same repository, for the updater's feed (HI-2311): electron-builder.yml's publish block names it too (a test checks). */
export const RELEASES_REPO = { owner: 'Suremise', repo: 'combwork' } as const // i18n-ignore: a GitHub repository's owner and name

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

/** Command categories whose shortcuts a project can override. */
export const PROJECT_KEYBINDING_CATEGORIES = ['Project', 'Session'] // i18n-ignore: command category ids

/**
 * The shortcut a command uses: the project's override, else the user's, else the default. An override
 * of null (or empty) means "no shortcut".
 */
export function resolveKeybinding(id: string, fallback: string | undefined, global: KeybindingOverrides | undefined, project: KeybindingOverrides | undefined): string | undefined {
  if (project && id in project) return project[id] || undefined
  if (global && id in global) return global[id] || undefined
  return fallback
}

/** Keys Hive never lets a shortcut take: typing, clipboard and undo, and the terminal's own mode switch. */
export function keybindingProblem(key: string): string | null {
  const parts = key.split(' ')
  for (const p of parts) {
    const mods = p.split('+').slice(0, -1)
    const k = p.split('+').pop() ?? ''
    const fn = /^F\d{1,2}$/.test(k)
    if (!mods.length && !fn && k !== 'Escape') return trNow(msg({ id: 'agents.keys.singleKey', defaultMessage: 'Add Ctrl or Alt: a single key would stop you typing it.', description: 'Why a keyboard shortcut is refused (Settings → Keyboard shortcuts): one key alone. Ctrl and Alt are key names.' }))
    if (mods.length === 1 && mods[0] === 'Shift' && !fn) return trNow(msg({ id: 'agents.keys.shiftOnly', defaultMessage: 'Add Ctrl or Alt: Shift alone types a character.', description: 'Why a keyboard shortcut is refused: Shift with one key. Ctrl, Alt and Shift are key names.' }))
    if (mods.join('+') === 'Mod' && ['C', 'V', 'X', 'A', 'Z', 'Y'].includes(k)) return trNow(msg({ id: 'agents.keys.clipboard', defaultMessage: 'Ctrl+{key} is kept for copy, paste and undo.', description: 'Why a keyboard shortcut is refused: Ctrl with C, V, X, A, Z or Y ({key}). Ctrl is a key name.' }), { key: k })
    if (mods.join('+') === 'Shift' && k === 'Tab') return trNow(msg({ id: 'agents.keys.shiftTab', defaultMessage: "Shift+Tab switches modes inside the agents' terminals.", description: "Why a keyboard shortcut is refused: Shift+Tab, which the agents' CLIs use to switch permission modes. Key names." }))
    if (!mods.length && k === 'Escape') return trNow(msg({ id: 'agents.keys.escape', defaultMessage: 'Escape closes dialogs and interrupts the agent.', description: 'Why a keyboard shortcut is refused: Escape alone. Escape is a key name.' }))
  }
  return null
}
