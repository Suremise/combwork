import { randomBytes } from 'crypto'
import { carryLegacyAgentFields, legacyWorktree, type LegacyAgentFields, type NamedFolder, type StoredAgent } from '../shared/agentFolders'
import { basename, dirname, join, resolve, sep } from 'path'
import { mkdir, readdir, readFile, stat, writeFile } from 'original-fs/promises'
import { existsSync, statSync, watch, type FSWatcher as RootWatcher } from 'original-fs'
import { boardFile, boardWrite, closeBoard, inBoardWrite, untilBoardOpenable } from './boardStore'
import { closeJournal, untilJournalOpenable } from './journal'
import { AsyncLocalStorage } from 'async_hooks'
import type { BrowserWindow } from 'electron'
import chokidar, { type FSWatcher } from 'chokidar'
import { ASSISTANT_DIR, ASSISTANT_NAME, LEGACY_MODES_DIR, MODES_DIR, assistantProjectConfig } from '../shared/assistant'
import { DEFAULT_PROJECT_CONFIG, DEFAULT_WORKSPACE_CONFIG, CW_DIR, mergeDefaults, migrateProjectConfig, projectAgents, withLegacyProjectFields, withoutSkillSwitches } from '../shared/defaults'
import { migrateWorkspacePreferences } from '../shared/workflow/preferences'
import { settlePlacements } from '../shared/paneCells'
import { assistantMcpAdded, MCP_ADDED_MODEL, mcpAdded, mcpNames, migratedProjectMcp, migratedWorkspaceMcp } from '../shared/agentMcp'
import { ASSISTANT_OTHER_MCP, advancedDef, checkAdvanced, migrateAdvancedIds } from '../shared/advanced'
import { advanced } from './advanced'
import { fmt, msg, tr } from '../shared/i18n'
import { MIGRATED_CLOSE, migrateWorkspaceCommands } from '../shared/commands'
import { OpenGate } from './openGate'
import { HiveError, englishError, hiveError } from './hiveError'
import type { AgentDef, AgentInfo, HiddenProject, HiveEvent, KeptUsage, LiveSessionState, ProjectConfig, ProjectInfo, RemovedData, SessionRecord, WorkspaceConfig, WorkspaceInfo, WorkspaceMoved } from '../shared/types'
import { config } from './config'
import { changesConfig, viewOf, withoutView } from '../shared/projectView'
import { emit, emitTo, toast } from './events'
import { resolveOffer, resolveOffers } from './notify'
import { OUTCOME } from './outcomes'
import { KeptFileBusy, containsPlace, createKeptJson, insideReal, isDir, placeKey, readJson, readKeptJson, readKeptJsonByStat, removePath, retryWhileSaving, samePlace, withFileLock, writeKeptJson, type KeptReadOptions } from './fsutil'
import { admit, dismiss, setFenceReason } from './openingFence'
import { AfterOpen } from './openProgress'
import { whenAll } from '../shared/atMost'
import { createLogger, userText } from './logger'
import { changeSessionRecord, changeSessions, exportSessions, readAgentSessions, readCardSessions, readSession, readSessions, releaseSessions, type SessionsPlace } from './sessionStore'
import { allProviders } from './providers'
import { worktreesRoot } from './worktrees'
import { ensureHiveExcluded, gitDirOf, hiveVcs } from './hiveVcs'
import { detect, projectPlatform } from './platform/registry'
import type { ProjectPlatform } from '../shared/platform/descriptors'
import { gitProblem } from './gitTool'
import { duplicateAgentNames, suggestAgentName } from '../shared/agentNames'
import { NO_PROJECT_IDS, isProjectId, settleProjectIds, type ProjectIdEntry, type ProjectIdIndex } from '../shared/projectIds'
import { migrateProjectPreferences } from '../shared/workflow/preferences'
import { classify, finishMove, moveFolders, recordNewWorkspace, type MoveOptions, type MoveOutcome } from './combworkMove'
import { projectNamesDone } from './nameUpgrade'
import { NAMES_IGNORE } from './nameUpgradeFiles'
import { movedPathOf } from '../shared/hiveFolderMove'

const log = createLogger('workspace')

/** The workspace's dialect files (dialects, HI-2065), in .combwork: as dialects/store.ts's dialectsDir names it. */
const DIALECTS_DIR = 'dialects'

/**
 * workspace.json as read: Hive's defaults under it, and its older forms brought up to date (HI-1954: HI-1368's close
 * command adopted into its commands, the old field dropped; written with its next save, and the same again until then).
 */
function loadedConfig(raw: unknown): WorkspaceConfig {
  const c = mergeDefaults(structuredClone(DEFAULT_WORKSPACE_CONFIG), migrateWorkspacePreferences(withoutSkillSwitches(raw as Record<string, unknown>)))
  c.commands = migrateWorkspaceCommands(c, tr(MIGRATED_CLOSE))
  delete c.onClose
  // The workspace's own advanced values under their cw.* ids (HI-2518), one way: the file changes when it is next saved.
  if (c.advanced && typeof c.advanced === 'object' && !Array.isArray(c.advanced)) c.advanced = migrateAdvancedIds(c.advanced).record
  return c
}

/** Where this user's view of a project is kept (AppConfig.ui.projectViews, HI-1749): by its id, which a rename or a move keeps, else by its folder. */
export const projectViewKey = (cfg: Pick<ProjectConfig, 'id'>, projectPath: string): string => (cfg.id ? `id:${cfg.id}` : `path:${resolve(projectPath).toLowerCase()}`)
/** A project's read for the window this slow is logged with its parts' times (HI-1694). */
const SLOW_PROJECT_READ_MS = 1000
/** What the board keeps in .combwork (#1017): its database and the files beside it, the cards' old folders, backups and the deleted cards' staging. */
const BOARD_FILES = /^(hive\.db(-wal|-shm|-journal)?|tasks|tasks\..+|backups|deleted-cards)$/
/** How often a workspace root whose folder went is tried again (#964). */
const ROOT_WATCH_RETRY_MS = 3000
/** The workspace's refusals and its notice, in the window's language (#850); agents (the Agent API) read their English. */
const M = {
  noWorkspace: msg({ id: 'service.workspace.none', defaultMessage: 'No workspace is open', description: 'An error: the action needs a workspace, and none is open in this window.' }),
  closed: msg({ id: 'service.workspace.closed', defaultMessage: 'The workspace was closed', description: 'An error: the workspace was closed (or the window opened another) while the action was under way.' }),
  platformTitle: msg({ id: 'service.workspace.platformTitle', defaultMessage: 'Version control changed in {project}', description: "A notice's title: the version control found in the project {project}'s folder is no longer the one Combwork recorded for it." }),
  gitFound: msg({ id: 'service.workspace.platformGitFound', defaultMessage: '{project} is a Git repository now. Combwork goes on treating it as a project without version control until you switch it in its Version Control tab.', description: 'A notice: someone ran git init in a project Combwork treats as having no version control. Combwork does not switch it by itself: the Version Control tab offers the switch (glossary 2.1: Version Control).' }),
  repositoryGone: msg({ id: 'service.workspace.platformRepositoryGone', defaultMessage: "{project}'s Git repository is gone. Git's rules hold, so its cards can't move on until the repository is back or you switch the project to None in its Version Control tab.", description: "A notice: the .git folder of a project Combwork treats as a Git project was removed or moved. Combwork doesn't switch it by itself: the Version Control tab offers the switch to None (glossary 2.1)." }),
  platformInvalidTitle: msg({ id: 'service.workspace.platformInvalidTitle', defaultMessage: 'Unknown version control setting in {project}', description: "A notice's title: the project {project}'s settings file names a version control Combwork doesn't have." }),
  platformInvalid: msg({ id: 'service.workspace.platformInvalid', defaultMessage: "{project}'s project.json names a version control Combwork doesn't know (platform: {value}). Until it says \"git\" or \"none\", Combwork uses what it finds in the folder.", description: 'A notice: the platform setting in the project {project}\'s .combwork/project.json is {value}, which is not one Combwork has (only "git" and "none" are: keep them as they are, they are setting values).' }),
  otherFound: msg({ id: 'service.workspace.platformOtherFound', defaultMessage: "{vcs} was found in {project}. Combwork doesn't support it yet, and goes on treating the project as a Git project until you switch it to None in its Version Control tab.", description: 'A notice: another version control system ({vcs}: Mercurial, Jujutsu…) was found in a project Combwork treats as a Git project. Combwork does not switch it by itself: the Version Control tab offers the switch to None (glossary 2.1).' }),
  platformSettled: msg({ id: 'service.workspace.platformSettled', defaultMessage: 'Settled: nothing to change now', description: "What the notice that a project's version control changed says once it no longer applies (HI-2320): the project was switched, or its folder is back as it was. Shown in place of its button." }),
  openVc: msg({ id: 'service.workspace.platformOpen', defaultMessage: 'Open Version Control', description: "A button on the notice that a project's version control changed: shows the project's Version Control tab, where Combwork offers the switch (glossary 2.1)." })
}
// What a closed workspace's refused open throws (#1381: made when refused, not kept per workspace).
setFenceReason(() => hiveError(M.closed, undefined, { kind: 'conflict' }))

/** The notice that a project's folder no longer has the version control Hive recorded for it (SPEC §16.3.5). */
function platformNotice(project: string, p: ProjectPlatform): { title: string; message: string } {
  if (p.invalid !== undefined) return { title: tr(M.platformInvalidTitle, { project }), message: tr(M.platformInvalid, { project, value: p.invalid }) }
  const why = p.offer?.why
  const message = why === 'gitFound' ? tr(M.gitFound, { project }) : why === 'otherFound' ? tr(M.otherFound, { project, vcs: p.detected.other ?? '' }) : tr(M.repositoryGone, { project })
  return { title: tr(M.platformTitle, { project }), message }
}

// i18n-ignore: the .combwork folder's README, a file committed with the workspace
export const WORKSPACE_README = `# .combwork

This folder is managed by [Combwork](https://github.com/Suremise/combwork) and is meant to be committed.

- \`shared/\` — notes, instructions and handovers shared across AI sessions and projects.
- \`skills/\` — Combwork skills (one folder per skill, each with a \`SKILL.md\`). Every agent in every project gets them.
- \`mcp/\` — MCP server definitions (one \`<name>.json\` per server). Add them to projects in Combwork.
- \`workspace.json\` — the workspace's settings, among them the MCP servers added for the Combwork Assistant (a project's are in its \`.combwork/project.json\`).
- \`combwork.db\` — the task board (Combwork's database). It is this machine's, like the Assistant's sessions: \`.gitignore\` keeps it out of git.
- \`usage.db\` — what each session used (the usage history the Overviews read). It is this machine's too, kept out of git.

MCP definitions must not contain secrets. Reference environment variables instead, e.g. \`"\${GITHUB_TOKEN}"\`.
`

/** The usage history's lines of BOARD_GITIGNORE (#1106), added to the .gitignore Hive wrote before them. */
const USAGE_IGNORE = '# What each session used: the usage history (#1106)\nusage.db\nusage.db-*\n' // i18n-ignore: the .combwork folder's .gitignore, a file committed with the workspace

/**
 * A .combwork/.gitignore's text with the usage history's lines added, or null to leave it as it is: one Combwork didn't
 * write is the user's, and one that has them already needs nothing. Hive's, from before 1.1, has Combwork's head by then
 * (the names upgrade at the open, HI-2587: nameUpgradeFiles.ts).
 */
export function withUsageIgnore(text: string): string | null {
  const ours = text.startsWith(BOARD_GITIGNORE.split('\n')[0])
  if (!ours || /^usage\.db\r?$/m.test(text)) return null
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  return `${text}${text.endsWith('\n') ? '' : nl}${USAGE_IGNORE.replace(/\n/g, nl)}`
}

/** Adds the usage history's lines to the .gitignore Combwork wrote (only its own: one the user wrote is theirs). */
async function addUsageIgnore(file: string): Promise<void> {
  const text = await readFile(file, 'utf8').catch(() => null)
  const next = text === null ? null : withUsageIgnore(text)
  if (next !== null) await writeFile(file, next).catch(() => undefined)
}

// i18n-ignore: the .combwork folder's .gitignore, a file committed with the workspace
export const BOARD_GITIGNORE = `# The task board's database and what moving it from files left (added by Combwork, #1017)
combwork.db
combwork.db-*
backups/
tasks.imported-*/
tasks.set-aside/
deleted-cards/
# What each session used: the usage history (#1106)
usage.db
usage.db-*
${NAMES_IGNORE}`

/** The Assistant's home's .gitignore (HI-2580: before 1.1 it said Hive; nothing reads it back). */
// agent-protocol: a .gitignore's fixed text for git and whoever opens the file, not words said to an agent
export const ASSISTANT_GITIGNORE = "# Combwork Assistant: this machine's sessions (added by Combwork)\n*\n" // i18n-ignore: the Assistant's .gitignore, a file in the workspace

// i18n-ignore: the handovers folder's README, a file committed with the workspace
export const HANDOVER_README = `# Handovers

Notes written at the end of a session so the next session (or another project) can pick up where it left off.
Agents can create these with the Combwork MCP tool \`cw_create_handover\`.
`

export interface SessionsFile {
  version: 1
  sessions: SessionRecord[]
  /** Sessions deleted in Hive: their CLI transcripts are left alone, so Hive hides them from its lists. */
  deleted?: string[]
  /** What the deleted sessions used (by day too), which the project's totals still count. */
  deletedUsage?: KeptUsage[]
}

/** `scope`: the refresh the project is read for (#1002), whose projects' running agents share one read of the workspace's skills and servers. */
type LiveProvider = (projectPath: string, cfg: ProjectConfig, scope?: object) => Promise<{ live: LiveSessionState | null; restartNeeded: boolean; agents: AgentInfo[]; folders?: NamedFolder[] }>

/**
 * What a read of the projects' ids saw of each one (#514): its folder, its id, where it was last opened (project.json's
 * lastPath, #146) and whether it is a copy just given an id of its own. projectNames.ts keeps the workspace's record of
 * their names by id from it.
 */
export interface ProjectSeen {
  path: string
  id: string
  lastPath?: string
  copy: boolean
}

/** For unit tests (#1382): an agent leaving the project, its change about to wait for the board's lock. */
export const configTestHooks: { beforeBoardRetry?: (projectPath: string) => void; beforeConfigWrite?: (projectPath: string) => Promise<void>; beforeDefaultConfig?: (projectPath: string) => Promise<void>; afterConfigSeen?: (projectPath: string) => Promise<void> } = {}

/** A file's version as its stat says (HI-2563): its inode, size and time changed; '' when it isn't there or can't be read. */
async function keptStamp(path: string): Promise<string> {
  const st = await stat(path, { bigint: true }).catch(() => null)
  return st ? `${st.ino}:${st.size}:${st.mtimeNs}` : ''
}

/**
 * Whether an agent may be given a connection now (HI-2107; accounts.ts sets it): it exists and isn't being removed. Asked
 * in mutateProjectConfig's lock for each agent whose connection a write changes, so a removal, which reads every
 * project's agents under the same lock, never misses a connection given while it ran.
 */
let connectionAssignable: (id: string) => boolean = () => true
export function setConnectionGuard(fn: (id: string) => boolean): void {
  connectionAssignable = fn
}

const CONNECTION_GONE = msg({ id: 'service.workspace.connectionGone', defaultMessage: "The connection chosen for {agent} was removed, or is being removed. Choose another.", description: "An error saving an agent (HI-2107): the connection chosen for it ({agent}, the agent's name) was removed from Settings → Accounts & Connections meanwhile." })

/** Refuses a write giving an agent a connection that is gone or being removed (an agent keeping its own is never refused). */
function assertConnectionsAssignable(before: readonly AgentDef[], after: readonly AgentDef[]): void {
  const was = new Map(before.map((a) => [a.id, a.connection]))
  for (const a of after) if (a.connection && a.connection !== was.get(a.id) && !connectionAssignable(a.connection)) throw hiveError(CONNECTION_GONE, { agent: a.name ?? a.id }, { kind: 'conflict' })
}

/** What a project.json gives (kept by its stat, HI-1814): its config over the defaults, and the view fields it still has. */
const projectFileConfig = (raw: Record<string, unknown>): { cfg: ProjectConfig; viewKeys: string[] } => ({
  cfg: mergeDefaults(structuredClone(DEFAULT_PROJECT_CONFIG), migrateProjectConfig(raw)),
  viewKeys: Object.keys(viewOf(raw as Partial<ProjectConfig>))
})

export class WorkspaceService {
  path: string | null = null
  /**
   * Its folder's real location as the window opened it (`placeKey`): what the close fences and lets go (#1402), so a
   * junction or short name it was opened by, removed or pointed elsewhere since, can't send the close to another folder.
   */
  private place: string | null = null
  private wsConfig: WorkspaceConfig = structuredClone(DEFAULT_WORKSPACE_CONFIG)
  private watcher: FSWatcher | null = null
  /** .combwork's own top, watched natively (watchHive). */
  private hiveTop: RootWatcher | null = null
  private rootWatcher: RootWatcher | null = null
  private refreshTimer: NodeJS.Timeout | null = null
  /** The refresh scheduleRefresh has waiting, told once it has run (or was dropped): refreshesSettled waits for it. */
  private scheduled: { done: Promise<void>; tell: () => void } | null = null
  /** Scheduled refreshes running now, until each has finished (refreshesSettled waits for them too, #1143 round 2). */
  private scheduledRuns = new Set<Promise<void>>()
  private static liveProvider: LiveProvider = async (p, cfg) => ({ live: null, restartNeeded: false, agents: projectAgents(cfg).map((a) => ({ ...a, live: null, restartNeeded: false, resume: null, place: { folder: p, is: 'project' as const, name: null, branch: null } })) })
  /** Called each time a workspace opens, in its context; `fresh` when Hive set the folder up just now (it had no .combwork). */
  static onOpened: ((fresh: boolean, after: AfterOpen) => Promise<unknown>) | null = null
  /** Brings an opening workspace's bundled skills and modes up to date, in its context, after the open (HI-1705: bundled.ts). */
  static bringItemsUpToDate: ((fresh: boolean) => Promise<void>) | null = null
  /** Its skills and modes being brought up to date as it opened, until they are (it never fails). */
  private itemsSynced: Promise<void> = Promise.resolve()
  /** Whether itemsSynced hasn't ended yet: a close waits only then (HI-1747). */
  private itemsSyncing = false

  /** Once the open has brought its bundled skills and modes up to date: what a launch reads of them waits for it. */
  itemsUpToDate(): Promise<void> {
    return this.itemsSynced
  }
  /** Each read of the projects' ids (#514): the workspace's record of their names follows it (projectNames.ts). Never awaited. */
  static onIdsRead: ((ws: WorkspaceService, seen: ProjectSeen[]) => void) | null = null
  /**
   * Told when a workspace starts closing (its path still set), so services drop what they keep for it: `place` is the
   * place its window recorded as it opened (#1395: what they kept under any spelling of it, matched by what they recorded).
   */
  static readonly closingListeners = new Set<(path: string, place: string) => void>()
  /** Told each time a workspace has opened (after onOpened), so services repair what a close left (#1392). Never awaited. */
  static readonly openedListeners = new Set<(ws: WorkspaceService) => void>()
  /** Told when a file in a workspace's dialects folder changes (HI-2443): the API chain is loaded again. */
  static readonly dialectsListeners = new Set<(ws: WorkspaceService) => void>()
  /**
   * Awaited as a workspace starts closing, its board still open: what must end and be written down first (the merge
   * queue's runners give up their leases, #1360). A failure is logged and the close goes on.
   */
  static readonly closingTasks = new Set<(path: string) => Promise<void>>()
  /** The window showing this workspace: its events go there. */
  window: BrowserWindow | null = null
  /** Agents' worktree folders (lower-cased) and the project each belongs to. */
  private roots = new Map<string, string>()
  /**
   * Which config read or write each project's `roots` are from (#784: lower-cased project → its ticket). Tickets go up
   * in the order reads begin and writes end, so a read that began before another, or before a write, and ends after it
   * found older worktrees and changes nothing: it put back a removed agent's worktree and dropped a current one.
   */
  private rootsAt = new Map<string, number>()
  private rootTickets = 0
  /** Each project's slots and retired homes as its last read found them (#1442: lower-cased project → folders): roots too. */
  private folderRoots = new Map<string, string[]>()
  /**
   * Each project's latest project.json write (lower-cased project → its ticket), and the ticket each ProjectInfo was read
   * at (#999): a refresh that read a project before a later write found the config from before, e.g. an agent order two
   * moves back.
   */
  private savedAt = new Map<string, number>()
  /**
   * Each project's project.json writes by Hive (#1432), as the stamp of its last write and the root ticket it was written
   * at: a reader compares the stamp it read before with now's, and can tell it changed. Bounded (#1498): forgotten when the
   * workspace closes, or a refresh finds the project gone; a project with none reads `configFloor`, the newest stamp ever
   * forgotten, and stamps only grow (`configStamp`, never reset), so a forgotten write still reads as a change, never as
   * none (an old snapshot may read changed when it isn't: it looks again).
   */
  private configWrites = new Map<string, { stamp: number; ticket: number }>()
  private configStamp = 0
  private configFloor = 0
  private readAt = new WeakMap<ProjectInfo, number>()
  /** The projects the last refresh reported (lower-cased) and its listing's ticket: one missing was gone by then (#784). */
  private listedAt: { ticket: number; known: Set<string> } | null = null
  /**
   * The projects seen set up in this lifetime (HI-2564): lower-cased path → the ticket of the observation (markSetUp). A
   * refresh never sets one up again whose project.json has gone (a folder half deleted, a reset): only an open or a change
   * to it does. Not the id index, which drops a path as soon as its config is missing.
   */
  private setUpAt = new Map<string, number>()
  /** Those a refresh found without their project.json, said once in the log. */
  private goneSaid = new Set<string>()
  /**
   * Each project's unused worktrees as last listed (#400: lower-cased folder → project): the Changes tab may read their
   * git status and diffs (`assertChangesRoot`), nothing else. Replaced on each listing, so one removed since drops out.
   */
  private unusedRoots = new Map<string, string>()
  private cached: WorkspaceInfo | null = null
  /** Goes up each time a workspace opens or closes, so work started for an earlier one doesn't touch this one. */
  private generation = 0
  private life = new AbortController()
  /** Its agents are being stopped to close or switch it (or close its window): no new agent starts meanwhile. */
  closing = false
  /** Repair… of a move is running (#146): no agent starts meanwhile, as it would find paths half repaired. */
  repairingMove = false
  /** Its open point's commands running as it opened (HI-1954): while held, no agent of it starts. */
  openGate: OpenGate | null = null
  /** Whether this Hive runs the user's commands (never a test copy, but for the suites' seam): set by ipc.ts. */
  static runsCommands: () => boolean = () => false
  /** Moved since last opened, with something to repair (#146, workspaceMove.ts); the window's banner offers Repair…. */
  private moved: WorkspaceMoved | null = null
  /** The projects' ids (#508) as last read, for the folder list they were read for (`key`), and a read under way. */
  /**
   * Where the workspace was before it moved here (#146: workspace.json's lastPath as it opened), or null: records saved
   * there by path (card watches, merge holds, #508) come to their folders here by it. Repair updating lastPath meanwhile
   * doesn't change it.
   */
  movedFrom: string | null = null
  /** The open under way in this window, its folder and its run (HI-2141), or null. */
  private opening: { path: string; run: Promise<WorkspaceInfo> } | null = null
  private ids: (ProjectIdIndex & { key: string; at: number }) | null = null
  /**
   * Where each project id was last seen while this workspace is open, kept when a read misses it: a read part way through
   * a rename (the folder listed, gone when its project.json is read), or a folder out of the workspace for a while, would
   * otherwise make its next folder look like a new project, and the board would never hear it was renamed (#555). Every
   * project read now is kept, and of those a read missed only the `absentIdsKept` missed most recently; all go on close.
   */
  private lastAt = new Map<string, string>()
  /** How many ids a read missed `lastAt` keeps (tests make it small). */
  static absentIdsKept = 64
  /** How many ids `lastAt` holds now (for tests). */
  lastSeenCount(): number {
    return this.lastAt.size
  }
  private idsRead: { key: string; run: Promise<ProjectIdIndex>; ticket: { listing: number } } | null = null
  /**
   * The folders' listings in the order they were made, and the latest whose read has settled (HI-1668): a read that
   * listed them before another settles after it (the root watcher's, 250 ms after a change, beside a caller's) leaves
   * the later listing standing, never its own older one. A listing that finds what is read already (the standing ids'
   * key) settles at once; one that finds a read under way of the same folders makes that read its own (its ticket).
   */
  private idsListed = 0
  private idsSettled = 0

  setLiveProvider(p: LiveProvider): void {
    WorkspaceService.liveProvider = p
  }

  /** Aborted when this workspace closes (or the window opens another): work for it stops, and what it kept goes. */
  get lifetime(): AbortSignal {
    return this.life.signal
  }

  get hiveDir(): string {
    if (!this.path) throw hiveError(M.noWorkspace, undefined, { kind: 'conflict' })
    return join(this.path, CW_DIR)
  }

  get skillsDir(): string {
    return join(this.hiveDir, 'skills')
  }

  get mcpDir(): string {
    return join(this.hiveDir, 'mcp')
  }

  get sharedDir(): string {
    return join(this.hiveDir, 'shared')
  }

  /** The Hive Assistant's modes: their folder from before 0.9.3 while the workspace has only that one (LEGACY_MODES_DIR). */
  get modesDir(): string {
    const dir = join(this.hiveDir, MODES_DIR)
    if (existsSync(dir)) return dir
    const legacy = join(this.hiveDir, LEGACY_MODES_DIR)
    return existsSync(legacy) ? legacy : dir
  }

  /** The Hive Assistant's home: its one-agent config, sessions and backups (its agent works in the workspace folder). */
  get assistantHome(): string {
    return join(this.hiveDir, ASSISTANT_DIR)
  }

  /** Whether a path is this workspace's Assistant home. */
  isAssistantHome(p: string): boolean {
    return !!this.path && resolve(p).toLowerCase() === this.assistantHome.toLowerCase()
  }

  /** A folder sessions can run for: a project of the open workspace, or its Assistant's home. */
  assertSessionHost(p: string): string {
    if (this.isAssistantHome(p)) return this.assistantHome
    return this.assertProject(p)
  }

  /** Where new worktrees are created, next to the workspace folder. */
  get worktreesRoot(): string {
    if (!this.path) throw hiveError(M.noWorkspace, undefined, { kind: 'conflict' })
    return worktreesRoot(this.path)
  }

  get config(): WorkspaceConfig {
    return this.wsConfig
  }

  /** The place its window recorded as it opened (#1395): its real location, lower-cased; null while none is open. */
  get openPlace(): string | null {
    return this.place
  }

  async open(path: string): Promise<WorkspaceInfo> {
    const run = this.openNow(path)
    const o = { path: resolve(path), run }
    this.opening = o
    try {
      return await run
    } finally {
      if (this.opening === o) this.opening = null
    }
  }

  /**
   * This window's workspace when `path` is it (by real path, #455), once an open of it under way here has ended (the
   * restore at start, HI-2141): its info, so the window's own open of it neither closes it nor opens it again, which
   * ended what its passes were writing. Null when the window has or is opening another, has none, or that open failed.
   */
  async alreadyHere(path: string): Promise<WorkspaceInfo | null> {
    const o = this.opening
    if (o && samePlace(path, o.path)) await o.run.catch(() => undefined)
    if (this.opening && !samePlace(path, this.opening.path)) return null
    return this.path && samePlace(path, this.path) ? this.info() : null
  }

  private async openNow(path: string): Promise<WorkspaceInfo> {
    const abs = resolve(path)
    if (!(await isDir(abs))) throw hiveError(msg({ id: 'service.workspace.notFound', defaultMessage: 'Folder not found: {folder}', description: 'An error opening a workspace: the folder {folder} is not there.' }), { folder: abs })
    // The skills and modes of the workspace this window had, still being brought up to date (HI-1705), first: its close
    // waits for them, and no other window's open should wait behind that in the admission.
    await this.itemsSynced
    // One workspace inside another would make its projects belong to both. Windows claim their folders one
    // at a time, so two opening at once can't both pass the check before either has claimed its own.
    let folderMove: MoveOutcome = { late: false, moved: 0 }
    const claim = admission.then(async () => {
      // By real paths: the same folder by another name (an 8.3 short name, a junction) is the same workspace (#455).
      for (const w of services) {
        if (w === this || !w.path) continue
        if (samePlace(abs, w.path)) throw hiveError(msg({ id: 'service.workspace.openElsewhere', defaultMessage: '{folder} is already open in another window.', description: 'An error opening a workspace: the folder {folder} is the workspace of another Combwork window.' }), { folder: abs }, { kind: 'conflict' })
        if (containsPlace(w.path, abs)) throw hiveError(msg({ id: 'service.workspace.insideOpen', defaultMessage: "{folder} is inside the workspace {workspace}, which is open in another window. Close that workspace first, or open this folder's projects from there.", description: 'An error opening a workspace: the folder {folder} is inside {workspace}, the workspace of another Combwork window (a workspace inside another would share its projects).' }), { folder: abs, workspace: w.path }, { kind: 'conflict' })
        if (containsPlace(abs, w.path)) throw hiveError(msg({ id: 'service.workspace.holdsOpen', defaultMessage: 'The workspace {workspace}, open in another window, is inside {folder}. Close it first to open {name} as a workspace.', description: "An error opening a workspace: another Combwork window's workspace {workspace} is inside the folder {folder} (its name: {name})." }), { folder: abs, workspace: w.path, name: basename(abs) }, { kind: 'conflict' })
      }
      await this.close()
      this.generation++
      // Its `.hive` folders, and its projects', move to `.combwork` (HI-2462, combworkMove.ts) before the window holds the
      // folder: nothing of it is admitted, read or written until they have (a settings change at start looks at every
      // open workspace). A move that can't be done refuses the open, the folder not this window's.
      const openGen = this.generation
      folderMove = await moveFolders(abs, { stillOurs: () => this.generation === openGen })
      // Launches wait until this open has moved its MCP settings (HI-1472): the path is the workspace's from now on.
      this.mcpMoving = gate()
      this.path = abs
      this.place = placeKey(abs)
      // Its databases are kept open from now on, by this place (#1395); a save's lease doesn't close the database now it
      // is this window's, opened before or after (#1383).
      admit(this.place)
    })
    admission = claim.catch(() => undefined)
    await claim
    // An open that fails from here gives back what it took (its admission, what it opened), unless another open or a
    // close of this window has taken over meanwhile.
    const gen = this.generation
    const moving = this.mcpMoving
    try {
      return await this.opened(abs, folderMove)
    } catch (e) {
      moving.done()
      if (this.generation === gen && this.path === abs) await this.close().catch((c) => log.warn('closing a workspace whose open failed', c))
      throw e
    }
  }

  /** The rest of open, once the window holds the folder. */
  private async opened(abs: string, folderMove: MoveOutcome): Promise<WorkspaceInfo> {
    // Each part's time, in the line saying it opened (HI-1694: an ordinary open of a workspace took 4–11 s, the log silent
    // between the board's open and "Opened workspace").
    const parts: string[] = []
    let mark = performance.now()
    const started = mark
    const done = (what: string): void => {
      const now = performance.now()
      parts.push(`${what} ${Math.round(now - mark)} ms`)
      mark = now
    }
    // The folder move's late phases (below) stop with this open.
    const openGen = this.generation
    const moveOpts = { signal: this.life.signal, stillOurs: () => this.generation === openGen && this.path === abs }
    const fresh = !existsSync(join(abs, CW_DIR))
    await this.ensureWorkspaceStructure()
    this.wsConfig = loadedConfig(await readKeptJson(join(this.hiveDir, 'workspace.json'), {}, { holder: this }))
    // Its open point's commands hold its agents back until they are done (HI-1954): reserved here, before anything hears
    // of the open (the recent list, workspace-changed, onOpened), so no start slips in ahead of them.
    this.openGate = this.wsConfig.commands?.onOpen.run.length && WorkspaceService.runsCommands() ? new OpenGate(this.generation, this.life.signal) : null
    const last = this.wsConfig.lastPath
    this.movedFrom = last && resolve(last).toLowerCase() !== abs.toLowerCase() ? resolve(last) : null
    config.update((c) => {
      c.lastWorkspace = abs
      c.recentWorkspaces = [abs, ...c.recentWorkspaces.filter((p) => p.toLowerCase() !== abs.toLowerCase())].slice(0, 12)
      c.activeProjects[abs] ??= []
    })
    // Every window's recent list: this one first, and open here (#144).
    emit({ type: 'recent-changed' })
    done('its .combwork folder and settings') // i18n-ignore: a part of a log line's timing
    // The Assistant's home set up meanwhile (HI-1705): it needs nothing of the projects'.
    const assistant = (async () => {
      try {
        await this.ensureProject(this.assistantHome)
        // The Assistant's conversations and backups are this machine's: kept out of git if the workspace is a repository.
        const ignore = join(this.assistantHome, '.gitignore')
        if (!existsSync(ignore)) await writeFile(ignore, ASSISTANT_GITIGNORE)
      } catch (e) {
        log.warn('setting up the Assistant', e)
      }
    })()
    try {
      // Each project's own folders, all at once (HI-1705).
      await whenAll((await this.listProjectPaths()).map((p) => this.ensureProject(p).catch((e) => log.warn(`ensureProject ${userText(p)}`, e))))
      done('its projects') // i18n-ignore: a part of a log line's timing
      // Its board and its Assistant's journal openable first (HI-2199, HI-2200: just after a Hive ended without quitting,
      // they may not be for some seconds). A close or another open meanwhile ends the wait, and this open goes no
      // further: the service is the successor's.
      const gen = this.generation
      const life = this.life.signal
      await Promise.all([untilBoardOpenable(abs, life), untilJournalOpenable(this.assistantHome, life)])
      if (life.aborted || this.generation !== gen || this.path !== abs) throw hiveError(M.closed, undefined, { kind: 'conflict' })
      done('its board and journal openable') // i18n-ignore: a part of a log line's timing
      // Every project has its id (#508) before the board, lanes and watches are read by it.
      await this.projectIds().catch((e) => log.warn('reading the project ids', e))
      done('their ids') // i18n-ignore: a part of a log line's timing
      // The folder move's phases that need the board and the projects (HI-2462), before any session starts: one that
      // fails refuses the open, and the next open finishes it.
      if (folderMove.late) {
        await this.finishFolderMove(moveOpts)
        done("the folder move's cards and folders") // i18n-ignore: a part of a log line's timing
      }
      // Before any session starts with them: MCP settings from before #1093 move to its model.
      await this.migrateMcpModel().catch((e) => log.warn('moving the MCP settings to the workspace and project switches', e))
      // Before the Assistant can start (HI-1472): its own MCP choices, from the old Advanced switch or none.
      await this.migrateAssistantMcp(fresh).catch((e) => log.warn("moving the Assistant's MCP servers to its own choices", e))
      // Then (HI-2059) each project's and the Assistant's lists to mean added, each file on its own: one not converted
      // keeps its old meaning until a later open converts it.
      await this.convertMcpAdded().catch((e) => log.warn('converting the MCP servers to added servers', e))
      this.mcpMoving.done()
      done('MCP settings') // i18n-ignore: a part of a log line's timing
    } finally {
      // Ended either way: an open that fails here leaves none of it going (its close follows).
      await assistant
    }
    done('the Assistant') // i18n-ignore: a part of a log line's timing
    // Its bundled skills and modes brought up to date once the window has the workspace, not before (HI-1705: hashing each
    // one's copies on every open was most of an ordinary open's file reads, queued behind other windows' work); none if
    // the open fails. A launch waits for it (itemsUpToDate), and .combwork is watched only once it is done: a watched folder
    // can't be swapped on Windows.
    const gen = this.generation
    // What the open starts in the background, each timed, in a line of its own once all have ended (HI-1705).
    const after = new AfterOpen(basename(abs))
    let shown!: (ok: boolean) => void
    let began = 0
    const items = new Promise<boolean>((r) => (shown = r))
      .then(async (ok) => {
        if (!ok || this.generation !== gen || this.path !== abs) return
        began = performance.now()
        await inWorkspace(this, async () => WorkspaceService.bringItemsUpToDate?.(fresh)).catch((e) => log.warn("updating the workspace's bundled skills and modes", e))
        if (this.generation !== gen || this.path !== abs) return
        this.watchHive()
        // What the window read of them meanwhile may be older.
        this.emit({ type: 'skills-changed' })
        this.emit({ type: 'modes-changed' })
      })
      .catch((e) => log.warn("updating the workspace's bundled skills and modes", e))
    const synced = after.track('its bundled skills and modes', items, () => began) // i18n-ignore: a part of a log line's timing
    this.itemsSynced = synced
    this.itemsSyncing = true
    const ended = (): void => {
      if (this.itemsSynced === synced) this.itemsSyncing = false
    }
    void synced.then(ended, ended)
    let ok = false
    try {
      await inWorkspace(this, async () => WorkspaceService.onOpened?.(fresh, after)).catch((e) => log.warn('opening the workspace', e))
      after.seal()
      done('what opening starts') // i18n-ignore: a part of a log line's timing
      for (const l of WorkspaceService.openedListeners) {
        try {
          l(this)
        } catch (e) {
          log.warn('opening the workspace', e)
        }
      }
      this.watchRoot()
      done('its watchers') // i18n-ignore: a part of a log line's timing
      log.info(`Opened workspace ${userText(abs)} in ${Math.round(performance.now() - started)} ms: ${parts.join(', ')}`)
      const read = performance.now()
      const info = await this.refresh()
      log.info(`read ${userText(basename(abs))}'s projects for the window in ${Math.round(performance.now() - read)} ms`)
      ok = true
      return info
    } finally {
      shown(ok)
    }
  }

  /**
   * This open's MCP settings moved to their current model (#1093, HI-1472's Assistant choices): a launch's settings are
   * worked out only after it, so one started while the workspace is opening never misses what the move gives it.
   */
  mcpSettled(): Promise<void> {
    return this.mcpMoving.promise
  }
  private mcpMoving = gate(true)

  async close(): Promise<void> {
    this.mcpMoving.done()
    // Its skills and modes still being brought up to date (HI-1705) finish first: they are written into this workspace's
    // .combwork, by the path this service has until it closes. Only while they are going (HI-1747): an await of nothing would
    // let in what starts before the abort below, which a close with no closing tasks has always refused at once.
    if (this.itemsSyncing) await this.itemsSynced
    if (this.path) {
      const was = this.path
      for (const t of WorkspaceService.closingTasks) await t(was).catch((e) => log.warn('closing the workspace', e))
    }
    this.generation++
    // What was said of the projects' platforms is this workspace's.
    this.platformOffers.clear()
    const reason = hiveError(M.closed, undefined, { kind: 'conflict' })
    this.life.abort(reason)
    const closing = this.path
    const place = this.place ?? undefined
    // First: from here, nothing keeps its databases open until a window opens it again (#1395), whoever asks.
    if (place) dismiss(place)
    if (closing) {
      for (const l of WorkspaceService.closingListeners) {
        try {
          l(closing, place ?? placeKey(closing))
        } catch (e) {
          log.warn('closing the workspace', e)
        }
      }
    }
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = null
    this.scheduled?.tell()
    this.scheduled = null
    if (this.idsTimer) clearTimeout(this.idsTimer)
    this.idsTimer = null
    if (this.rootRetry) clearTimeout(this.rootRetry)
    this.rootRetry = null
    this.rootWatcher?.close()
    this.rootWatcher = null
    // A scheduled refresh already running reads the projects' files until its reads end (all at once, HI-1705): closed
    // only once it has, so a project's folder can be moved as soon as its window lets it go (#1341: EPERM renaming it). No
    // new one is scheduled from the abort on (scheduleRefresh).
    while (this.scheduledRuns.size) await Promise.allSettled([...this.scheduledRuns])
    if (closing) closeBoard(closing, place)
    if (closing) closeJournal(join(closing, CW_DIR, ASSISTANT_DIR), place)
    this.hiveTop?.close()
    this.hiveTop = null
    await this.watcher?.close()
    this.watcher = null
    this.path = null
    this.place = null
    this.cached = null
    this.moved = null
    this.movedFrom = null
    this.ids = null
    this.idsRead = null
    this.lastAt.clear()
    // The closed workspace's agent worktrees and settings must not route to (or be allowed by) the next one.
    this.roots.clear()
    this.rootsAt.clear()
    this.folderRoots.clear()
    this.savedAt.clear()
    // Every write stamp forgotten at once: the floor is the newest stamp, so each old snapshot still reads a change.
    this.configWrites.clear()
    this.configFloor = this.configStamp
    this.listedAt = null
    this.setUpAt.clear()
    this.goneSaid.clear()
    this.unusedRoots.clear()
    this.wsConfig = structuredClone(DEFAULT_WORKSPACE_CONFIG)
    // A new lifetime only once it is fully closed: work started while it was closing (its path still set) belongs to the
    // aborted one, so nothing can be admitted for a workspace that is going away.
    this.life = new AbortController()
  }

  private async ensureWorkspaceStructure(): Promise<void> {
    const h = this.hiveDir
    // The folders, then the files, each all at once (HI-1705: one after another, each waited its turn behind other
    // windows' file work). Each folder is made with those above it.
    await whenAll([join(h, 'shared', 'handovers'), join(h, 'skills'), join(h, 'mcp'), join(h, 'tasks')].map((d) => mkdir(d, { recursive: true })))
    const hr = join(h, 'shared', 'handovers', 'README.md')
    await whenAll([
      // A new workspace has nothing of Hive's: its names upgrade recorded done, under the move's lock (HI-2587).
      existsSync(join(h, 'workspace.json')) ? undefined : newWorkspaceConfig().then((c) => writeKeptJson(join(h, 'workspace.json'), c)).then(() => (this.path ? recordNewWorkspace(this.path) : undefined)),
      existsSync(join(h, 'README.md')) ? undefined : writeFile(join(h, 'README.md'), WORKSPACE_README),
      // The board's database and what its move from files left (#1017) are this machine's: kept out of git if the workspace is a repository.
      existsSync(join(h, '.gitignore')) ? addUsageIgnore(join(h, '.gitignore')) : writeFile(join(h, '.gitignore'), BOARD_GITIGNORE),
      existsSync(hr) ? undefined : writeFile(hr, HANDOVER_README)
    ])
  }

  /** workspace.json saves, one after another, so an older one can't land after a newer one. */
  private savingConfig: Promise<void> = Promise.resolve()

  saveWorkspaceConfig(): Promise<void> {
    // This workspace's file and settings object (another workspace opened meanwhile has its own).
    const file = join(this.hiveDir, 'workspace.json')
    const data = this.wsConfig
    this.configSaves++
    const run = this.savingConfig.then(() => writeKeptJson(file, data, { holder: this })).finally(() => {
      this.configSaves--
      this.configWritten = JSON.stringify(data, null, 2) + '\n'
    })
    this.savingConfig = run.catch(() => undefined)
    return run
  }

  /**
   * Saves workspace.json with a change (worked out from the settings as they are when it is written) that takes effect
   * only once it is saved: a save that fails leaves the settings as they were, so whatever it marks done (#514's
   * renamesApplied) is done again next time.
   */
  saveWorkspaceConfigWith(change: (c: WorkspaceConfig) => Partial<WorkspaceConfig>): Promise<void> {
    const file = join(this.hiveDir, 'workspace.json')
    const data = this.wsConfig
    this.configSaves++
    let text: string | null = null
    const run = this.savingConfig
      .then(async () => {
        const next = { ...data, ...change(data) }
        text = JSON.stringify(next, null, 2) + '\n'
        await writeKeptJson(file, next, { holder: this })
        // Worked out again: the settings may have changed in memory while it was written (their own save is after this one).
        Object.assign(data, change(data))
      })
      .finally(() => {
        this.configSaves--
        if (text !== null) this.configWritten = text
      })
    this.savingConfig = run.catch(() => undefined)
    return run
  }

  /**
   * Watches the .combwork folder, once the open has brought its skills and modes up to date (HI-1705). With the workspace root
   * (watchRoot, from the open), that is all that is watched: the root without listing or stat-ing what is in it, since
   * chokidar stats every entry it lists through Electron's fs, which opens and holds an .asar file (#246). A folder
   * appearing, going or renamed there reads the project list again (a project's own folder changing reports 'change').
   */
  private watchHive(): void {
    if (!this.path || this.watcher) return
    const assistantHome = this.assistantHome.toLowerCase()
    const mcpDir = this.mcpDir.toLowerCase() + sep
    const hiveDir = this.hiveDir.toLowerCase() + sep
    // Only the folders whose files are shown (HI-1797): chokidar read .combwork's own listing again, and filtered each entry,
    // on every change at its top, and the board's database files there change with every board write. .combwork itself is
    // watched natively below, for workspace.json and for one of these folders appearing.
    const folders = ['shared', 'skills', 'mcp', MODES_DIR, LEGACY_MODES_DIR, DIALECTS_DIR]
    const watched = new Set(folders.filter((f) => existsSync(join(this.hiveDir, f))))
    this.watcher = chokidar.watch(
      [...watched].map((f) => join(this.hiveDir, f)),
      {
        depth: 5,
        ignoreInitial: true,
        // The Assistant's home changes with every launch; nothing in it is shown from the file system. In .combwork/mcp only
        // the definitions (<name>.json) are: a server's own folder (added from a .zip, #550) isn't watched, since a watched
        // folder inside it would stop Windows moving the folder (Replace, Delete). The board is in its database (#1017),
        // told by Hive's own writes: neither the database's files nor the cards' old folders and backups are watched.
        ignored: (p: string) => {
          const at = resolve(p).toLowerCase()
          const top = at.startsWith(hiveDir) ? at.slice(hiveDir.length).split(sep)[0] : ''
          return at === assistantHome || BOARD_FILES.test(top) || (at.startsWith(mcpDir) && (at.slice(mcpDir.length).includes(sep) || !at.endsWith('.json')))
        }
      }
    )
    const told = (rel: string): void => {
      if (rel.startsWith(`${CW_DIR}/shared`)) this.emit({ type: 'notes-changed' })
      else if (rel.startsWith(`${CW_DIR}/skills`) || rel.startsWith(`${CW_DIR}/mcp`)) {
        this.emit({ type: 'skills-changed' })
        // HI-2268: running agents' "restart to apply" is worked out by the refresh (sessions' liveInfo), as a change made
        // in the window asks for one: a skill edited, added or removed anywhere (the Skills view, an editor, an agent,
        // a git pull) shows it. Unchanged skills cost a stat each there (revisionOf), and the refresh is debounced.
        this.scheduleRefresh()
      }
      else if (rel.startsWith(`${CW_DIR}/${MODES_DIR}`) || rel.startsWith(`${CW_DIR}/${LEGACY_MODES_DIR}`)) this.emit({ type: 'modes-changed' })
      else if (rel.startsWith(`${CW_DIR}/${DIALECTS_DIR}`)) {
        // HI-2443: callers with no session follow the files; running agents whose chain they change show "restart to
        // apply", worked out by the refresh (sessions' liveInfo) as for skills.
        for (const l of WorkspaceService.dialectsListeners) {
          try {
            l(this)
          } catch (e) {
            log.warn('dialects changed', e)
          }
        }
        // The Dialects view reads them again (HI-2444): a change made outside it (an editor, git, another window) too.
        this.emit({ type: 'dialects-changed' })
        this.scheduleRefresh()
      }
      else if (rel === `${CW_DIR}/workspace.json`) void this.reloadConfig()
    }
    const chokidarWatcher = this.watcher
    chokidarWatcher.on('all', (evt, p) => told(this.path ? p.slice(this.path.length + 1).replace(/\\/g, '/') : ''))
    chokidarWatcher.on('error', (e) => log.warn('watcher error', e))
    // .combwork's own top, natively: each event only a name compared (the database's files change at every write).
    // workspace.json changed reads the config again; one of the folders above appearing is watched from then on, and
    // tells its change (what is in it is new).
    try {
      const top = watch(this.hiveDir, (_evt, name) => {
        if (this.watcher !== chokidarWatcher || !name) return
        const n = String(name)
        if (n === 'workspace.json') return void this.reloadConfig()
        const f = folders.find((x) => x.toLowerCase() === n.toLowerCase())
        if (!f || watched.has(f) || !existsSync(join(this.hiveDir, f))) return
        watched.add(f)
        chokidarWatcher.add(join(this.hiveDir, f))
        told(`${CW_DIR}/${f}`)
      })
      top.on('error', (e) => log.warn('watcher error (.combwork)', e))
      this.hiveTop = top
    } catch (e) {
      log.warn('watching .combwork', e)
    }
  }

  private rootRetry: NodeJS.Timeout | null = null

  /**
   * The workspace root's watch (#964). The folder deleted while it is open, Windows names it by its full path in a stream
   * of events that doesn't stop (about 100,000 in half a second), even once a folder of that name is made again, and
   * raises no error: each event reset the refresh's timers, keeping the main process busy until the workspace closed. That
   * watch ends, and is tried again every few seconds until the folder is back (a rename sends no such events).
   */
  private watchRoot(retried = false): void {
    if (!this.path || this.rootWatcher) return
    const generation = this.generation
    const retry = (): void => {
      if (this.rootRetry || generation !== this.generation) return
      this.rootRetry = setTimeout(() => {
        this.rootRetry = null
        if (generation === this.generation) this.watchRoot(true)
      }, ROOT_WATCH_RETRY_MS)
    }
    const changed = (): void => {
      // A folder renamed, added or gone: the projects' ids are read again, and a project renamed tells the board (#508).
      if (this.ids) this.ids.at = 0
      this.scheduleRefresh()
      this.scheduleIdsCheck()
    }
    let watcher: RootWatcher
    const end = (): void => {
      if (this.rootWatcher === watcher) this.rootWatcher = null
      watcher.close()
      retry()
    }
    try {
      watcher = watch(this.path, (evt, name) => {
        if (this.rootWatcher !== watcher) return
        if (name && /[\\/]/.test(name)) {
          log.warn('the workspace folder is gone: its watch ends until it is back')
          return end()
        }
        if (evt === 'rename') changed()
      })
    } catch (e) {
      if (!retried) log.warn('watching the workspace root', e)
      retry()
      return
    }
    watcher.on('error', (e) => {
      log.warn('workspace root watcher error', e)
      end()
    })
    this.rootWatcher = watcher
    // Watched again after the folder was gone: what is in it now may have changed meanwhile.
    if (retried) changed()
  }

  /** The cards' folder before 0.9 (#1017): now the stub an older Hive looks at, and the import's source. */
  get tasksDir(): string {
    return join(this.hiveDir, 'tasks')
  }

  /**
   * MCP settings from before #1093 moved to its model, once, so what ran still runs and nothing new starts: a server on
   * for all projects is on in the workspace and in every project that didn't turn it off; one a project turned on is on
   * in the workspace and that project (migratedWorkspaceMcp, migratedProjectMcp). The projects (hidden ones too) are
   * written first, keeping their old `disabled` lists, so a move cut short does the same again; then workspace.json
   * says it's done, and the old lists are emptied.
   */
  private async migrateMcpModel(): Promise<void> {
    if (this.wsConfig.mcp.model === 2) return
    const allProjects = this.wsConfig.mcp.enabled
    const paths = (await whenAll([this.listProjectPaths(), this.listProjectPaths({ hidden: true })])).flat()
    const configs = await Promise.all(paths.map((p) => this.projectConfig(p).then((c) => c.mcp, () => null)))
    for (const [i, p] of paths.entries()) {
      const was = configs[i]
      if (!was) continue
      const now = migratedProjectMcp(allProjects, was)
      if (JSON.stringify(now) !== JSON.stringify(was.enabled)) await this.mutateProjectConfig(p, (c) => ({ mcp: { ...c.mcp, enabled: migratedProjectMcp(allProjects, c.mcp) } }))
    }
    const enabled = migratedWorkspaceMcp(allProjects, configs)
    await this.saveWorkspaceConfigWith((c) => ({ mcp: { ...c.mcp, enabled, model: 2 } }))
    for (const [i, p] of paths.entries()) {
      if (configs[i]?.disabled?.length) await this.mutateProjectConfig(p, (c) => ({ mcp: { ...c.mcp, disabled: [] } })).catch((e) => log.warn(`emptying the old MCP list of ${userText(p)}`, e))
    }
    log.info(`MCP settings moved to the workspace and project switches (#1093): ${enabled.length} on in the workspace`)
  }

  /**
   * The Hive Assistant's own MCP choices (HI-1472), once per workspace: none in a new workspace; in one from before, the
   * servers on in the workspace when the old Advanced switch (`hive.assistant.otherMcpServers`, kept for this) was on,
   * so what it got still runs, else none. A list already there (an empty one too) is the user's and stays. Worked out as
   * it is saved, so a choice made meanwhile wins.
   */
  private async migrateAssistantMcp(fresh: boolean): Promise<void> {
    if (Array.isArray(this.wsConfig.mcp.assistant)) return
    const legacyOn = !fresh && advanced.legacy(ASSISTANT_OTHER_MCP) === true
    let moved = 0
    await this.saveWorkspaceConfigWith((c) => {
      if (Array.isArray(c.mcp.assistant)) return {}
      const assistant = legacyOn ? [...c.mcp.enabled].sort() : []
      moved = assistant.length
      return { mcp: { ...c.mcp, assistant } }
    })
    log.info(`the Assistant's MCP servers are its own choices (HI-1472): ${legacyOn ? `${moved} from the old Advanced switch` : 'none'}`)
  }

  /**
   * Each project's MCP list (hidden ones too) and the Assistant's converted to mean added (HI-2059), once: what runs now
   * (mcpAdded: its own choices the workspace had on) is kept, a choice remembered while the workspace had the server off
   * is dropped. Each file in its own locked write that marks it converted (`model`, `assistantModel` 3), changing only
   * its MCP list; one that can't be read or written keeps the old meaning (mcpAdded reads it so, with workspace.json's
   * frozen `mcp.enabled`) and is tried again at the next open. Choices dropped are counted for a notice (sayMcpAddedOnce).
   */
  private async convertMcpAdded(): Promise<void> {
    let dropped = 0
    let failed = 0
    const paths = (await whenAll([this.listProjectPaths(), this.listProjectPaths({ hidden: true })])).flat()
    for (const p of paths) {
      try {
        if ((await this.projectConfig(p)).mcp.model === MCP_ADDED_MODEL) continue
        let lost = 0
        await this.mutateProjectConfig(
          p,
          (c) => {
            if (c.mcp.model === MCP_ADDED_MODEL) return {}
            const added = mcpAdded(c.mcp, this.wsConfig.mcp.enabled)
            lost = new Set(mcpNames(c.mcp.enabled)).size - new Set(added).size
            return { mcp: { ...c.mcp, enabled: added, model: MCP_ADDED_MODEL } }
          },
          { existing: true }
        )
        dropped += lost
      } catch (e) {
        failed++
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`converting the MCP servers of ${userText(p)} to added servers (tried again at the next open)`, e)
      }
    }
    if (this.wsConfig.mcp.assistantModel !== MCP_ADDED_MODEL) {
      let lost = 0
      await this.saveWorkspaceConfigWith((c) => {
        if (c.mcp.assistantModel === MCP_ADDED_MODEL) return {}
        const assistant = assistantMcpAdded(c.mcp)
        lost = new Set(mcpNames(c.mcp.assistant)).size - new Set(assistant).size
        return { mcp: { ...c.mcp, assistant, assistantModel: MCP_ADDED_MODEL } }
      })
      dropped += lost
    }
    if (dropped) await this.saveWorkspaceConfigWith((c) => ({ mcp: { ...c.mcp, droppedNotice: (c.mcp.droppedNotice ?? 0) + dropped } }))
    if (dropped || failed) log.info(`MCP servers converted to added servers (HI-2059): ${dropped} choice(s) for servers off in the workspace dropped${failed ? `, ${failed} project(s) left for the next open` : ''}`)
  }

  /** Saves of workspace.json queued or running, and the text of the last one: the watcher sees Hive's own writes too. */
  private configSaves = 0
  private configWritten = ''

  /** workspace.json changed on disk: edited by hand (or by another copy of Hive), so read it again. */
  private async reloadConfig(): Promise<void> {
    if (!this.path || this.configSaves) return
    const generation = this.generation
    const file = join(this.hiveDir, 'workspace.json')
    const text = await readFile(file, 'utf8').catch(() => '')
    // Hive's own save, or a save started meanwhile (its settings are newer), or another workspace opened since.
    if (text === this.configWritten || this.configSaves || generation !== this.generation) return
    this.wsConfig = loadedConfig(await readKeptJson(file, {}, { holder: this }))
    this.emit({ type: 'skills-changed' })
    this.scheduleRefresh()
  }

  /** An event about this workspace, for its window (and the Agent API's event stream). */
  emit(event: HiveEvent): void {
    if (this.window) emitTo(this.window, event)
    else emit(event)
  }

  private idsTimer: NodeJS.Timeout | null = null

  /** The projects' ids read again shortly (#508): a folder renamed or moved in the workspace root tells the board. */
  private scheduleIdsCheck(): void {
    if (this.idsTimer) clearTimeout(this.idsTimer)
    this.idsTimer = setTimeout(() => {
      this.idsTimer = null
      if (this.path) void this.projectIds({ fresh: true }).catch((e) => log.warn('reading the project ids', e))
    }, 250)
  }

  scheduleRefresh(): void {
    // Closing (or closed): nothing more is read of it (#1341: close waits for the refreshes under way, not new ones).
    const life = this.life.signal
    if (life.aborted) return
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    if (!this.scheduled) {
      let tell = (): void => undefined
      const done = new Promise<void>((r) => (tell = r))
      this.scheduled = { done, tell }
    }
    const scheduled = this.scheduled
    // A window closed meanwhile (its agents stopping afterwards) has nothing to refresh.
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      if (this.scheduled === scheduled) this.scheduled = null
      // Running, it is still the scheduled one's until it has finished: a refreshesSettled from now on waits for it.
      const run = (this.path && !life.aborted ? this.refresh().then(() => undefined, (e) => log.warn('refresh failed', e)) : Promise.resolve()).finally(() => {
        this.scheduledRuns.delete(run)
        scheduled.tell()
      })
      this.scheduledRuns.add(run)
    }, 250)
  }

  /**
   * Resolves once no scheduled refresh is waiting or running: the one scheduleRefresh has waiting, those it has started
   * that haven't finished, and any scheduled while those ran (#1143: a test counting what one refresh reads waits for the
   * ones its own writes scheduled, and opening's, however far along they are).
   */
  async refreshesSettled(): Promise<void> {
    for (;;) {
      if (this.scheduled) await this.scheduled.done
      else if (this.scheduledRuns.size) await Promise.allSettled([...this.scheduledRuns])
      else return
    }
  }

  /** The workspace's project folders, without the ones hidden or removed from Hive (hidden: true lists only those). */
  async listProjectPaths(opts: { hidden?: boolean } = {}): Promise<string[]> {
    // Its folder as the call began: one closing meanwhile still lists that folder's, never a null path.
    const path = this.path
    if (!path) return []
    const entries = await readdir(path, { withFileTypes: true })
    const hidden = new Set((this.wsConfig.hiddenProjects ?? []).map((h) => h.name.toLowerCase()))
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$') && hidden.has(e.name.toLowerCase()) === !!opts.hidden)
      .map((e) => join(path, e.name))
      .sort((a, b) => basename(a).localeCompare(basename(b), undefined, { sensitivity: 'base' }))
  }

  /**
   * Each project's stable id (#508), hidden projects' too, read again whenever the folders in the workspace change (a
   * rename shows as one going and one coming). A project without one is given one now, and so is a copy of a folder that
   * brought its project.json along (settleProjectIds says which keeps the id). Folders without Hive's files have none.
   */
  async projectIds(opts: { fresh?: boolean } = {}): Promise<ProjectIdIndex> {
    if (!this.path) return NO_PROJECT_IDS
    // Listed again at most once a second (a board read checks many cards, each by its project's id), or now with
    // `fresh`: what is read in the second after that sees the same projects.
    if (this.ids && !opts.fresh && Date.now() - this.ids.at < 1000) return this.ids
    const listing = ++this.idsListed
    const paths = (await whenAll([this.listProjectPaths(), this.listProjectPaths({ hidden: true })])).flat()
    // Each folder with its project.json's identity and time: a folder replaced by another of the same name, or two
    // projects that swapped names, read again too.
    const key = (
      await Promise.all(
        paths.map(async (p) => {
          const st = await stat(join(p, CW_DIR, 'project.json')).catch(() => null)
          return `${p.toLowerCase()}:${st ? `${st.ino}:${st.mtimeMs}` : '-'}`
        })
      )
    )
      .sort()
      .join('|')
    if (this.ids?.key === key) {
      this.ids.at = Date.now()
      this.idsSettled = Math.max(this.idsSettled, listing)
      return this.ids
    }
    if (this.idsRead?.key === key) {
      this.idsRead.ticket.listing = Math.max(this.idsRead.ticket.listing, listing)
      return this.idsRead.run
    }
    const ticket = { listing }
    const run = this.readProjectIds(paths, key, ticket).finally(() => {
      if (this.idsRead?.run === run) this.idsRead = null
    })
    this.idsRead = { key, run, ticket }
    return run
  }

  /** The projects' ids as last read (projectIds), for code that can't wait: a folder not read yet has none. */
  projectIdsNow(): ProjectIdIndex {
    return this.ids ?? NO_PROJECT_IDS
  }

  private async readProjectIds(paths: string[], key: string, ticket: { listing: number }): Promise<ProjectIdIndex> {
    const gen = this.generation
    const entries: ProjectIdEntry[] = []
    const cfgs = new Map<string, ProjectConfig>()
    // Read all at once (HI-1705), kept in the listing's order.
    const read = await whenAll(paths.map((p) => (existsSync(join(p, CW_DIR, 'project.json')) ? this.projectConfig(p).catch(() => null) : null)))
    paths.forEach((p, i) => {
      const cfg = read[i]
      if (!cfg) return
      entries.push({ path: p, id: cfg.id, lastPath: cfg.lastPath })
      cfgs.set(p.toLowerCase(), cfg)
    })
    const { keep, fresh } = settleProjectIds(entries)
    for (const p of fresh) {
      if (gen !== this.generation) break
      // A later listing has settled: this read's ids won't stand, so it gives none (HI-1817: a read held past a move gave
      // the moved project one, making its folder again, and the root watch then listed it).
      if (ticket.listing < this.idsSettled) break
      // In project.json's lock, against the file as it is then: an id of its own given meanwhile stays, none is given once
      // a later listing has settled, and a project gone since it was listed (moved or deleted) isn't made again.
      const taken = new Set(keep.values())
      const give = (c: ProjectConfig): Partial<ProjectConfig> => (ticket.listing < this.idsSettled || (isProjectId(c.id) && !taken.has(c.id)) ? {} : { id: `p-${randomBytes(6).toString('hex')}` })
      const cfg = await this.mutateProjectConfig(p, give, { existing: true }).catch((e: NodeJS.ErrnoException) => {
        if (e?.code !== 'ENOENT') log.warn(`giving ${userText(basename(p))} its project id`, e)
        return null
      })
      if (cfg?.id) keep.set(p.toLowerCase(), cfg.id)
    }
    const byPath = new Map<string, string>()
    const byId = new Map<string, string>()
    for (const p of paths) {
      const id = keep.get(p.toLowerCase())
      if (!id) continue
      byPath.set(p.toLowerCase(), id)
      byId.set(id, p)
    }
    const index = { key, byPath, byId, at: Date.now() }
    if (gen !== this.generation) return index
    // A later listing's read settled first: it stands, and its caller gets it.
    if (ticket.listing < this.idsSettled) return this.ids ?? index
    this.idsSettled = ticket.listing
    this.ids = index
    // Each project by its id, as this read saw it (#514): the record of their names, and what follows a rename, go from it.
    const copies = new Set(fresh.map((p) => p.toLowerCase()))
    const seen: ProjectSeen[] = []
    for (const [lower, id] of byPath) {
      const cfg = cfgs.get(lower)
      seen.push({ path: byId.get(id)!, id, ...(cfg?.lastPath ? { lastPath: cfg.lastPath } : {}), copy: copies.has(lower) && isProjectId(cfg?.id) })
    }
    WorkspaceService.onIdsRead?.(this, seen)
    // A project renamed or moved (an id at another folder now): the cards, lanes and watches that name it read differently,
    // so the window and the services that follow the board look again (#508).
    const moved = [...byId].some(([id, p]) => { const before = this.lastAt.get(id); return !!before && before.toLowerCase() !== p.toLowerCase() })
    // Each id read now goes last, so those first in the map are the ones missed longest ago: dropped past the bound.
    for (const [id, p] of byId) {
      this.lastAt.delete(id)
      this.lastAt.set(id, p)
    }
    let absent = this.lastAt.size - byId.size
    for (const id of this.lastAt.keys()) {
      if (absent <= WorkspaceService.absentIdsKept) break
      if (byId.has(id)) continue
      this.lastAt.delete(id)
      absent--
    }
    if (moved && this.path) this.emit({ type: 'tasks-changed', workspacePath: this.path })
    return index
  }

  /** Projects Hive leaves out (Hide, Remove from Hive), and whether each folder is still in the workspace. */
  hiddenProjects(): (HiddenProject & { present: boolean })[] {
    if (!this.path) return []
    return (this.wsConfig.hiddenProjects ?? []).map((h) => ({ ...h, present: existsSync(join(this.path!, h.name)) }))
  }

  /** Sets the workspace's own value of an advanced setting a workspace can set (#367), or removes it (null: Hive's again). */
  async setAdvanced(id: string, raw: unknown): Promise<void> {
    if (!this.path) throw hiveError(M.noWorkspace, undefined, { kind: 'conflict' })
    const def = advancedDef(id)
    if (!def?.workspace) throw hiveError(msg({ id: 'service.workspace.advancedNotHere', defaultMessage: "{setting} can't be set for a workspace.", description: 'An error: the advanced setting {setting} (its title, or its id) has no value of its own for a workspace, only for Combwork.' }), { setting: def?.text.title ?? id }, { kind: 'invalid' })
    const own = { ...this.wsConfig.advanced }
    if (raw === null || raw === undefined) delete own[id]
    else {
      const checked = checkAdvanced(def, raw)
      // agent-text: checkAdvanced
      if ('error' in checked) throw new HiveError(checked.errorText, { kind: 'invalid' })
      own[id] = checked.value
    }
    if (Object.keys(own).length) this.wsConfig.advanced = own
    else delete this.wsConfig.advanced
    await this.saveWorkspaceConfig()
  }

  /** Leaves a project folder out of the workspace (mode says how), or takes it back (null). */
  async setHidden(name: string, mode: HiddenProject['mode'] | null): Promise<void> {
    const rest = (this.wsConfig.hiddenProjects ?? []).filter((h) => h.name.toLowerCase() !== name.toLowerCase())
    this.wsConfig.hiddenProjects = mode ? [...rest, { name, mode, at: new Date().toISOString() }] : rest
    if (!this.wsConfig.hiddenProjects.length) delete this.wsConfig.hiddenProjects
    await this.saveWorkspaceConfig()
  }

  isProjectPath(p: string): boolean {
    if (!this.path) return false
    const abs = resolve(p)
    if (!abs.toLowerCase().startsWith(this.path.toLowerCase() + sep) || basename(abs).startsWith('.') || abs.split(sep).length !== this.path.split(sep).length + 1) return false
    // A hidden or removed project isn't one of the workspace's until it's restored.
    return !(this.wsConfig.hiddenProjects ?? []).some((h) => h.name.toLowerCase() === basename(abs).toLowerCase())
  }

  assertProject(p: string): string {
    if (!this.isProjectPath(p)) throw hiveError(msg({ id: 'service.workspace.notProject', defaultMessage: 'Not a project in the open workspace: {path}', description: "An error: {path} isn't one of the open workspace's projects (a folder in it, not hidden)." }), { path: p }, { kind: 'notFound' })
    return resolve(p)
  }

  /** A project folder, or the worktree of one of a project's agents (for the Files and Changes tabs). */
  assertRoot(p: string): string {
    if (this.isProjectPath(p)) return resolve(p)
    if (this.roots.has(resolve(p).toLowerCase())) return resolve(p)
    throw hiveError(msg({ id: 'service.workspace.notRoot', defaultMessage: 'Not a project or agent worktree in the open workspace: {path}', description: "An error: {path} is neither one of the open workspace's projects nor the worktree of one of their agents." }), { path: p }, { kind: 'notFound' })
  }

  /**
   * What the Changes tab reads git status and diffs in (#400): a project folder, an agent's worktree, or one of a
   * project's unused worktrees as last listed (`noteUnusedWorktrees`). Only git reads go through it: the Files tab's file
   * operations keep `assertRoot`.
   */
  assertChangesRoot(p: string): string {
    if (this.unusedRoots.has(resolve(p).toLowerCase())) return resolve(p)
    return this.assertRoot(p)
  }

  /** A project's unused worktrees as just listed (#400): the ones the Changes tab may read, replacing the last list. */
  noteUnusedWorktrees(projectPath: string, paths: string[]): void {
    if (!this.isProjectPath(projectPath)) return
    for (const [k, v] of this.unusedRoots) if (v.toLowerCase() === resolve(projectPath).toLowerCase()) this.unusedRoots.delete(k)
    for (const p of paths) this.unusedRoots.set(resolve(p).toLowerCase(), resolve(projectPath))
  }

  /** Whether an absolute, lower-cased path is (inside) one of this workspace's agent worktrees. */
  ownsRoot(abs: string): boolean {
    for (const r of this.roots.keys()) if (abs === r || abs.startsWith(r + sep)) return true
    return false
  }

  /**
   * Every agent folder this workspace knows outside its projects' own (lower-cased): their slots and retired homes as
   * last read, 0.9 worktrees and worktrees noted unused, wherever they are (HI-2496: Agents' temp folder stays out of them).
   */
  knownRoots(): string[] {
    return [...this.roots.keys(), ...this.unusedRoots.keys()]
  }

  /** The project a worktree belongs to, or the project itself. */
  projectForRoot(p: string): string | null {
    if (this.isProjectPath(p)) return resolve(p)
    return this.roots.get(resolve(p).toLowerCase()) ?? null
  }

  /**
   * Records a project's agent worktrees, from a config read or written in generation `gen` (none once the workspace has
   * closed or switched since) with `ticket` (none when a later read or write has recorded them already, #784).
   * `folders`: its slots and retired homes as that read found them (#1442), kept for later writes only when the read is
   * the newest (the same fence: a late read neither publishes nor caches folders a newer one has dropped).
   */
  /**
   * Records a project seen with its project.json (HI-2564, setUpAt), fenced as registerRoots is: `ticket` taken when the
   * observation began. Nothing from another lifetime, nothing older than what is recorded, and nothing from before a
   * listing that found the folder gone.
   */
  private markSetUp(projectPath: string, gen: number, ticket: number): void {
    const key = projectPath.toLowerCase()
    if (gen !== this.generation || ticket < (this.setUpAt.get(key) ?? 0)) return
    if (this.listedAt && ticket < this.listedAt.ticket && !this.listedAt.known.has(key)) return
    this.setUpAt.set(key, ticket)
    this.goneSaid.delete(key)
  }

  /** For unit tests (HI-2564): the ticket a project's set-up was recorded at, or undefined. */
  setUpTicket(projectPath: string): number | undefined {
    return this.setUpAt.get(projectPath.toLowerCase())
  }

  private registerRoots(projectPath: string, cfg: ProjectConfig, gen: number, ticket: number, folders?: readonly string[]): void {
    const key = projectPath.toLowerCase()
    if (gen !== this.generation || ticket < (this.rootsAt.get(key) ?? 0)) return
    // A project gone as the last refresh listed the folders, read before that: the read is older than its going.
    if (this.listedAt && ticket < this.listedAt.ticket && !this.listedAt.known.has(key)) return
    this.rootsAt.set(key, ticket)
    if (folders) this.folderRoots.set(key, [...folders])
    for (const [k, v] of this.roots) if (v.toLowerCase() === projectPath.toLowerCase()) this.roots.delete(k)
    // Agents' 0.9 worktrees (#1451: through legacyWorktree), and the project's slots and retired homes as last read
    // (#1442: the Files tab and file links open the folder an agent works in).
    for (const a of cfg.agents ?? []) {
      const w = legacyWorktree(a)
      if (w) this.roots.set(resolve(w.path).toLowerCase(), projectPath)
    }
    for (const f of this.folderRoots.get(key) ?? []) this.roots.set(resolve(f).toLowerCase(), projectPath)
  }

  /**
   * Writes 0.9.3's fields of one agent (#1452: they aren't AgentDef's): its 0.9 worktree's setup run done, or a test
   * copy's 0.9 agent (`agents:testLegacy`). 1.0 makes no new worktree; Repair writes through mutateProjectConfig.
   */
  async updateLegacyAgent(projectPath: string, agentId: string, fields: LegacyAgentFields): Promise<StoredAgent> {
    return this.updateAgent(projectPath, agentId, fields as Partial<AgentDef>)
  }

  /**
   * An agent as saved now, read under the lock its changes take (mutateProjectConfig): a launch's last look at its
   * connection (HI-1755), so a save under way is either in it or not yet begun.
   */
  async savedAgent(projectPath: string, agentId: string): Promise<AgentDef | undefined> {
    return withFileLock(join(projectPath, CW_DIR, 'project.json'), async () => projectAgents(await this.projectConfig(projectPath)).find((a) => a.id === agentId))
  }

  /** Changes one agent's definition. */
  /** `check`: sees the agent as saved, under the project's lock, before the change; throwing refuses it (#1282's undo). */
  async updateAgent(projectPath: string, agentId: string, patch: Partial<AgentDef>, check?: (current: AgentDef) => void): Promise<AgentDef> {
    let next: AgentDef | undefined
    await this.mutateProjectConfig(projectPath, (cfg) => {
      const current = projectAgents(cfg).find((a) => a.id === agentId)
      if (!current) throw hiveError(msg({ id: 'service.workspace.agentGone', defaultMessage: 'That agent no longer exists.', description: "An error changing an agent's settings: it was removed meanwhile." }), undefined, { kind: 'notFound' })
      check?.(current)
      const def: AgentDef = { ...current, ...patch, id: agentId }
      next = def
      return { agents: projectAgents(cfg).map((a) => (a.id === agentId ? def : a)) }
    })
    return next!
  }

  /** Creates <project>/.combwork with defaults and excludes it from git. Idempotent. */
  /**
   * The folder move's late phases (HI-2462, combworkMove.ts): the cards' paths, rewritten in a worker, and each moved
   * project's agents' folders that were inside its old `.hive` (slots, copies, homes) recorded at their new place.
   */
  private async finishFolderMove(o: MoveOptions = {}): Promise<void> {
    const path = this.path
    if (!path) return
    const { projectFolders, relocateFolder } = await import('./projectFolders')
    await finishMove(
      path,
      {
        boardFile: boardFile(path),
        relocateFolders: async (projectPath, moves) => {
          for (const f of await projectFolders(this, projectPath)) {
            const to = movedPathOf(f.folder, moves)
            if (to && !(await relocateFolder(this, projectPath, f, to))) return false
          }
          return true
        }
      },
      o
    )
  }

  async ensureProject(projectPath: string): Promise<void> {
    // Its set-up recorded once it is done (HI-2564), as of now.
    const gen = this.generation
    const ticket = ++this.rootTickets
    // A project that came into the open workspace with a `.hive` of its own (copied in, restored): moved first (HI-2462),
    // so a fresh `.combwork` never strands its settings. The open's own move did every project there was then.
    if (this.path && !this.isAssistantHome(projectPath) && (await classify(this.path, projectPath, 'project')) === 'planned') {
      const moved = await moveFolders(this.path, { only: projectPath })
      if (moved.late) await this.finishFolderMove()
    }
    const h = join(projectPath, CW_DIR)
    // Never the project's own folder (HI-2045): each folder and file is made only inside one that is there, so a project
    // deleted or moved out meanwhile, at any step (as when a refresh that listed it before reads it after), fails with
    // ENOENT rather than coming back as a bare `.combwork`. The Assistant's home is Hive's, made with its parents.
    const made = (dir: string): Promise<void> =>
      mkdir(dir).then(
        () => undefined,
        (e: NodeJS.ErrnoException) => {
          if (e.code !== 'EEXIST') throw e
        }
      )
    if (this.isAssistantHome(projectPath)) await mkdir(projectPath, { recursive: true })
    await made(h)
    // Its folders and its exclusion from git at once (HI-1705).
    await whenAll([
      this.ensureGitExclude(projectPath),
      (async () => {
        await whenAll([made(join(h, 'sessions')), made(join(h, 'archive'))])
        // Its platform is recorded as it is made, from what detection finds (SPEC §16.3.5): never switched silently after.
        // Made only if none is there by then (HI-2542): one written meanwhile (copied in with the folder, a refresh the
        // folder's appearing began reading it) is kept, never replaced by the default.
        if (!existsSync(join(h, 'project.json'))) {
          await configTestHooks.beforeDefaultConfig?.(projectPath)
          const isNew = await createKeptJson(join(h, 'project.json'), withoutView({ ...DEFAULT_PROJECT_CONFIG, platform: detect(projectPath).platform }), { existing: true })
          // Its load, in the log (HI-2563): the default made, or the project's own kept.
          log.info(`${userText(basename(projectPath))}: ${isNew ? 'default project.json made' : 'project.json written meanwhile kept, no default made'}`)
        }
        // 0.1's launch folder for Agent 1; every agent now has launch-<id>.
        if (existsSync(join(h, 'launch'))) await removePath(join(h, 'launch')).catch(() => undefined)
      })()
    ])
    // Its own names upgrade (HI-2587, HR2's round 1), by its own record: a project that came into an upgraded workspace
    // with a `.combwork` of an RC's (its skill copies' old markers, git's old comments and refs), or a new one, once.
    // Under the move's lock, refused while another process has the workspace open (HR2's round 3): then nothing is
    // written, the project is used as it is, and the next time it is set up (or the workspace opens) tries again.
    if (this.path && !this.isAssistantHome(projectPath) && !(await projectNamesDone(projectPath))) {
      try {
        const moved = await moveFolders(this.path, { only: projectPath })
        if (moved.late) await this.finishFolderMove()
      } catch (e) {
        if (!(e instanceof HiveError) || e.kind !== 'conflict') throw e
        log.warn(`${userText(basename(projectPath))}: its names upgrade waits: ${userText(englishError(e))}`)
      }
    }
    if (!this.isAssistantHome(projectPath) && existsSync(join(h, 'project.json'))) this.markSetUp(projectPath, gen, ticket)
  }

  private gitDir(projectPath: string): Promise<string | null> {
    return gitDirOf(projectPath)
  }

  /** Adds the project's .combwork to the info/exclude of the git repository holding it (its own, or one above), if it isn't (#345). */
  async ensureGitExclude(projectPath: string): Promise<void> {
    const r = await ensureHiveExcluded(projectPath)
    if (r?.added) log.info(`Excluded .combwork from git in ${userText(r.root)}`)
    // The line is there whatever git can do; git missing only means it couldn't confirm a .gitignore doesn't bring .combwork back (#346).
    if (r?.unconfirmed) log.info(`Git couldn't confirm .combwork is ignored in ${userText(r.root)}${gitProblem() ? ` (${gitProblem()})` : ''}`)
  }

  async branch(projectPath: string): Promise<string | null> {
    const gd = await this.gitDir(projectPath)
    if (!gd) return null
    try {
      // For worktrees HEAD lives in the worktree gitdir, not the common dir.
      const gfile = join(projectPath, '.git')
      let headDir = gd
      if (statSync(gfile).isFile()) {
        const m = (await readFile(gfile, 'utf8')).match(/gitdir:\s*(.+)/)
        if (m) headDir = resolve(projectPath, m[1].trim())
      }
      const head = (await readFile(join(headDir, 'HEAD'), 'utf8')).trim()
      const m = head.match(/^ref: refs\/heads\/(.+)$/)
      return m ? m[1] : head.slice(0, 8)
    } catch {
      return null
    }
  }

  /** A project's config; `opts` for a read that is written back (mutateProjectConfig, #1600). */
  async projectConfig(projectPath: string, opts?: KeptReadOptions): Promise<ProjectConfig> {
    // By its stat (HI-1814): read, migrated and merged with the defaults again only once it changed.
    const file = await readKeptJsonByStat(join(projectPath, CW_DIR, 'project.json'), {} as Record<string, unknown>, projectFileConfig, opts)
    const cfg = this.withView(projectPath, file.cfg, file.viewKeys)
    // The Assistant's "project" settings are Settings → Assistant; its file keeps the workspace's own choices.
    return this.isAssistantHome(projectPath) ? assistantProjectConfig(cfg, config.settings) : cfg
  }

  /**
   * A project's config with this user's view of it (HI-1749: AppConfig.ui.projectViews) over its file's. The first read of
   * a project with none kept takes what its project.json has (from before the view moved out), so no one loses a layout.
   */
  private withView(projectPath: string, cfg: ProjectConfig, fileViewKeys: string[]): ProjectConfig {
    const views = config.get().ui.projectViews
    // One kept by its folder before it had an id is still its view.
    let view = views?.[projectViewKey(cfg, projectPath)] ?? views?.[projectViewKey({}, projectPath)]
    if (!view) {
      view = viewOf(Object.fromEntries(fileViewKeys.map((k) => [k, cfg[k as keyof ProjectConfig]])) as Partial<ProjectConfig>)
      if (Object.keys(view).length) this.keepView(projectPath, { ...cfg, ...view })
    }
    return { ...cfg, ...view }
  }

  /** Keeps a project's view (its config's view fields) in this user's UI state, when it changed. */
  private keepView(projectPath: string, cfg: ProjectConfig): void {
    const key = projectViewKey(cfg, projectPath)
    const view = viewOf(cfg)
    if (JSON.stringify(config.get().ui.projectViews?.[key] ?? {}) === JSON.stringify(view)) return
    config.update((c) => void (c.ui.projectViews = { ...c.ui.projectViews, [key]: view }))
  }

  /** A stamp of Hive's last write of this project's project.json (#1432, #1498): compared, whether it changed since a read. */
  projectConfigWrites(projectPath: string): number {
    return this.configWrites.get(projectPath.toLowerCase())?.stamp ?? this.configFloor
  }

  /** Forgets a project's write stamp (#1498): it reads the floor from now, at least as new, so still a change. */
  private forgetConfigWrites(key: string): void {
    const w = this.configWrites.get(key)
    if (!w) return
    this.configWrites.delete(key)
    this.configFloor = Math.max(this.configFloor, w.stamp)
  }

  async updateProjectConfig(projectPath: string, patch: Partial<ProjectConfig>): Promise<ProjectConfig> {
    return this.mutateProjectConfig(projectPath, () => patch)
  }

  /**
   * Changes project.json from its current content: fn gets the config as it is now and returns the
   * fields to change. Changes to one project's config never overlap, so none is lost.
   *
   * A change that takes an agent out of the project (removed, merged away, replaced by a template's, any `agents` patch
   * that drops an id) is published under the workspace's board lock too (#1382): a card loop's design step resolves its
   * reviewer and writes in one board change, so a removal is either before it (no reviewer: refused) or after it, never
   * between its read and its write. Detected from the change itself (the ids before `fn` against the config it makes),
   * so no caller can bypass it. Outside a board change, such a change writes nothing, lets go of the file and runs
   * again inside one (lock order: the agent names lock, the board, then this file), so **`fn` may run more than once**:
   * it must only compute its change from `cfg` (what it records on the side is overwritten by the run that writes).
   *
   * project.json still being saved by something else (an editor) is read again a few times, and then the change is
   * refused (KeptFileBusy, #1600): never written over that save with the value from before it.
   */
  async mutateProjectConfig(projectPath: string, fn: (cfg: ProjectConfig) => Partial<ProjectConfig>, opts: { existing?: boolean } = {}): Promise<ProjectConfig> {
    const gen = this.generation
    // `existing`: a change to a project.json that is there, never one making the project (HI-1817: a project moved out
    // meanwhile fails with ENOENT, its folder not made again).
    if (!opts.existing) await this.ensureProject(projectPath)
    const file = join(projectPath, CW_DIR, 'project.json')
    let ticket = 0
    // The board an agent leaving publishes under: this workspace's, for one of its projects (the Assistant's home has none).
    const board = this.path && !this.isAssistantHome(projectPath) ? this.path : null
    const publish = (): Promise<ProjectConfig | null> =>
      retryWhileSaving(() => withFileLock(file, async () => {
        // The file as this change reads it (HI-2563): one written meanwhile by something outside the lock (a project's own
        // project.json written into its folder just after Combwork took the folder on) is read again, never replaced.
        const readAt = await keptStamp(file)
        const cfg = await this.projectConfig(projectPath, { unsettled: 'throw' })
        if (opts.existing && !existsSync(file)) throw Object.assign(new Error('the project is gone'), { code: 'ENOENT' }) // i18n-ignore: internal, its caller drops ENOENT unshown
        const had = projectAgents(cfg).map((a) => a.id)
        const patch = fn(cfg)
        let updated = { ...cfg, ...patch }
        // 0.9.3's agent fields (#1452): an agent written again without them keeps what is stored.
        if ('agents' in patch && Array.isArray(updated.agents)) updated = { ...updated, agents: carryLegacyAgentFields(projectAgents(cfg), updated.agents) }
        // An agent given a connection removed (or being removed) meanwhile: refused, nothing written (HI-2107).
        if ('agents' in patch) assertConnectionsAssignable(projectAgents(cfg), projectAgents(updated))
        // An agent leaving, outside this workspace's board change: nothing written, so it runs again inside one.
        if (board && !inBoardWrite(board) && 'agents' in patch) {
          const now = new Set(projectAgents(updated).map((a) => a.id))
          if (had.some((id) => !now.has(id))) return null
        }
        // The agents changed: each layout's pane placement takes in those added and lets go of those removed (#762), so
        // every agent keeps its cell (not one worked out again from the order on each read).
        if ('agents' in patch && updated.placement) updated = { ...updated, placement: settlePlacements(updated.placement, projectAgents(updated).map((a) => a.id)) }
        // Card loops and file locks from before HI-1766 (HR5's round 1): once the project has workflow options, any old
        // keys left move into them in this same write (a value there wins) and go, so none can come back after it; a
        // patch that consumed them (LEGACY_CONSUMED) leaves nothing to move.
        updated = migrateProjectPreferences(updated)
        // The view (HI-1749) to this user's UI state, saved a moment later and on quit; project.json only for a change of
        // the config, written without the view (one from before moves out as it is written).
        this.keepView(projectPath, updated)
        if (changesConfig(patch)) {
          await configTestHooks.beforeConfigWrite?.(projectPath)
          // Checked as it goes into place, each try (HI-2563): a rename Windows refused while something outside held the
          // file to write it would otherwise land on what that wrote.
          // Accepted (HI-2565): one written whole, in place, after this check and before the rename is replaced, Node having
          // no rename that swaps or refuses. A real project arrives complete (copied or moved in, HI-2542), not in that moment.
          const unchanged = async (): Promise<void> => {
            if ((await keptStamp(file)) === readAt) return
            log.info(`${userText(basename(projectPath))}: project.json changed while a change to it was made: read again (HI-2563)`)
            throw new KeptFileBusy(file)
          }
          await writeKeptJson(file, withLegacyProjectFields(withoutView(updated)), { existing: opts.existing, guard: unchanged })
        }
        // As it is written: a read begun before now may have found the config from before.
        ticket = ++this.rootTickets
        // Kept only for the workspace it was asked in (#1498): one that closed (or gave way to another) meanwhile keeps
        // no path of it; the floor takes its stamp instead, so a snapshot from before still reads it as a change.
        const stamp = ++this.configStamp
        if (gen === this.generation) this.configWrites.set(projectPath.toLowerCase(), { stamp, ticket })
        else this.configFloor = Math.max(this.configFloor, stamp)
        return updated
      }))
    const next =
      (await publish()) ??
      (await (async () => {
        configTestHooks.beforeBoardRetry?.(projectPath)
        return boardWrite(this, async () => (await publish())!, { alive: () => gen === this.generation && this.path === board })
      })())
    this.registerRoots(projectPath, next, gen, ticket)
    if (gen === this.generation) this.savedAt.set(projectPath.toLowerCase(), Math.max(ticket, this.savedAt.get(projectPath.toLowerCase()) ?? 0))
    this.scheduleRefresh()
    return next
  }

  /**
   * Where a session host's records are kept (#1061): its workspace's database (a project's workspace is its parent folder,
   * the Assistant's home is the workspace's `.combwork/assistant`), under the project's stable id (#508), so they follow a
   * rename; the Assistant's under `assistant`, a folder with no id yet under its name. With its old sessions.json, moved in
   * the first time.
   */
  private async sessionsPlace(projectPath: string): Promise<SessionsPlace> {
    const h = resolve(projectPath)
    const file = join(h, CW_DIR, 'sessions.json')
    const parent = dirname(h)
    if (basename(h).toLowerCase() === ASSISTANT_DIR.toLowerCase() && basename(parent).toLowerCase() === CW_DIR) return { workspace: dirname(parent), scope: 'assistant', file }
    const known = this.path ? (await this.projectIds().catch(() => null))?.byPath.get(h.toLowerCase()) : undefined
    const saved = known ?? (await readJson<{ id?: unknown } | null>(join(h, CW_DIR, 'project.json'), null).catch(() => null))?.id
    // Asked when a file would be moved in (#1161), not now: a change may wait for its turn meanwhile, and land after its
    // workspace closed. Fails closed: present only while this service has that workspace open and its live config doesn't
    // list the project as removed; closed or replaced since, removed as far as a move in goes (the file stays).
    const removed = (): boolean => !this.path || !samePlace(parent, this.path) || (this.wsConfig.hiddenProjects ?? []).some((x) => x.mode === 'removed' && x.name.toLowerCase() === basename(h).toLowerCase())
    return { workspace: parent, scope: typeof saved === 'string' && saved ? saved : `folder:${basename(h).toLowerCase()}`, file, removed }
  }

  /**
   * Where a session host's usage history is (#1106): the workspace folder its database is in and its scope there, as for
   * its session records; a removed project keeps its scope, so its history comes back with it.
   */
  async sessionScope(projectPath: string): Promise<{ workspace: string; scope: string }> {
    const p = await this.sessionsPlace(projectPath)
    return { workspace: p.workspace, scope: p.scope }
  }

  /**
   * A session host's records (#1061: in the workspace's database). `signal`: the opening of the workspace they're read
   * for (background work); once it's aborted nothing is read, so a closed workspace's database isn't opened again (#1379).
   */
  async sessionsFile(projectPath: string, signal?: AbortSignal): Promise<SessionsFile> {
    const place = await this.sessionsPlace(projectPath)
    signal?.throwIfAborted()
    return readSessions(place, signal)
  }

  /** One of a host's session records by its id (#1211: read by its key, not with every record), or undefined. */
  async sessionRecord(projectPath: string, id: string): Promise<SessionRecord | undefined> {
    return readSession(await this.sessionsPlace(projectPath), id)
  }

  /** A host's session records of one agent, most recently active first (HI-1236: by the agent's index, not every record). */
  async sessionsOfAgent(projectPath: string, agentId: string): Promise<SessionRecord[]> {
    return readAgentSessions(await this.sessionsPlace(projectPath), agentId)
  }

  /** A host's session records that worked on a card, in their order (HI-1236: by the cards' index, not every record). */
  async sessionsOfCard(projectPath: string, card: number): Promise<SessionRecord[]> {
    return readCardSessions(await this.sessionsPlace(projectPath), card)
  }

  /** Changes a host's session records from what is saved now, one change at a time; only what changed is written. */
  async mutateSessions<T>(projectPath: string, fn: (f: SessionsFile) => T): Promise<T> {
    return changeSessions(await this.sessionsPlace(projectPath), fn)
  }

  /** Writes a project's session records into its folder and out of the database (#1061: Remove from Hive). */
  async exportSessions(projectPath: string): Promise<number> {
    return exportSessions(await this.sessionsPlace(projectPath))
  }

  /** Remove from Hive is over, done or not (#1061): see releaseSessions. */
  async releaseSessions(projectPath: string): Promise<void> {
    releaseSessions(await this.sessionsPlace(projectPath))
  }

  /** `created`: fields only a new record takes (a launch's start as its createdAt), never written over an existing one's. */
  async upsertSession(projectPath: string, rec: Partial<SessionRecord> & { id: string }, created?: Partial<SessionRecord>): Promise<SessionRecord> {
    // A saved record changed by its key alone (HI-1887: most calls, many a turn); a new one with every record, where it's added.
    const one = await changeSessionRecord(await this.sessionsPlace(projectPath), rec.id, (existing) => Object.assign(existing, rec))
    if (one.found) return one.value
    return this.mutateSessions(projectPath, (f) => {
      let existing = f.sessions.find((s) => s.id === rec.id)
      if (existing) Object.assign(existing, rec)
      else {
        const now = new Date().toISOString()
        // Callers name the provider; records from before providers are Claude Code's.
        existing = { agent: 'claude-code', name: '', createdAt: now, lastActiveAt: now, archived: false, ...created, ...rec }
        f.sessions.push(existing)
        // A deleted session that runs again (e.g. resumed inside the CLI) is Hive's again.
        if (f.deleted?.includes(rec.id)) f.deleted = f.deleted.filter((id) => id !== rec.id)
        // Counted from its transcript again, not twice.
        if (f.deletedUsage?.some((k) => k.id === rec.id)) f.deletedUsage = f.deletedUsage.filter((k) => k.id !== rec.id)
      }
      return existing
    })
  }

  activeNames(): string[] {
    if (!this.path) return []
    return config.get().activeProjects[this.path] ?? []
  }

  setActive(projectPath: string, active: boolean): void {
    if (!this.path) return
    const name = basename(projectPath)
    config.update((c) => {
      const list = new Set(c.activeProjects[this.path!] ?? [])
      if (active) list.add(name)
      else list.delete(name)
      c.activeProjects[this.path!] = [...list]
    })
  }

  /** MCP servers the project defines in a provider's own config (.mcp.json…) that aren't deployed to the workspace. */
  async unmanagedMcp(projectPath: string): Promise<string[]> {
    const names = new Set<string>()
    // Every provider's at once (HI-1705).
    for (const servers of await whenAll(allProviders().map((p) => p.projectMcpServers(projectPath).catch(() => ({}))))) for (const n of Object.keys(servers)) names.add(n)
    if (!names.size || !this.path) return []
    const deployed = new Set(
      (await readdir(this.mcpDir).catch(() => [] as string[])).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))
    )
    return [...names].filter((n) => !deployed.has(n))
  }

  /**
   * `gen`: the workspace's lifetime the read is for (a refresh's own, #784): none of its worktrees are recorded after it.
   * `scope`: the refresh it is part of (#1002), whose projects share one read of what their running agents' settings need.
   */
  async projectInfo(projectPath: string, gen = this.generation, scope?: object): Promise<ProjectInfo> {
    // Each part's time, logged when the read is slow (HI-1694: a 0.9 workspace's first open waited a minute on reads the
    // log didn't time).
    const parts: [string, number][] = []
    const started = performance.now()
    // Each part's own time, from when it began (some run at once).
    const took = async <T>(what: string, p: Promise<T>): Promise<T> => {
      const from = performance.now()
      try {
        return await p
      } finally {
        parts.push([what, performance.now() - from])
      }
    }
    const active = new Set(this.activeNames())
    const ticket = ++this.rootTickets
    // A folder found since the workspace opened is made a project as opening makes one (#1423): its platform recorded
    // with its project.json, so it counts as made by 1.0 (it asks "How do you work?"), not as one from before.
    // One set up in this lifetime whose project.json has gone isn't (HI-2564): a folder half way through a delete (its
    // .combwork goes first) or a project reset by deleting it. Nothing is written for it, its exclude line neither; an
    // open or a change to it sets it up again.
    let gone = false
    if (!this.isAssistantHome(projectPath)) {
      const key = projectPath.toLowerCase()
      if (existsSync(join(projectPath, CW_DIR, 'project.json'))) {
        await configTestHooks.afterConfigSeen?.(projectPath)
        this.markSetUp(projectPath, gen, ticket)
      } else if (this.setUpAt.has(key)) {
        gone = true
        if (!this.goneSaid.has(key)) {
          this.goneSaid.add(key)
          log.info(`${userText(basename(projectPath))}: project.json gone: not set up again by a refresh (HI-2564)`)
        }
      } else await this.ensureProject(projectPath).catch((e) => log.warn(`ensureProject ${userText(projectPath)}`, e))
    }
    const cfg = await took('its settings', this.projectConfig(projectPath)) // i18n-ignore: a part of a log line's timing
    this.registerRoots(projectPath, cfg, gen, ticket)
    const { live, restartNeeded, agents, folders } = await took("its agents' sessions and folders", WorkspaceService.liveProvider(projectPath, cfg, scope)) // i18n-ignore: a part of a log line's timing
    // Its slots and homes are roots from this read on (#1442), fenced as its worktrees are (registerRoots' ticket).
    if (!this.isAssistantHome(projectPath)) this.registerRoots(projectPath, cfg, gen, ticket, (folders ?? []).map((f) => f.path))
    // The rest of the read at once (HI-1705): none of these needs another.
    const [branch, unmanagedMcp, removed, vcs] = await whenAll([
      took('its branch', this.branch(projectPath)), // i18n-ignore: a part of a log line's timing
      took('its MCP servers', this.unmanagedMcp(projectPath)), // i18n-ignore: a part of a log line's timing
      took('removed data', removedData(projectPath)), // i18n-ignore: a part of a log line's timing
      // Ensured at each refresh, so a repository made later (git init) gets it too (#345). Not for one gone (HI-2564),
      // asked again as each write is made: its project.json may go while this read runs (HR2's round 1).
      this.isAssistantHome(projectPath) ? undefined : took('.combwork in git', hiveVcs(projectPath, { readOnly: () => gone || (this.setUpAt.has(projectPath.toLowerCase()) && !existsSync(join(projectPath, CW_DIR, 'project.json'))) }).catch(() => undefined)) // i18n-ignore: a part of a log line's timing
    ])
    const info: ProjectInfo = {
      name: basename(projectPath),
      path: projectPath,
      active: active.has(basename(projectPath)),
      isGitRepo: existsSync(join(projectPath, '.git')),
      branch,
      config: cfg,
      live,
      restartNeeded,
      agents,
      ...(folders?.length ? { folders } : {}),
      unmanagedMcp,
      removedData: removed,
      ...(this.isAssistantHome(projectPath) ? {} : { hiveVcs: vcs, platform: projectPlatform(projectPath, cfg.platform, cfg.platformFound) })
    }
    const ms = performance.now() - started
    if (ms > SLOW_PROJECT_READ_MS) log.info(`reading ${userText(basename(projectPath))} for the window took ${Math.round(ms)} ms: ${parts.map(([w, t]) => `${w} ${Math.round(t)} ms`).join(', ')}`)
    this.readAt.set(info, ticket)
    // Said only in the lifetime the read is for: a read begun before a close or a switch is another workspace's.
    if (info.platform && gen === this.generation && this.path) this.sayPlatform(projectPath, info.platform)
    return info
  }

  /** The offer each project's platform last had (lower-cased path → its reason, '' for none): each is said once, as it appears. */
  private platformOffers = new Map<string, string>()

  /**
   * Says what a project's platform (SPEC §16.3.5) has that the user should know, once while it lasts: detection, done at
   * each refresh, differs from the one recorded when its project.json was made (ensureProject), so a later difference
   * (git init, a repository gone) is offered and said, never switched to silently; or the recorded one is no platform.
   * A project from before platforms has none recorded until the 1.0 upgrade records it: it follows detection.
   */
  private sayPlatform(projectPath: string, p: ProjectPlatform): void {
    const key = projectPath.toLowerCase()
    const why = p.invalid !== undefined ? `invalid:${p.invalid}` : (p.offer?.why ?? '')
    const before = this.platformOffers.get(key) ?? ''
    if (before === why) return
    this.platformOffers.set(key, why)
    // Nothing to say now (switched, or the folder back as it was): the notice said before goes (HI-1905: a project
    // switched to Git right after Initialise repository… kept "Hive goes on treating it as … None").
    if (!why) {
      if (before) resolveOffer(`platform:${key}`, tr(M.platformSettled))
      return
    }
    if (p.invalid !== undefined) log.warn(`${userText(basename(projectPath))}'s project.json names no platform Combwork has (${userText(p.invalid)}): it uses ${p.id}, as detected`)
    else log.info(`${userText(basename(projectPath))} is a ${p.id} project; its folder now says ${p.detected.platform}${p.detected.other ? ` (${p.detected.other} found)` : ''}`)
    // An offer has its button to the tab that makes it (#1419); an unknown setting is fixed in project.json.
    const actions = p.offer ? [{ label: tr(M.openVc), command: 'project.openVersionControl', args: [projectPath] }] : undefined
    // One notice per project: a newer detection replaces the one before it rather than stacking (#1419).
    // Its offer (HI-2320) is the project's platform notice: settled, it says so and loses its button.
    const n = platformNotice(basename(projectPath), p)
    toast(p.invalid !== undefined ? 'warning' : 'info', n.title, n.message, actions, projectPath, { kind: 'project', projectPath, project: basename(projectPath) }, { id: `platform:${key}`, offer: `platform:${key}` })
  }

  /** Whether project.json was written after this read of it began (#999). */
  private readBeforeSave(info: ProjectInfo): boolean {
    return (this.savedAt.get(info.path.toLowerCase()) ?? 0) > (this.readAt.get(info) ?? 0)
  }

  /** Refreshes begun, and the latest one whose reading was reported (#731). */
  private refreshes = 0
  private refreshReported = 0

  async refresh(): Promise<WorkspaceInfo> {
    if (!this.path) throw hiveError(M.noWorkspace, undefined, { kind: 'conflict' })
    // Closing: its generation is already the next one's, so the lifetime says it (#1341).
    const life = this.life.signal
    if (life.aborted) throw hiveError(M.closed, undefined, { kind: 'conflict' })
    const gen = this.generation
    const seq = ++this.refreshes
    // Before the folders are listed: a project the listing misses was gone by then.
    const listed = ++this.rootTickets
    const projects: ProjectInfo[] = []
    // Closed or switched meanwhile: the new workspace's own refresh reports it. Each read is the refresh's lifetime's
    // (#784): one begun after a switch would otherwise record the old workspace's worktrees in the new one.
    const closed = (): boolean => gen !== this.generation || !this.path || life.aborted
    // What the projects' running agents' settings need of the workspace (its skills and servers), read once (#1002).
    const scope = {}
    // The projects and the Assistant's home read at once, in the listing's order (HI-1705: one after another, each read's
    // file and git calls queued behind other windows' work, an open took seconds under load).
    const paths = await this.listProjectPaths()
    if (closed()) throw hiveError(M.closed, undefined, { kind: 'conflict' })
    const [read, assistant] = await whenAll([
      whenAll(paths.map((p) => this.projectInfo(p, gen, scope))),
      this.projectInfo(this.assistantHome, gen, scope).catch((e) => (log.warn('the Assistant', e), null))
    ])
    projects.push(...read)
    if (closed()) throw hiveError(M.closed, undefined, { kind: 'conflict' })
    // A refresh begun after this one has reported already (#731): this one read the projects earlier, so what it found
    // is older and changes nothing (it put back an agent list from before a change, and said a shared name twice).
    if (seq < this.refreshReported && this.cached) return this.cached
    // A project's config was written after this refresh read it (#999: quick moves of agents, each awaiting a refresh
    // slowed by its running agents' settings): it found the config from before, and would report an agent order the
    // window has moved on from. The refresh the write scheduled reads it afresh.
    if (this.cached && [...projects, ...(assistant ? [assistant] : [])].some((p) => this.readBeforeSave(p))) return this.cached
    this.refreshReported = seq
    // Worktrees of projects that are gone (deleted, renamed) no longer belong to this workspace, nor do those a read begun
    // before the listing puts back (#784, registerRoots); a project read since (made again meanwhile) keeps what that
    // read found.
    const known = new Set(projects.map((p) => p.path.toLowerCase()))
    // The Assistant's home is read in every refresh too, after the listing.
    this.listedAt = { ticket: listed, known: assistant ? new Set([...known, this.assistantHome.toLowerCase()]) : known }
    for (const [k, v] of this.roots) if (!known.has(v.toLowerCase()) && (this.rootsAt.get(v.toLowerCase()) ?? 0) < listed) this.roots.delete(k)
    for (const [project, at] of this.rootsAt) if (!known.has(project) && at < listed) this.rootsAt.delete(project)
    for (const project of this.folderRoots.keys()) if (!known.has(project) && !this.rootsAt.has(project)) this.folderRoots.delete(project)
    for (const [project, at] of this.savedAt) if (!this.listedAt.known.has(project) && at < listed) this.savedAt.delete(project)
    // A project gone (HI-2564): a folder made again by that name later is a new one, set up as #1423 makes one.
    for (const [project, at] of this.setUpAt) if (!known.has(project) && at < listed) this.setUpAt.delete(project)
    for (const project of this.goneSaid) if (!known.has(project)) this.goneSaid.delete(project)
    for (const [project, w] of this.configWrites) if (!this.listedAt.known.has(project) && w.ticket < listed) this.forgetConfigWrites(project)
    // A project gone is said again if it comes back.
    for (const project of this.platformOffers.keys()) if (!known.has(project)) this.platformOffers.delete(project)
    this.cached = { path: this.path, name: basename(this.path), config: this.wsConfig, projects, assistant: assistant && { ...assistant, name: ASSISTANT_NAME, active: true, unmanagedMcp: [] }, moved: this.moved }
    this.emit({ type: 'workspace-changed', workspace: this.cached })
    this.flagDuplicateNames(projects)
    return this.cached
  }

  /**
   * Agent names two projects share, from before names were unique across the workspace (#702): they keep working, and
   * each is said once (workspace.json remembers it while it lasts), with a rename to make and a way into Agent Settings.
   */
  private flagDuplicateNames(projects: ProjectInfo[]): void {
    const all = projects.flatMap((p) => p.agents.map((a) => ({ project: p.name, path: p.path, name: a.name, id: a.id })))
    const dups = duplicateAgentNames(all)
    const now = dups.map((d) => d.name.toLowerCase()).sort()
    const before = this.wsConfig.flaggedAgentNames ?? []
    if (now.length === before.length && now.every((n, i) => n === before[i])) return
    // In memory at once, so a refresh close behind this one doesn't say them again.
    if (now.length) this.wsConfig.flaggedAgentNames = now
    else delete this.wsConfig.flaggedAgentNames
    void this.saveWorkspaceConfig().catch((e) => log.warn('remembering the shared agent names', e))
    // No name shared any more: the notice's Rename… no longer applies (HI-2320).
    if (!now.length) resolveOffers((o) => o === `names:${this.path?.toLowerCase()}`, tr(OUTCOME.namesDiffer))
    const fresh = dups.filter((d) => !before.includes(d.name.toLowerCase()))
    if (!fresh.length) return
    // The one to rename: the last project's, alphabetically, given its own project's prefix.
    const first = fresh[0].agents[fresh[0].agents.length - 1] as (typeof all)[number]
    const suggestion = suggestAgentName(first.name, first.project, all.map((a) => a.name))
    // The window's notice (never sent to agents), in its language.
    const shared = fmt.list(fresh.map((d) => tr(msg({ id: 'service.workspace.nameIn', defaultMessage: '{name} is in {projects}', description: 'Part of the notice that agents of several projects share a name: {name} is the name, {projects} the projects (a list, in the language\'s way: "alpha and beta").' }), { name: d.name, projects: fmt.list(d.agents.map((a) => a.project)) })), 'unit')
    const message = tr(msg({ id: 'service.workspace.sharedNames', defaultMessage: "Agent names are unique across the workspace now, so each agent can be told apart. {shared}: they keep working, but rename one of each, e.g. {project}'s {agent} to {suggestion}.", description: "A notice: agents of several projects share names from before names were unique. {shared} says which (\"R1 is in alpha and beta\"); {suggestion} is a free name for the agent {agent} of the project {project}." }), { shared, project: first.project, agent: first.name, suggestion })
    const title = fresh.length === 1 ? tr(msg({ id: 'service.workspace.twoCalled', defaultMessage: 'Two agents are called {name}', description: "A notice's title: agents of two projects share the name {name}." }), { name: fresh[0].name }) : tr(msg({ id: 'service.workspace.namesShared', defaultMessage: 'Agents share names', description: "A notice's title: agents of several projects share names." }))
    const label = tr(msg({ id: 'service.workspace.renameAgent', defaultMessage: "Rename {project}'s {agent}…", description: "The notice's button: opens the settings of the agent {agent} of the project {project}, to rename it." }), { project: first.project, agent: first.name })
    toast('warning', title, message, [{ label, command: 'agent.settings', args: [first.path, first.id] }], first.path, { kind: 'agent', projectPath: first.path, agentId: first.id, name: first.name, project: first.project }, { offer: `names:${this.path?.toLowerCase()}` })
  }

  info(): WorkspaceInfo | null {
    return this.cached
  }

  /** Whether it moved with something left to repair (#146); the window hears of a change with the next refresh. */
  setMoved(moved: WorkspaceMoved | null): void {
    if (JSON.stringify(moved) === JSON.stringify(this.moved)) return
    this.moved = moved
    if (this.path) void this.refresh().catch(() => undefined)
  }

  async createProject(name: string): Promise<WorkspaceInfo> {
    if (!this.path) throw hiveError(M.noWorkspace, undefined, { kind: 'conflict' })
    const clean = name.trim()
    if (!clean || /[<>:"/\\|?*\x00-\x1f]/.test(clean) || clean.startsWith('.') || /[. ]$/.test(clean)) {
      throw hiveError(msg({ id: 'service.workspace.badName', defaultMessage: 'Project names cannot start with "." or contain {chars}', description: "An error making a project: a project's name (its folder's) can't start with a dot or hold the characters {chars}, which Windows doesn't allow in a folder's name." }), { chars: '< > : " / \\ | ? *' }, { kind: 'invalid' })
    }
    const p = join(this.path, clean)
    if (existsSync(p)) throw hiveError(msg({ id: 'service.workspace.folderExists', defaultMessage: 'A folder named "{name}" already exists', description: 'An error making a project: the workspace already has a folder called {name}.' }), { name: clean })
    // The workspace it is made in: after each wait, still the one open (HR5, HI-1760 round 1). These calls act on what
    // the service has open then, so a close, or another workspace opened meanwhile (the same one again too), would have
    // them read and answer with that one's projects: refused as closed instead.
    const gen = this.generation
    const life = this.life.signal
    const still = (): void => {
      if (gen !== this.generation || life.aborted) throw hiveError(M.closed, undefined, { kind: 'conflict' })
    }
    await mkdir(p)
    await this.ensureProject(p)
    still()
    // Its id given before the refresh reads it (HI-1760): given during that read (the refresh's sessions place asks for
    // ids), its project.json counts as saved after the read, and the refresh returns the list from before, without it.
    await this.projectIds({ fresh: true })
    still()
    const info = await this.refresh()
    still()
    if (this.hasProject(info, p)) return info
    // Another write meanwhile made it hand back the list from before: the refresh that write scheduled reads it afresh.
    await this.refreshesSettled()
    still()
    if (this.cached && this.hasProject(this.cached, p)) return this.cached
    const again = await this.refresh()
    still()
    return again
  }

  private hasProject(info: WorkspaceInfo, projectPath: string): boolean {
    return info.projects.some((x) => samePlace(x.path, projectPath))
  }

  /** True if the path is inside the open workspace, its worktrees or extraRoots — used to guard file IPC. */
  isAllowedPath(p: string, extraRoots: string[] = []): boolean {
    const roots = [this.path, this.path ? worktreesRoot(this.path) : null, ...this.roots.keys(), ...extraRoots].filter((r): r is string => !!r)
    // By its real location too, so a link inside the workspace can't reach files outside it.
    return insideReal(p, roots)
  }
}

/** Where Remove from Hive packs a project's workspace files, inside its own folder. */
export const REMOVED_DIR = 'removed'

/** What Remove from Hive packed into a project folder, if anything (its manifest). */
async function removedData(projectPath: string): Promise<RemovedData | null> {
  const file = join(projectPath, CW_DIR, REMOVED_DIR, 'manifest.json')
  if (!existsSync(file)) return null
  const m = await readJson<Partial<RemovedData> | null>(file, null)
  if (!m || typeof m.at !== 'string') return null
  return { at: m.at, workspace: String(m.workspace ?? ''), handovers: Number(m.handovers) || 0, cards: Number(m.cards) || 0 }
}

// ---------------------------------------------------------------------------
// Several windows, each with its own workspace. The rest of Hive imports `workspace`, which stands for
// the workspace the current work is for: the calling window's (IPC), an Agent API request's, or the one
// owning the project path a call names.
// ---------------------------------------------------------------------------

const services = new Set<WorkspaceService>()
/** Workspaces being opened, one at a time (see open()). */
let admission: Promise<void> = Promise.resolve()
const context = new AsyncLocalStorage<WorkspaceService>()
let fallback: () => WorkspaceService | null = () => null

/** A new, empty workspace service (for a new window). */
export function createWorkspaceService(): WorkspaceService {
  const w = new WorkspaceService()
  services.add(w)
  return w
}

/** A promise to wait on until `done()` (at once when `open` is true); done more than once is harmless. */
function gate(open = false): { promise: Promise<void>; done: () => void } {
  let done = (): void => {}
  const promise = open ? Promise.resolve() : new Promise<void>((r) => (done = r))
  return { promise, done: () => done() }
}

/** Closes a window's workspace and forgets its service. */
export async function disposeWorkspaceService(w: WorkspaceService): Promise<void> {
  await w.close()
  services.delete(w)
}

/**
 * What a new workspace's workspace.json gets beyond the defaults (HI-980: its accounts, from accounts.ts), once ready
 * (HI-1875: after the connections' one-time order move, so it is never seeded from the order before it).
 */
let newWorkspaceExtras: () => Promise<Partial<WorkspaceConfig>> = async () => ({})
export function setNewWorkspaceExtras(fn: () => Promise<Partial<WorkspaceConfig>>): void {
  newWorkspaceExtras = fn
}
/** A new workspace's settings: the defaults and those extras (only when it is made, never when one is opened). */
const newWorkspaceConfig = async (): Promise<WorkspaceConfig> => ({ ...structuredClone(DEFAULT_WORKSPACE_CONFIG), ...(await newWorkspaceExtras()) })

/** Runs fn with `workspace` standing for w. */
export function inWorkspace<T>(w: WorkspaceService, fn: () => T): T {
  return context.run(w, fn)
}

/** The workspace set for the current work by inWorkspace (a window's request, an API request), if any. */
export function contextWorkspace(): WorkspaceService | undefined {
  return context.getStore()
}

/** The workspace used when no window, request or path says which (the last focused window's). */
export function setWorkspaceFallback(fn: () => WorkspaceService | null): void {
  fallback = fn
}

/** The workspaces open in windows. */
export function openWorkspaces(): WorkspaceService[] {
  return [...services].filter((w) => !!w.path)
}

/** The open workspace a folder or file belongs to: a project, a file in one, or an agent's worktree. */
export function workspaceFor(p: string): WorkspaceService | null {
  const abs = resolve(p).toLowerCase()
  for (const w of services) {
    if (!w.path) continue
    const root = w.path.toLowerCase()
    if (abs === root || abs.startsWith(root + sep)) return w
    const wt = worktreesRoot(w.path).toLowerCase()
    if (abs === wt || abs.startsWith(wt + sep) || w.ownsRoot(abs)) return w
  }
  return null
}

let warned = false
/** The workspace the current work is for. */
export function currentWorkspace(): WorkspaceService {
  const inCtx = context.getStore()
  if (inCtx) return inCtx
  const open = openWorkspaces()
  if (open.length === 1) return open[0]
  if (services.size === 1) return [...services][0]
  const f = fallback()
  if (open.length > 1 && !warned) {
    warned = true
    log.warn('A workspace was used without saying which; using the last focused window\'s', new Error('no workspace context').stack)
  }
  return f ?? open[0] ?? [...services][0] ?? createWorkspaceService()
}

/** The workspace owning a project (or worktree) path, else the current one. */
export function workspaceOf(p: string): WorkspaceService {
  return workspaceFor(p) ?? currentWorkspace()
}

/** Methods whose first argument is a project or worktree path: they go to the workspace owning it. */
const BY_PATH = new Set<string>([
  'isProjectPath', 'assertProject', 'assertRoot', 'assertChangesRoot', 'noteUnusedWorktrees', 'projectForRoot', 'updateAgent', 'updateLegacyAgent', 'ensureProject', 'ensureGitExclude', 'branch',
  'projectConfig', 'updateProjectConfig', 'mutateProjectConfig', 'sessionsFile', 'sessionScope', 'mutateSessions', 'upsertSession', 'setActive',
  'unmanagedMcp', 'projectInfo', 'isAssistantHome', 'assertSessionHost'
])

export const workspace: WorkspaceService = new Proxy({} as WorkspaceService, {
  get(_t, key: string) {
    // Any open workspace's files may be read (combwork-img:, file IPC) — each window only shows its own.
    if (key === 'isAllowedPath') return (p: string, extra?: string[]) => [...services].some((w) => w.isAllowedPath(p, extra))
    if (BY_PATH.has(key)) {
      return (p: string, ...rest: unknown[]) => {
        const w = workspaceFor(p) ?? currentWorkspace()
        return (w as unknown as Record<string, (...a: unknown[]) => unknown>)[key](p, ...rest)
      }
    }
    const w = currentWorkspace()
    const v = (w as unknown as Record<string, unknown>)[key]
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(w) : v
  },
  set(_t, key: string, value) {
    ;(currentWorkspace() as unknown as Record<string, unknown>)[key] = value
    return true
  }
})
