import { randomBytes, randomUUID } from 'crypto'
import { basename, dirname, join, resolve, sep } from 'path'
import { mkdir, readdir, readFile, stat, writeFile } from 'original-fs/promises'
import { existsSync, statSync, watch, type FSWatcher as RootWatcher } from 'original-fs'
import { closeBoard, keepBoard, letGoBoard } from './boardStore'
import { closeJournal } from './journal'
import { AsyncLocalStorage } from 'async_hooks'
import type { BrowserWindow } from 'electron'
import chokidar, { type FSWatcher } from 'chokidar'
import { ASSISTANT_DIR, ASSISTANT_NAME, LEGACY_MODES_DIR, MODES_DIR, assistantProjectConfig } from '../shared/assistant'
import { DEFAULT_PROJECT_CONFIG, DEFAULT_WORKSPACE_CONFIG, HIVE_DIR, mergeDefaults, migrateProjectConfig, projectAgents, withLegacyProjectFields, withoutSkillSwitches } from '../shared/defaults'
import { settlePlacements } from '../shared/paneCells'
import { migratedProjectMcp, migratedWorkspaceMcp } from '../shared/agentMcp'
import { LANE_MAX_ROUNDS, LOOP_WAIT_MAX_HOURS } from '../shared/lanes'
import { advancedDef, checkAdvanced } from '../shared/advanced'
import { fmt, msg, tr } from '../shared/i18n'
import { HiveError, hiveError } from './hiveError'
import type { AgentDef, AgentInfo, HiddenProject, HiveEvent, KeptUsage, LiveSessionState, ProjectConfig, ProjectInfo, RemovedData, SessionRecord, WorkspaceConfig, WorkspaceInfo, WorkspaceMoved } from '../shared/types'
import { config } from './config'
import { emit, emitTo } from './events'
import { containsPlace, insideReal, isDir, readJson, readKeptJson, removePath, samePlace, withFileLock, writeKeptJson } from './fsutil'
import { markClosed, markOpen, setFenceReason } from './openingFence'
import { createLogger, userText } from './logger'
import { changeSessions, exportSessions, readSession, readSessions, releaseSessions, type SessionsPlace } from './sessionStore'
import { allProviders } from './providers'
import { worktreesRoot } from './worktrees'
import { ensureHiveExcluded, gitDirOf, hiveVcs } from './hiveVcs'
import { detect, projectPlatform } from './platform/registry'
import type { ProjectPlatform } from '../shared/platform/descriptors'
import { gitProblem } from './gitTool'
import { duplicateAgentNames, suggestAgentName } from '../shared/agentNames'
import { NO_PROJECT_IDS, isProjectId, settleProjectIds, type ProjectIdEntry, type ProjectIdIndex } from '../shared/projectIds'

const log = createLogger('workspace')
/** What the board keeps in .hive (#1017): its database and the files beside it, the cards' old folders, backups and the deleted cards' staging. */
const BOARD_FILES = /^(hive\.db(-wal|-shm|-journal)?|tasks|tasks\..+|backups|deleted-cards)$/
/** How often a workspace root whose folder went is tried again (#964). */
const ROOT_WATCH_RETRY_MS = 3000
/** The workspace's refusals and its notice, in the window's language (#850); agents (the Agent API) read their English. */
const M = {
  noWorkspace: msg({ id: 'service.workspace.none', defaultMessage: 'No workspace is open', description: 'An error: the action needs a workspace, and none is open in this window.' }),
  closed: msg({ id: 'service.workspace.closed', defaultMessage: 'The workspace was closed', description: 'An error: the workspace was closed (or the window opened another) while the action was under way.' }),
  platformTitle: msg({ id: 'service.workspace.platformTitle', defaultMessage: 'Version control changed in {project}', description: "A notice's title: the version control found in the project {project}'s folder is no longer the one Hive recorded for it." }),
  gitFound: msg({ id: 'service.workspace.platformGitFound', defaultMessage: '{project} is a Git repository now. Hive goes on treating it as a project without version control: Hive never switches it by itself.', description: 'A notice: someone ran git init in a project Hive treats as having no version control. Hive does not switch it.' }),
  repositoryGone: msg({ id: 'service.workspace.platformRepositoryGone', defaultMessage: "{project}'s Git repository is gone. Hive goes on treating it as a Git project, so what needs Git can't be read until the repository is back.", description: "A notice: the .git folder of a project Hive treats as a Git project was removed or moved. Hive doesn't switch it." }),
  platformInvalidTitle: msg({ id: 'service.workspace.platformInvalidTitle', defaultMessage: 'Unknown version control setting in {project}', description: "A notice's title: the project {project}'s settings file names a version control Hive doesn't have." }),
  platformInvalid: msg({ id: 'service.workspace.platformInvalid', defaultMessage: "{project}'s project.json names a version control Hive doesn't know (platform: {value}). Until it says \"git\" or \"none\", Hive uses what it finds in the folder.", description: 'A notice: the platform setting in the project {project}\'s .hive/project.json is {value}, which is not one Hive has (only "git" and "none" are: keep them as they are, they are setting values).' }),
  otherFound: msg({ id: 'service.workspace.platformOtherFound', defaultMessage: "{vcs} was found in {project}. Hive doesn't support it yet, so it goes on treating the project as a Git project.", description: 'A notice: another version control system ({vcs}: Mercurial, Jujutsu…) was found in a project Hive treats as a Git project. Hive does not switch it.' })
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

// i18n-ignore: the .hive folder's README, a file committed with the workspace
const WORKSPACE_README = `# .hive

This folder is managed by [Hive](https://github.com/) and is meant to be committed.

- \`shared/\` — notes, instructions and handovers shared across AI sessions and projects.
- \`skills/\` — Hive skills (one folder per skill, each with a \`SKILL.md\`). Every agent in every project gets them.
- \`mcp/\` — MCP server definitions (one \`<name>.json\` per server). Enable them in Hive.
- \`workspace.json\` — which MCP servers are on in the workspace (each runs only in the projects that turn it on too).
- \`hive.db\` — the task board (Hive's database). It is this machine's, like the Assistant's sessions: \`.gitignore\` keeps it out of git.
- \`usage.db\` — what each session used (the usage history the Overviews read). It is this machine's too, kept out of git.

MCP definitions must not contain secrets. Reference environment variables instead, e.g. \`"\${GITHUB_TOKEN}"\`.
`

/** The usage history's lines of BOARD_GITIGNORE (#1106), added to the .gitignore Hive wrote before them. */
const USAGE_IGNORE = '# What each session used: the usage history (#1106)\nusage.db\nusage.db-*\n' // i18n-ignore: the .hive folder's .gitignore, a file committed with the workspace

/** Adds the usage history's lines to the .gitignore Hive wrote (only its own: one the user wrote is theirs). */
async function addUsageIgnore(file: string): Promise<void> {
  const text = await readFile(file, 'utf8').catch(() => null)
  if (text === null || !text.startsWith(BOARD_GITIGNORE.split('\n')[0]) || /^usage\.db\r?$/m.test(text)) return
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  await writeFile(file, `${text}${text.endsWith('\n') ? '' : nl}${USAGE_IGNORE.replace(/\n/g, nl)}`).catch(() => undefined)
}

// i18n-ignore: the .hive folder's .gitignore, a file committed with the workspace
const BOARD_GITIGNORE = `# The task board's database and what moving it from files left (added by Hive, #1017)
hive.db
hive.db-*
backups/
tasks.imported-*/
tasks.set-aside/
deleted-cards/
# What each session used: the usage history (#1106)
usage.db
usage.db-*
`

// i18n-ignore: the handovers folder's README, a file committed with the workspace
const HANDOVER_README = `# Handovers

Notes written at the end of a session so the next session (or another project) can pick up where it left off.
Agents can create these with the Hive MCP tool \`hive_create_handover\`.
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
type LiveProvider = (projectPath: string, cfg: ProjectConfig, scope?: object) => Promise<{ live: LiveSessionState | null; restartNeeded: boolean; agents: AgentInfo[] }>

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

export class WorkspaceService {
  path: string | null = null
  private wsConfig: WorkspaceConfig = structuredClone(DEFAULT_WORKSPACE_CONFIG)
  private watcher: FSWatcher | null = null
  private rootWatcher: RootWatcher | null = null
  private refreshTimer: NodeJS.Timeout | null = null
  /** The refresh scheduleRefresh has waiting, told once it has run (or was dropped): refreshesSettled waits for it. */
  private scheduled: { done: Promise<void>; tell: () => void } | null = null
  /** Scheduled refreshes running now, until each has finished (refreshesSettled waits for them too, #1143 round 2). */
  private scheduledRuns = new Set<Promise<void>>()
  private static liveProvider: LiveProvider = async (_p, cfg) => ({ live: null, restartNeeded: false, agents: projectAgents(cfg).map((a) => ({ ...a, live: null, restartNeeded: false, resume: null })) })
  /** Called each time a workspace opens, in its context; `fresh` when Hive set the folder up just now (it had no .hive). */
  static onOpened: ((fresh: boolean) => Promise<unknown>) | null = null
  /** Each read of the projects' ids (#514): the workspace's record of their names follows it (projectNames.ts). Never awaited. */
  static onIdsRead: ((ws: WorkspaceService, seen: ProjectSeen[]) => void) | null = null
  /** Told when a workspace starts closing (its path still set), so services drop what they keep for it. */
  static readonly closingListeners = new Set<(path: string) => void>()
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
  /**
   * Each project's latest project.json write (lower-cased project → its ticket), and the ticket each ProjectInfo was read
   * at (#999): a refresh that read a project before a later write found the config from before, e.g. an agent order two
   * moves back.
   */
  private savedAt = new Map<string, number>()
  private readAt = new WeakMap<ProjectInfo, number>()
  /** The projects the last refresh reported (lower-cased) and its listing's ticket: one missing was gone by then (#784). */
  private listedAt: { ticket: number; known: Set<string> } | null = null
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
  /** Moved since last opened, with something to repair (#146, workspaceMove.ts); the window's banner offers Repair…. */
  private moved: WorkspaceMoved | null = null
  /** The projects' ids (#508) as last read, for the folder list they were read for (`key`), and a read under way. */
  /**
   * Where the workspace was before it moved here (#146: workspace.json's lastPath as it opened), or null: records saved
   * there by path (card watches, merge holds, #508) come to their folders here by it. Repair updating lastPath meanwhile
   * doesn't change it.
   */
  movedFrom: string | null = null
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
  private idsRead: { key: string; run: Promise<ProjectIdIndex> } | null = null

  setLiveProvider(p: LiveProvider): void {
    WorkspaceService.liveProvider = p
  }

  /** Aborted when this workspace closes (or the window opens another): work for it stops, and what it kept goes. */
  get lifetime(): AbortSignal {
    return this.life.signal
  }

  get hiveDir(): string {
    if (!this.path) throw hiveError(M.noWorkspace, undefined, { kind: 'conflict' })
    return join(this.path, HIVE_DIR)
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

  async open(path: string): Promise<WorkspaceInfo> {
    const abs = resolve(path)
    if (!(await isDir(abs))) throw hiveError(msg({ id: 'service.workspace.notFound', defaultMessage: 'Folder not found: {folder}', description: 'An error opening a workspace: the folder {folder} is not there.' }), { folder: abs })
    // One workspace inside another would make its projects belong to both. Windows claim their folders one
    // at a time, so two opening at once can't both pass the check before either has claimed its own.
    const admit = admission.then(async () => {
      // By real paths: the same folder by another name (an 8.3 short name, a junction) is the same workspace (#455).
      for (const w of services) {
        if (w === this || !w.path) continue
        if (samePlace(abs, w.path)) throw hiveError(msg({ id: 'service.workspace.openElsewhere', defaultMessage: '{folder} is already open in another window.', description: 'An error opening a workspace: the folder {folder} is the workspace of another Hive window.' }), { folder: abs }, { kind: 'conflict' })
        if (containsPlace(w.path, abs)) throw hiveError(msg({ id: 'service.workspace.insideOpen', defaultMessage: "{folder} is inside the workspace {workspace}, which is open in another window. Close that workspace first, or open this folder's projects from there.", description: 'An error opening a workspace: the folder {folder} is inside {workspace}, the workspace of another Hive window (a workspace inside another would share its projects).' }), { folder: abs, workspace: w.path }, { kind: 'conflict' })
        if (containsPlace(abs, w.path)) throw hiveError(msg({ id: 'service.workspace.holdsOpen', defaultMessage: 'The workspace {workspace}, open in another window, is inside {folder}. Close it first to open {name} as a workspace.', description: "An error opening a workspace: another Hive window's workspace {workspace} is inside the folder {folder} (its name: {name})." }), { folder: abs, workspace: w.path, name: basename(abs) }, { kind: 'conflict' })
      }
      await this.close()
      this.generation++
      this.path = abs
      markOpen(abs)
      // A save's lease doesn't close the database now it is this window's, opened before or after (#1383).
      keepBoard(abs)
    })
    admission = admit.catch(() => undefined)
    await admit
    const fresh = !existsSync(join(abs, HIVE_DIR))
    await this.ensureWorkspaceStructure()
    this.wsConfig = mergeDefaults(structuredClone(DEFAULT_WORKSPACE_CONFIG), withoutSkillSwitches(await readKeptJson(join(this.hiveDir, 'workspace.json'), {})))
    const last = this.wsConfig.lastPath
    this.movedFrom = last && resolve(last).toLowerCase() !== abs.toLowerCase() ? resolve(last) : null
    config.update((c) => {
      c.lastWorkspace = abs
      c.recentWorkspaces = [abs, ...c.recentWorkspaces.filter((p) => p.toLowerCase() !== abs.toLowerCase())].slice(0, 12)
      c.activeProjects[abs] ??= []
    })
    // Every window's recent list: this one first, and open here (#144).
    emit({ type: 'recent-changed' })
    for (const p of await this.listProjectPaths()) await this.ensureProject(p).catch((e) => log.warn(`ensureProject ${userText(p)}`, e))
    // Every project has its id (#508) before the board, lanes and watches are read by it.
    await this.projectIds().catch((e) => log.warn('reading the project ids', e))
    // Before any session starts with them: MCP settings from before #1093 move to its model.
    await this.migrateMcpModel().catch((e) => log.warn('moving the MCP settings to the workspace and project switches', e))
    try {
      await this.ensureProject(this.assistantHome)
      // The Assistant's conversations and backups are this machine's: kept out of git if the workspace is a repository.
      const ignore = join(this.assistantHome, '.gitignore')
      if (!existsSync(ignore)) await writeFile(ignore, "# Hive Assistant: this machine's sessions (added by Hive)\n*\n")
    } catch (e) {
      log.warn('setting up the Assistant', e)
    }
    await inWorkspace(this, async () => WorkspaceService.onOpened?.(fresh)).catch((e) => log.warn('opening the workspace', e))
    this.startWatching()
    log.info(`Opened workspace ${userText(abs)}`)
    return this.refresh()
  }

  async close(): Promise<void> {
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
    // First: from here, nothing opens its databases again until a window opens it again (#1379), whoever asks.
    if (closing) markClosed(closing)
    if (closing) {
      for (const l of WorkspaceService.closingListeners) {
        try {
          l(closing)
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
    if (closing) letGoBoard(closing)
    if (closing) closeBoard(closing)
    if (closing) closeJournal(join(closing, HIVE_DIR, ASSISTANT_DIR))
    await this.watcher?.close()
    this.watcher = null
    this.path = null
    this.cached = null
    this.moved = null
    this.movedFrom = null
    this.ids = null
    this.idsRead = null
    this.lastAt.clear()
    // The closed workspace's agent worktrees and settings must not route to (or be allowed by) the next one.
    this.roots.clear()
    this.rootsAt.clear()
    this.savedAt.clear()
    this.listedAt = null
    this.unusedRoots.clear()
    this.wsConfig = structuredClone(DEFAULT_WORKSPACE_CONFIG)
    // A new lifetime only once it is fully closed: work started while it was closing (its path still set) belongs to the
    // aborted one, so nothing can be admitted for a workspace that is going away.
    this.life = new AbortController()
  }

  private async ensureWorkspaceStructure(): Promise<void> {
    const h = this.hiveDir
    for (const d of [h, join(h, 'shared'), join(h, 'shared', 'handovers'), join(h, 'skills'), join(h, 'mcp'), join(h, 'tasks')]) {
      await mkdir(d, { recursive: true })
    }
    if (!existsSync(join(h, 'workspace.json'))) await writeKeptJson(join(h, 'workspace.json'), DEFAULT_WORKSPACE_CONFIG)
    if (!existsSync(join(h, 'README.md'))) await writeFile(join(h, 'README.md'), WORKSPACE_README)
    // The board's database and what its move from files left (#1017) are this machine's: kept out of git if the workspace is a repository.
    if (!existsSync(join(h, '.gitignore'))) await writeFile(join(h, '.gitignore'), BOARD_GITIGNORE)
    else await addUsageIgnore(join(h, '.gitignore'))
    const hr = join(h, 'shared', 'handovers', 'README.md')
    if (!existsSync(hr)) await writeFile(hr, HANDOVER_README)
  }

  /** workspace.json saves, one after another, so an older one can't land after a newer one. */
  private savingConfig: Promise<void> = Promise.resolve()

  saveWorkspaceConfig(): Promise<void> {
    // This workspace's file and settings object (another workspace opened meanwhile has its own).
    const file = join(this.hiveDir, 'workspace.json')
    const data = this.wsConfig
    this.configSaves++
    const run = this.savingConfig.then(() => writeKeptJson(file, data)).finally(() => {
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
        await writeKeptJson(file, next)
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

  private startWatching(): void {
    if (!this.path) return
    // Watch only the workspace root (projects appearing/disappearing) and the .hive folder. The root is watched without
    // listing or stat-ing what is in it: chokidar stats every entry it lists through Electron's fs, which opens and holds
    // an .asar file (#246). A folder appearing, going or renamed there reads the project list again (a project's own
    // folder changing reports 'change').
    this.watchRoot()
    const assistantHome = this.assistantHome.toLowerCase()
    const mcpDir = this.mcpDir.toLowerCase() + sep
    const hiveDir = this.hiveDir.toLowerCase() + sep
    this.watcher = chokidar.watch(this.hiveDir, {
      depth: 5,
      ignoreInitial: true,
      // The Assistant's home changes with every launch; nothing in it is shown from the file system. In .hive/mcp only
      // the definitions (<name>.json) are: a server's own folder (added from a .zip, #550) isn't watched, since a watched
      // folder inside it would stop Windows moving the folder (Replace, Delete). The board is in its database (#1017),
      // told by Hive's own writes: neither the database's files nor the cards' old folders and backups are watched.
      ignored: (p: string) => {
        const at = resolve(p).toLowerCase()
        const top = at.startsWith(hiveDir) ? at.slice(hiveDir.length).split(sep)[0] : ''
        return at === assistantHome || BOARD_FILES.test(top) || (at.startsWith(mcpDir) && (at.slice(mcpDir.length).includes(sep) || !at.endsWith('.json')))
      }
    })
    this.watcher.on('all', (evt, p) => {
      const rel = this.path ? p.slice(this.path.length + 1).replace(/\\/g, '/') : ''
      if (rel.startsWith(`${HIVE_DIR}/shared`)) this.emit({ type: 'notes-changed' })
      else if (rel.startsWith(`${HIVE_DIR}/skills`) || rel.startsWith(`${HIVE_DIR}/mcp`)) this.emit({ type: 'skills-changed' })
      else if (rel.startsWith(`${HIVE_DIR}/${MODES_DIR}`) || rel.startsWith(`${HIVE_DIR}/${LEGACY_MODES_DIR}`)) this.emit({ type: 'modes-changed' })
      else if (rel === `${HIVE_DIR}/workspace.json`) void this.reloadConfig()
    })
    this.watcher.on('error', (e) => log.warn('watcher error', e))
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
    const paths = [...(await this.listProjectPaths()), ...(await this.listProjectPaths({ hidden: true }))]
    const configs = await Promise.all(paths.map((p) => this.projectConfig(p).then((c) => c.mcp, () => null)))
    for (const [i, p] of paths.entries()) {
      const was = configs[i]
      if (!was) continue
      const now = migratedProjectMcp(allProjects, was)
      if (JSON.stringify(now) !== JSON.stringify(was.enabled)) await this.mutateProjectConfig(p, (c) => ({ mcp: { ...c.mcp, enabled: migratedProjectMcp(allProjects, c.mcp) } }))
    }
    const enabled = migratedWorkspaceMcp(allProjects, configs)
    await this.saveWorkspaceConfigWith(() => ({ mcp: { enabled, model: 2 } }))
    for (const [i, p] of paths.entries()) {
      if (configs[i]?.disabled?.length) await this.mutateProjectConfig(p, (c) => ({ mcp: { ...c.mcp, disabled: [] } })).catch((e) => log.warn(`emptying the old MCP list of ${userText(p)}`, e))
    }
    log.info(`MCP settings moved to the workspace and project switches (#1093): ${enabled.length} on in the workspace`)
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
    this.wsConfig = mergeDefaults(structuredClone(DEFAULT_WORKSPACE_CONFIG), withoutSkillSwitches(await readKeptJson(file, {})))
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
      const run = (this.path ? this.refresh().then(() => undefined, (e) => log.warn('refresh failed', e)) : Promise.resolve()).finally(() => {
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
    const paths = [...(await this.listProjectPaths()), ...(await this.listProjectPaths({ hidden: true }))]
    // Each folder with its project.json's identity and time: a folder replaced by another of the same name, or two
    // projects that swapped names, read again too.
    const key = (
      await Promise.all(
        paths.map(async (p) => {
          const st = await stat(join(p, HIVE_DIR, 'project.json')).catch(() => null)
          return `${p.toLowerCase()}:${st ? `${st.ino}:${st.mtimeMs}` : '-'}`
        })
      )
    )
      .sort()
      .join('|')
    if (this.ids?.key === key) {
      this.ids.at = Date.now()
      return this.ids
    }
    if (this.idsRead?.key === key) return this.idsRead.run
    const run = this.readProjectIds(paths, key).finally(() => {
      if (this.idsRead?.run === run) this.idsRead = null
    })
    this.idsRead = { key, run }
    return run
  }

  /** The projects' ids as last read (projectIds), for code that can't wait: a folder not read yet has none. */
  projectIdsNow(): ProjectIdIndex {
    return this.ids ?? NO_PROJECT_IDS
  }

  private async readProjectIds(paths: string[], key: string): Promise<ProjectIdIndex> {
    const gen = this.generation
    const entries: ProjectIdEntry[] = []
    const cfgs = new Map<string, ProjectConfig>()
    for (const p of paths) {
      if (!existsSync(join(p, HIVE_DIR, 'project.json'))) continue
      const cfg = await this.projectConfig(p).catch(() => null)
      if (!cfg) continue
      entries.push({ path: p, id: cfg.id, lastPath: cfg.lastPath })
      cfgs.set(p.toLowerCase(), cfg)
    }
    const { keep, fresh } = settleProjectIds(entries)
    for (const p of fresh) {
      if (gen !== this.generation) break
      // In project.json's lock, against the file as it is then: an id of its own given meanwhile stays.
      const taken = new Set(keep.values())
      const cfg = await this.mutateProjectConfig(p, (c) => (isProjectId(c.id) && !taken.has(c.id) ? {} : { id: `p-${randomBytes(6).toString('hex')}` })).catch((e) => {
        log.warn(`giving ${userText(basename(p))} its project id`, e)
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

  /**
   * Sets the workspace's card-loop rounds and wait in hours (#412, Settings → Workspace): a value given replaces its own,
   * one left out stays. Saved in workspace.json; the window hears of it as a workspace change.
   */
  async setLoops(patch: { rounds?: number; waitHours?: number }): Promise<void> {
    if (!this.path) throw hiveError(M.noWorkspace, undefined, { kind: 'conflict' })
    const whole = (v: unknown, max: number): boolean => v === undefined || (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= max)
    if (!whole(patch.rounds, LANE_MAX_ROUNDS)) throw hiveError(msg({ id: 'service.workspace.loopRounds', defaultMessage: 'Card loop rounds take a whole number from 1 to {max}.', description: "An error in Settings → Workspace: a card loop's rounds (how many reviews a card gets before the user is asked) must be a whole number from 1 to {max}." }), { max: LANE_MAX_ROUNDS })
    if (!whole(patch.waitHours, LOOP_WAIT_MAX_HOURS)) throw hiveError(msg({ id: 'service.workspace.loopWait', defaultMessage: 'Card loop wait takes a whole number of hours from 1 to {max}.', description: "An error in Settings → Workspace: a card loop's wait (hours with no change before the user is told) must be a whole number from 1 to {max}." }), { max: LOOP_WAIT_MAX_HOURS })
    this.wsConfig.loops = { ...this.wsConfig.loops, ...(patch.rounds !== undefined ? { rounds: patch.rounds } : {}), ...(patch.waitHours !== undefined ? { waitHours: patch.waitHours } : {}) }
    await this.saveWorkspaceConfig()
    this.scheduleRefresh()
  }

  /** Sets the workspace's own value of an advanced setting a workspace can set (#367), or removes it (null: Hive's again). */
  async setAdvanced(id: string, raw: unknown): Promise<void> {
    if (!this.path) throw hiveError(M.noWorkspace, undefined, { kind: 'conflict' })
    const def = advancedDef(id)
    if (!def?.workspace) throw hiveError(msg({ id: 'service.workspace.advancedNotHere', defaultMessage: "{setting} can't be set for a workspace.", description: 'An error: the advanced setting {setting} (its title, or its id) has no value of its own for a workspace, only for Hive.' }), { setting: def?.text.title ?? id })
    const own = { ...this.wsConfig.advanced }
    if (raw === null || raw === undefined) delete own[id]
    else {
      const checked = checkAdvanced(def, raw)
      if ('error' in checked) throw new HiveError(checked.errorText)
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

  /** The project a worktree belongs to, or the project itself. */
  projectForRoot(p: string): string | null {
    if (this.isProjectPath(p)) return resolve(p)
    return this.roots.get(resolve(p).toLowerCase()) ?? null
  }

  /**
   * Records a project's agent worktrees, from a config read or written in generation `gen` (none once the workspace has
   * closed or switched since) with `ticket` (none when a later read or write has recorded them already, #784).
   */
  private registerRoots(projectPath: string, cfg: ProjectConfig, gen: number, ticket: number): void {
    const key = projectPath.toLowerCase()
    if (gen !== this.generation || ticket < (this.rootsAt.get(key) ?? 0)) return
    // A project gone as the last refresh listed the folders, read before that: the read is older than its going.
    if (this.listedAt && ticket < this.listedAt.ticket && !this.listedAt.known.has(key)) return
    this.rootsAt.set(key, ticket)
    for (const [k, v] of this.roots) if (v.toLowerCase() === projectPath.toLowerCase()) this.roots.delete(k)
    for (const a of cfg.agents ?? []) if (a.worktree?.path) this.roots.set(resolve(a.worktree.path).toLowerCase(), projectPath)
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

  /** Creates <project>/.hive with defaults and excludes it from git. Idempotent. */
  async ensureProject(projectPath: string): Promise<void> {
    const h = join(projectPath, HIVE_DIR)
    await mkdir(join(h, 'sessions'), { recursive: true })
    await mkdir(join(h, 'archive'), { recursive: true })
    // Its platform is recorded as it is made, from what detection finds (SPEC §16.3.5): never switched silently after.
    if (!existsSync(join(h, 'project.json'))) await writeKeptJson(join(h, 'project.json'), { ...DEFAULT_PROJECT_CONFIG, platform: detect(projectPath).platform })
    // 0.1's launch folder for Agent 1; every agent now has launch-<id>.
    if (existsSync(join(h, 'launch'))) await removePath(join(h, 'launch')).catch(() => undefined)
    await this.ensureGitExclude(projectPath)
  }

  private gitDir(projectPath: string): Promise<string | null> {
    return gitDirOf(projectPath)
  }

  /** Adds the project's .hive to the info/exclude of the git repository holding it (its own, or one above), if it isn't (#345). */
  async ensureGitExclude(projectPath: string): Promise<void> {
    const r = await ensureHiveExcluded(projectPath)
    if (r?.added) log.info(`Excluded .hive from git in ${userText(r.root)}`)
    // The line is there whatever git can do; git missing only means it couldn't confirm a .gitignore doesn't bring .hive back (#346).
    if (r?.unconfirmed) log.info(`Git couldn't confirm .hive is ignored in ${userText(r.root)}${gitProblem() ? ` (${gitProblem()})` : ''}`)
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

  async projectConfig(projectPath: string): Promise<ProjectConfig> {
    const raw = await readKeptJson<Record<string, unknown>>(join(projectPath, HIVE_DIR, 'project.json'), {})
    const cfg = mergeDefaults(structuredClone(DEFAULT_PROJECT_CONFIG), migrateProjectConfig(raw))
    // The Assistant's "project" settings are Settings → Assistant; its file keeps the workspace's own choices.
    return this.isAssistantHome(projectPath) ? assistantProjectConfig(cfg, config.settings) : cfg
  }

  async updateProjectConfig(projectPath: string, patch: Partial<ProjectConfig>): Promise<ProjectConfig> {
    return this.mutateProjectConfig(projectPath, () => patch)
  }

  /**
   * Changes project.json from its current content: fn gets the config as it is now and returns the
   * fields to change. Changes to one project's config never overlap, so none is lost.
   */
  async mutateProjectConfig(projectPath: string, fn: (cfg: ProjectConfig) => Partial<ProjectConfig>): Promise<ProjectConfig> {
    const gen = this.generation
    await this.ensureProject(projectPath)
    const file = join(projectPath, HIVE_DIR, 'project.json')
    let ticket = 0
    const next = await withFileLock(file, async () => {
      const cfg = await this.projectConfig(projectPath)
      const patch = fn(cfg)
      let updated = { ...cfg, ...patch }
      // The agents changed: each layout's pane placement takes in those added and lets go of those removed (#762), so
      // every agent keeps its cell (not one worked out again from the order on each read).
      if ('agents' in patch && updated.placement) updated = { ...updated, placement: settlePlacements(updated.placement, projectAgents(updated).map((a) => a.id)) }
      await writeKeptJson(file, withLegacyProjectFields(updated))
      // As it is written: a read begun before now may have found the config from before.
      ticket = ++this.rootTickets
      return updated
    })
    this.registerRoots(projectPath, next, gen, ticket)
    if (gen === this.generation) this.savedAt.set(projectPath.toLowerCase(), Math.max(ticket, this.savedAt.get(projectPath.toLowerCase()) ?? 0))
    this.scheduleRefresh()
    return next
  }

  /**
   * Where a session host's records are kept (#1061): its workspace's database (a project's workspace is its parent folder,
   * the Assistant's home is the workspace's `.hive/assistant`), under the project's stable id (#508), so they follow a
   * rename; the Assistant's under `assistant`, a folder with no id yet under its name. With its old sessions.json, moved in
   * the first time.
   */
  private async sessionsPlace(projectPath: string): Promise<SessionsPlace> {
    const h = resolve(projectPath)
    const file = join(h, HIVE_DIR, 'sessions.json')
    const parent = dirname(h)
    if (basename(h).toLowerCase() === ASSISTANT_DIR.toLowerCase() && basename(parent).toLowerCase() === HIVE_DIR) return { workspace: dirname(parent), scope: 'assistant', file }
    const known = this.path ? (await this.projectIds().catch(() => null))?.byPath.get(h.toLowerCase()) : undefined
    const saved = known ?? (await readJson<{ id?: unknown } | null>(join(h, HIVE_DIR, 'project.json'), null).catch(() => null))?.id
    const removed = !!this.path && samePlace(parent, this.path) && (this.wsConfig.hiddenProjects ?? []).some((x) => x.mode === 'removed' && x.name.toLowerCase() === basename(h).toLowerCase())
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
    for (const p of allProviders()) for (const n of Object.keys(await p.projectMcpServers(projectPath).catch(() => ({})))) names.add(n)
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
    const active = new Set(this.activeNames())
    const ticket = ++this.rootTickets
    const cfg = await this.projectConfig(projectPath)
    this.registerRoots(projectPath, cfg, gen, ticket)
    const { live, restartNeeded, agents } = await WorkspaceService.liveProvider(projectPath, cfg, scope)
    const info: ProjectInfo = {
      name: basename(projectPath),
      path: projectPath,
      active: active.has(basename(projectPath)),
      isGitRepo: existsSync(join(projectPath, '.git')),
      branch: await this.branch(projectPath),
      config: cfg,
      live,
      restartNeeded,
      agents,
      unmanagedMcp: await this.unmanagedMcp(projectPath),
      removedData: await removedData(projectPath),
      // Ensured at each refresh, so a repository made later (git init) gets it too (#345).
      ...(this.isAssistantHome(projectPath) ? {} : { hiveVcs: await hiveVcs(projectPath).catch(() => undefined), platform: projectPlatform(projectPath, cfg.platform) })
    }
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
    if ((this.platformOffers.get(key) ?? '') === why) return
    this.platformOffers.set(key, why)
    if (!why) return
    if (p.invalid !== undefined) log.warn(`${userText(basename(projectPath))}'s project.json names no platform Hive has (${userText(p.invalid)}): it uses ${p.id}, as detected`)
    else log.info(`${userText(basename(projectPath))} is a ${p.id} project; its folder now says ${p.detected.platform}${p.detected.other ? ` (${p.detected.other} found)` : ''}`)
    this.emit({ type: 'toast', toast: { id: randomUUID(), level: p.invalid !== undefined ? 'warning' : 'info', ...platformNotice(basename(projectPath), p), source: projectPath, timestamp: new Date().toISOString() } })
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
    const gen = this.generation
    const seq = ++this.refreshes
    // Before the folders are listed: a project the listing misses was gone by then.
    const listed = ++this.rootTickets
    const projects: ProjectInfo[] = []
    // Closed or switched meanwhile: the new workspace's own refresh reports it. Each read is the refresh's lifetime's
    // (#784): one begun after a switch would otherwise record the old workspace's worktrees in the new one.
    const closed = (): boolean => gen !== this.generation || !this.path
    // What the projects' running agents' settings need of the workspace (its skills and servers), read once (#1002).
    const scope = {}
    for (const p of await this.listProjectPaths()) {
      if (closed()) throw hiveError(M.closed, undefined, { kind: 'conflict' })
      projects.push(await this.projectInfo(p, gen, scope))
    }
    if (closed()) throw hiveError(M.closed, undefined, { kind: 'conflict' })
    const assistant = await this.projectInfo(this.assistantHome, gen, scope).catch((e) => (log.warn('the Assistant', e), null))
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
    for (const [project, at] of this.savedAt) if (!this.listedAt.known.has(project) && at < listed) this.savedAt.delete(project)
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
    this.emit({ type: 'toast', toast: { id: randomUUID(), level: 'warning', title, message, actions: [{ label, command: 'agent.settings', args: [first.path, first.id] }], source: first.path, timestamp: new Date().toISOString() } })
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
    await mkdir(p)
    await this.ensureProject(p)
    return this.refresh()
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
  const file = join(projectPath, HIVE_DIR, REMOVED_DIR, 'manifest.json')
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

/** Closes a window's workspace and forgets its service. */
export async function disposeWorkspaceService(w: WorkspaceService): Promise<void> {
  await w.close()
  services.delete(w)
}

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
  'isProjectPath', 'assertProject', 'assertRoot', 'assertChangesRoot', 'noteUnusedWorktrees', 'projectForRoot', 'updateAgent', 'ensureProject', 'ensureGitExclude', 'branch',
  'projectConfig', 'updateProjectConfig', 'mutateProjectConfig', 'sessionsFile', 'sessionScope', 'mutateSessions', 'upsertSession', 'setActive',
  'unmanagedMcp', 'projectInfo', 'isAssistantHome', 'assertSessionHost'
])

export const workspace: WorkspaceService = new Proxy({} as WorkspaceService, {
  get(_t, key: string) {
    // Any open workspace's files may be read (hive-img:, file IPC) — each window only shows its own.
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
