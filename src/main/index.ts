// First: the thread pool's size is set before anything uses it (HI-1702).
import './threadPool'
import { initWatches, onWatchedCardsMoved, watchKeepsQuitWaiting } from './watches'
import { initLoopWakes } from './loopWakes'
import { migrateAgentsPerProject } from './workflow/preferences'
import { settleGlobalCommitMessage } from './workflow/commitMessageStep'
import { initLoopCheck } from './loopCheck'
import { initDeliveries } from './deliveries'
import { initReviewsOnOpen } from './reviewsOnOpen'
import { initSkillCopies } from './skillCopies'
import { offNames } from '../shared/skillDelivery'
import { initInboxNotices } from './inboxNotices'
import { startOrphanWatch, stopOrphanWatch } from './orphanProcesses'
import { initDecisionWakes } from './decisionWakes'
// The user's answers given to the Assistant too (HI-1734): its delivery source, registered at start.
import './answerRelay'
import './assistantAsk'
import { initWorkflowNotices } from './workflowNotices'
import { initDevConsole } from './devConsoleSources'
import { flightRecorder } from './flightRecorder'
import { initAssistantModes } from './assistantMode'
import { app, BrowserWindow, dialog, Menu, nativeTheme, protocol, screen, session, shell } from 'electron'
import { execFile } from 'child_process'
import { appendFileSync, createReadStream, existsSync } from 'original-fs'
import { basename, join, resolve, sep } from 'path'
import { appendFile, readFile, stat } from 'original-fs/promises'
import { Readable } from 'stream'
import type { AppInfo, CloseReason, McpServerDef, QuitChoice, QuitScope, QuitSession, TaskCard, WindowState } from '../shared/types'
import { providerService } from './providerService'
import { initConnections } from './accounts'
import { initConnectionMoves } from './connectionMoves'
import { initUsageMoves } from './usageMoves'
import { checkGit } from './gitTool'
import { handoverSession, hiveInstructions, withLatestHandover, wrapsLongCommands } from '../shared/hiveGuidance'
import { handoversFor } from './notes'
import { assistantInstructions } from './modes'
import { ASSISTANT_NAME, assistantModeId } from '../shared/assistant'
import { MARKED_LOG } from '../shared/redact'
import { APP_NAME, DEV_APP_NAME, appName, legacyProfileFolder, profileFolder } from '../shared/appName'
import { chooseProfile, choiceLine, setProfileChoices } from './profileFolders'
import { syncLoginItemAtStart } from './loginItem'
import { startProfileNotices } from './profileNotices'
import { PROVIDERS, dangerModes, labelList, projectProviderConfig, providerSettings } from '../shared/providers'
import { projectAgents } from '../shared/defaults'
import { setDateStyle } from '../shared/dates'
import { SERVABLE_EXT, servableType, unwatchAll } from './files'
import { movedAttachment } from './attachmentsFolder'
import { config } from './config'
import { loadCoverage, startCoverage, startCoverageEarly } from './keyCoverage'
import { closeConsoleWindows, sendToConsoles } from './consoleWindow'
import { allTasks, archiveOldDone, endExitedReviews } from './tasks'
import { queueCleanupEverywhere } from './cardAttachmentCleanup'
import { agentCardText } from '../shared/agentTable'
import { emit, emitTo, onHiveEvent, toast } from './events'
import { advanced, bindAdvancedSettings, mcpAdvancedEnv } from './advanced'
import { GPU_SWITCH, advancedAtStart, relaunchArgs, startGpu } from './gpu'
import { HARDWARE_ACCELERATION_OFF, HEAP_SNAPSHOT_NEAR_LIMIT, HIVE_GUIDANCE } from '../shared/advanced'
import { startHeapSnapshots, startMemoryLog } from './memory'
import { recordLiveCardsSoon } from './cardSessions'
import { closeAllBoards, onBoardNotice } from './boardStore'
import { closeAllJournals } from './journal'
import { registerIpc, requestingWindow } from './ipc'
import { watchRenderer } from './rendererWatch'
import { startPowerWatch } from './power'
import { startTaskbarFlash } from './taskbar'
import { setTitleBarColors, trackTitleBar } from './titleBar'
import { placeOnDisplay } from './windowBounds'
import { startBranchWatch } from './branchWatch'
import { startObserving, stopObserving } from './platform/watching'
import { startReconciling, stopReconciling } from './workflow/reconciler'
import { queueFolderNeeded, releaseQueueRunners } from './workflow/queueRunner'
import { stopCodexChecks } from './codexChecks'
import { queueLive, startQueueHosts, stopQueueHosts } from './workflow/queueHost'
import { poolFor, startSlots, stopSlots } from './slotsApp'
import { setQueueNeed, setSlotPools } from './unusedWorktrees'
import { quitSlotCards, startSlotCards, stopSlotCards } from './slotCards'
import { startFinishPath } from './finishPath'
import { startLaneBriefs, stopLaneBriefs } from './laneBriefs'
import { startSlotMigration, stopSlotMigration } from './slotMigration'
import { startReviewerPool, stopReviewerPool } from './reviewerPool'
import { startFreshNudges } from './freshStarts'
import { startCopies, stopCopies } from './copiesApp'
import { startReviewCopies, stopReviewCopies } from './reviewCopies'
import { setAgentBusy, startLineUpdates } from './workflow/lineUpdates'
import { startLockRecords } from './workflow/lockRecord'
import { setAgentRunning, setQueueLive, setRunsGoing, workflowFor } from './workflow/service'
import { isOpenRun } from '../shared/progress'
import { createLogger, userText, logsDir } from './logger'
import { killAll } from './ptyHost'
import { allLeftovers, closeProcessTracking, leftoversOffer, leftoversSaved, leftoversSettled, recordEndedLaunches, restoreLeftovers, settleAllLeftovers, settleLeftovers, warmProcessTracking } from './agentProcesses'
import { leftoversSummary } from '../shared/agentProcesses'
import { installShims } from './progressReporters/shims'
import { insideArchive, onCorruptFile, renameDiagnostics } from './fsutil'
import { apiEnv, assistantApiUrl, startApiServer, startHookServer } from './servers'
import { clearDiscovery, clearDiscoveryNow } from './apiDiscovery'
import { clearHookAuth } from './hookTokens'
import { assistantHome, assistantTokenFile, endAssistant, newAssistantToken, newTurn } from './assistantControl'
import { sessions } from './sessions'
import { forgetPicks } from './dialects/view'
import { usageHistory } from './usageHistory'
import { notificationIcon } from './paths'
import { createTray, destroyTray, resourcesDir, setTrayPendingQuit, showWindow } from './tray'
import { keepOffScreen, offScreenOrigin, testQuiet } from './testQuiet'
import { COMMIT_WATCH_ARG } from '../shared/commitWatch'
import { pinFollower } from './pin'
import { closedNotice, startNoticeResolver } from './notices'
import { setNotifyHost, tell } from './notify'
import { initUpdater, installNow, installsOnQuit, markInstalling } from './updater'
import { flushMetrics } from './metrics'
import { watchMainStalls } from './mainStalls'
import { fileHolders } from './fileHolders'
import { onAgentStartChange, startSeq } from './agentStarts'
import { agentStartOf, setStallRuns, withAgentStarts } from './cardStall'
import { createWorkspaceService, disposeWorkspaceService, inWorkspace, openWorkspaces, workspace, workspaceFor, workspaceOf, WorkspaceService } from './workspace'
import { closeWithCommand, quitCommandPlanned, quitRunsAny, runQuitCommand, type RunOutcome } from './closeCommand/closeCommands'
import { journalSettingsOf } from './journalService'
import { assistantStartView } from './startView'
import { hiveWindows, lastFocused, TITLE_BAR_OVERLAY, registerWindow, unregisterWindow, windowForPath, type HiveWindow } from './windows'
import { abandonWindowStorage } from './storage'
import { agentTokenFile } from './agentTokens'
import { progress, setTaskbarTestHook, startProgress } from './progressService'
import { startMergeSlots } from './mergeSlotHost'
import { startLanes } from './lanes'
import { startLaneStarts } from './laneStarts'
import { startHandOverCheck } from './handOverCheck'
import { startLaunchSides } from './launchSides'
import { checkInstallDir } from './installDir'
import { exitBy, logCrashDumps, startCrashDumps, startExitLog } from './exitLog'
import { checkLastRun, lastUnexpectedClose, startRunMarker, startupStep, tellUnexpectedClose } from './lastRun'
import { initRestartRecovery, loadRestartRecord, recordClosing, startRestartRecovery, stopRestartRecovery, stopWatchingRestartRequests, watchRestartRequests } from './restartResume'
import type { RestartReason } from '../shared/restartResume'
import { startOutageResume } from './outageResume'
import { startRetryNotice } from './retryNotice'
import { chooseStartLanguage, languageInfo, startI18n, switchLanguage } from './i18n'
import { fmt, msg, tr } from '../shared/i18n'
import { clearSavedPauses } from './teamPause'

const log = createLogger('main')
let quitting = false

// Development builds use their own profile (and Agent API port, see servers.ts) so they can run
// alongside the installed Hive — e.g. while developing Hive from a session inside Hive.
// HIVE_USER_DATA overrides the profile folder for tests. The installed app's is set too: Electron would name it after
// productName. The profile folders are Combwork's (HI-2461), which the installer moves Hive's to (HI-2460); while
// Combwork's isn't there, Hive's is used (profileFolders.ts: it only looks, never moves or deletes), and a notice says so.
const profileLines: string[] = []
const chooseProfiles = (roamingParent: string, localParent: string, packaged: boolean): void => {
  const roaming = chooseProfile(roamingParent, legacyProfileFolder(packaged), profileFolder(packaged))
  const local = chooseProfile(localParent, legacyProfileFolder(packaged), profileFolder(packaged))
  setProfileChoices({ roaming, local })
  for (const c of [roaming, local]) {
    const line = choiceLine(c, userText)
    if (line) profileLines.push(line)
  }
  app.setPath('userData', roaming.use)
}
// A test copy of the choice (unpackaged only): made in HIVE_TEST_PROFILE_CHOOSE's appdata and localappdata folders,
// never the real ones, with a dev build's names.
if (process.env.HIVE_USER_DATA && !app.isPackaged && process.env.HIVE_TEST_PROFILE_CHOOSE) {
  const base = resolve(process.env.HIVE_TEST_PROFILE_CHOOSE)
  chooseProfiles(join(base, 'appdata'), join(base, 'localappdata'), false)
} else if (process.env.HIVE_USER_DATA) app.setPath('userData', process.env.HIVE_USER_DATA)
else chooseProfiles(app.getPath('appData'), process.env.LOCALAPPDATA || join(app.getPath('home'), 'AppData', 'Local'), app.isPackaged)
// Key masking as the profile's files say, before the first line is logged (HI-1855): strict only where a key may be.
startCoverageEarly()
// Every way out from here on is logged (#985).
startExitLog()

// Hardware acceleration off (#676): Settings → Advanced's value, read from advanced.json before the app is ready, or
// --disable-gpu for this start.
const gpu = startGpu(app.getPath('userData'), app.commandLine.hasSwitch(GPU_SWITCH))
if (gpu.off) app.disableHardwareAcceleration()
// A heap snapshot as the main process nears its memory limit (#1005): Settings → Advanced's value as Hive starts.
const heapSnapshots = advancedAtStart(app.getPath('userData'), HEAP_SNAPSHOT_NEAR_LIMIT)
advanced.startedWith({ [HARDWARE_ACCELERATION_OFF]: gpu.setting, [HEAP_SNAPSHOT_NEAR_LIMIT]: heapSnapshots })

// Before Electron's own check of the install folder, which crashes Hive with nothing on screen (installDir.ts).
if (process.platform === 'win32') checkInstallDir()

// One Hive process, with a window per workspace (like VS Code): starting Hive again brings it forward.
// A quiet test copy's windows are off screen (testQuiet): Chromium mustn't take them for covered and stop drawing them.
if (testQuiet()) app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

// Chromium takes its language only at start (#767): --lang or HIVE_LANG, the setting, or Windows' languages.
chooseStartLanguage(config.savedLanguage())

if (!app.requestSingleInstanceLock()) {
  exitBy('process.exit', 'Hive is already running: this start brings it forward', () => {
    app.quit()
    process.exit(0)
  })
}
// Crash dumps stay in the profile, never uploaded (#985); only the copy that runs keeps them.
startCrashDumps()

// Windows ties the taskbar icon and notification name/icon to this ID. Dev and test builds run as
// electron.exe, so they get their own ID; sharing it made Windows show Electron's icon for Hive.
// Combwork's (HI-2460): Hive Desktop's was com.hive.desktop (.dev), which its installer removes.
const APP_ID = app.isPackaged ? 'it.surmise.combwork' : 'it.surmise.combwork.dev'
app.setAppUserModelId(APP_ID)
if (!app.isPackaged && process.platform === 'win32') registerDevAppId()

/** Names the dev app ID "Combwork Dev" (DEV_APP_NAME) with the app's icon, so its notifications don't say "Electron". */
function registerDevAppId(): void {
  const key = ['HKCU', 'Software', 'Classes', 'AppUserModelId', APP_ID].join('\\')
  const icon = notificationIcon()
  execFile('reg', ['add', key, '/v', 'DisplayName', '/d', DEV_APP_NAME, '/f'], { windowsHide: true }, () => undefined)
  execFile('reg', ['add', key, '/v', 'IconUri', '/d', icon, '/f'], { windowsHide: true }, () => undefined)
}

// hive-img://img/<encoded absolute path> serves images inside the workspace to the renderer (Attachments tab thumbnails, image and PDF previews).
protocol.registerSchemesAsPrivileged([{ scheme: 'hive-img', privileges: { standard: true, secure: true, supportFetchAPI: true } }])

/** A script a plain Node process runs (hive-mcp.js, hive-progress.js): unpacked from the asar (electron-builder.yml). */
function unpackedScript(name: string): string {
  const p = join(__dirname, name)
  return app.isPackaged ? p.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`) : p
}

function hiveMcpScript(): string {
  return unpackedScript('hive-mcp.js')
}

function appInfo(): AppInfo {
  return {
    name: APP_NAME,
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    userData: app.getPath('userData'),
    logsPath: logsDir(),
    isPackaged: app.isPackaged,
    language: languageInfo(),
    gpu: { off: gpu.off, why: gpu.why }
  }
}

function titleBarColors(): { color: string; symbolColor: string } {
  const dark = config.settings.appearance.theme === 'dark' || (config.settings.appearance.theme === 'system' && nativeTheme.shouldUseDarkColors)
  return dark ? { color: '#1f1f1f', symbolColor: '#cccccc' } : { color: '#f3f3f3', symbolColor: '#333333' }
}

/** The smallest a Hive window can be. */
const WINDOW_MIN = { width: 900, height: 560 }

/**
 * Opens a Hive window, with its own workspace service. `workspacePath` opens that workspace in it;
 * `bounds` places it (a restored window), else it goes over the last focused one, offset like VS Code's.
 */
function createWindow(opts: { workspacePath?: string | null; bounds?: WindowState; hidden?: boolean } = {}): HiveWindow {
  const from = lastFocused()
  let b: WindowState = opts.bounds ?? config.get().window
  if (!opts.bounds && from && !from.win.isDestroyed()) {
    const r = from.win.getNormalBounds()
    b = { x: r.x + 30, y: r.y + 30, width: r.width, height: r.height, maximized: false }
  }
  // Fitted to the display it opens on: the one its corner is on, else the primary one, where it is centred (#812).
  b = placeOnDisplay(b, WINDOW_MIN, screen)
  // A quiet test copy's windows open off screen, never over the user's (testQuiet).
  const offScreen = testQuiet() ? offScreenOrigin(b.width) : null
  const win = new BrowserWindow({
    width: b.width,
    height: b.height,
    x: offScreen ? offScreen.x : b.x,
    y: offScreen ? offScreen.y : b.y,
    minWidth: WINDOW_MIN.width,
    minHeight: WINDOW_MIN.height,
    show: false,
    // Off screen and never handed the focus either: when the user's active window closes, Windows passes the focus to
    // the next window, and it mustn't be an invisible test window (testQuiet).
    focusable: !offScreen,
    title: appName(app.isPackaged),
    icon: join(resourcesDir(), 'icon.png'),
    backgroundColor: titleBarColors().color,
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...titleBarColors(), height: TITLE_BAR_OVERLAY },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      // Enables Chromium's built-in PDF viewer for the Files tab preview.
      plugins: true,
      spellcheck: false,
      // A test copy's watch on React's commits (HI-1387): the preload passes it on to the page.
      additionalArguments: testQuiet() ? [COMMIT_WATCH_ARG] : []
    }
  })
  trackTitleBar(win, titleBarColors())
  // Maximising brings a window on screen and to the front: never for a quiet test copy, which stays off screen.
  if (b.maximized && !offScreen) win.maximize()
  if (offScreen) keepOffScreen(win)
  if (process.platform === 'win32') {
    // Taskbar identity for this window: the installed exe's icon, or the repo icon for dev builds.
    win.setAppDetails({
      appId: APP_ID,
      appIconPath: app.isPackaged ? process.execPath : join(__dirname, '../../build/icon.ico'),
      appIconIndex: 0,
      relaunchDisplayName: appName(app.isPackaged)
    })
  }
  const entry = registerWindow(win, createWorkspaceService())
  emit({ type: 'windows-changed', count: hiveWindows().length })
  // A page that crashes or hangs is reloaded (or the user asked); agents run here and keep going.
  watchRenderer(entry, { quitting: () => quitting, openLogs: () => void shell.openPath(logsDir()), quit: () => void quitNow(true) })

  win.once('ready-to-show', () => {
    if (opts.hidden) return
    // A quiet test copy (testQuiet) shows its window without taking focus from whatever the user is doing.
    if (testQuiet()) win.showInactive()
    else win.show()
  })

  const saveBounds = (): void => {
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return
    const maximized = win.isMaximized()
    // The last window moved or resized sets where a new window goes.
    config.update((c) => {
      c.window.maximized = maximized
      if (!maximized) Object.assign(c.window, win.getBounds())
    })
    saveWindowsSoon()
  }
  win.on('resize', saveBounds)
  win.on('move', saveBounds)
  const sendState = (): void => emitTo(win, { type: 'window-state', maximized: win.isMaximized(), focused: win.isFocused(), alwaysOnTop: win.isAlwaysOnTop() })
  // Always on Top goes with the workspace the window shows (pin.ts): set when one opens in it, off on the welcome page.
  const followPin = pinFollower(win)
  const stopPin = onHiveEvent((e) => {
    if (e.type === 'workspace-changed' && followPin(entry.ws.path)) sendState()
  })
  win.on('maximize', sendState)
  win.on('unmaximize', sendState)
  win.on('focus', sendState)
  win.on('blur', sendState)

  win.on('minimize', () => {
    if (config.settings.general.minimizeToTray) win.hide()
  })
  win.on('close', (e) => {
    if (quitting || entry.closing) return
    e.preventDefault()
    // The last window: the tray keeps Hive running, or closing it quits (as before there were several).
    if (hiveWindows().length <= 1) {
      if (config.settings.general.closeToTray) win.hide()
      else void requestQuit()
      return
    }
    void requestCloseWindow(entry)
  })
  // The page going (the window closed, or the page reloaded) runs none of its clean-up: the Storage measurements it
  // asked for are abandoned, and those nothing else waits for stop (#260).
  const contents = win.webContents.id
  win.webContents.on('did-start-navigation', (e) => {
    if (e.isMainFrame && !e.isSameDocument) abandonWindowStorage(contents)
  })
  win.on('closed', () => {
    stopPin()
    abandonWindowStorage(contents)
    unregisterWindow(entry)
    void disposeWorkspaceService(entry.ws)
    if (!quitting) saveWindows()
    emit({ type: 'windows-changed', count: hiveWindows().length })
  })

  // Links open in the user's browser, never inside Hive.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault()
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    }
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))

  if (opts.workspacePath) {
    const path = opts.workspacePath
    // At start, the notice that Hive closed unexpectedly waits for it (#984).
    startupStep(inWorkspace(entry.ws, () => entry.ws.open(path)).catch((e) => log.warn(`Could not reopen ${userText(path)}`, e)))
  }
  return entry
}

// ---------------------------------------------------------------------------
// Which windows were open, reopened at the next start (like VS Code).
// ---------------------------------------------------------------------------

function saveWindows(): void {
  const list = hiveWindows().map((e) => {
    const maximized = e.win.isMaximized()
    const r = e.win.getNormalBounds()
    return { workspace: e.ws.path, x: r.x, y: r.y, width: r.width, height: r.height, maximized }
  })
  if (!list.length) return
  config.update((c) => {
    c.windows = list
    // 0.1 reopened one workspace: the last focused window's.
    c.lastWorkspace = lastFocused()?.ws.path ?? list[0].workspace
  })
}

let saveTimer: NodeJS.Timeout | null = null
function saveWindowsSoon(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    if (!quitting) saveWindows()
  }, 500)
}

/** The windows to open at start: those open when Hive last quit, else one window with the last workspace. */
function windowsToRestore(): { workspacePath: string | null; bounds?: WindowState }[] {
  const c = config.get()
  const reopen = config.settings.general.reopenLastWorkspace
  const saved = (c.windows ?? []).filter((w) => !w.workspace || existsSync(w.workspace))
  if (reopen && saved.length) {
    const seen = new Set<string>()
    const out = []
    for (const w of saved) {
      const key = w.workspace?.toLowerCase()
      if (key && seen.has(key)) continue
      if (key) seen.add(key)
      out.push({ workspacePath: w.workspace, bounds: { x: w.x, y: w.y, width: w.width, height: w.height, maximized: w.maximized } })
    }
    return out
  }
  const last = reopen && c.lastWorkspace && existsSync(c.lastWorkspace) ? c.lastWorkspace : null
  return [{ workspacePath: last, bounds: c.window }]
}

// ---------------------------------------------------------------------------
// Quitting, and closing one window. Stopping a session loses nothing (it can be resumed), but stopping an
// agent that is working interrupts it — so by default Hive only asks when that would happen, in its own dialog.
// ---------------------------------------------------------------------------

let pendingQuit = false
/** Restart and Update was chosen: install the downloaded update instead of just quitting. */
let installOnQuit = false
/** Restart Hive was chosen (#676: a value that applies when Hive restarts): start again after quitting. */
let relaunchOnQuit = false
/** An installer asked Hive to close for an install (HI-1707): the quit records its agents as an install's. */
let quitReason: RestartReason | null = null

/** The running sessions of every window, or of one workspace. */
const quitSessions = (ws?: WorkspaceService): QuitSession[] =>
  sessions
    .liveStates()
    .filter((s) => !ws || workspaceFor(s.projectPath) === ws)
    .map((s) => {
      // A watching agent says what for, and whether quitting when agents finish waits for it (the same rule as workingCount).
      const watch = s.status === 'watching' && s.watch ? { watch: s.watch.label, ...(watchKeepsQuitWaiting(s) ? { keepsQuitWaiting: true } : {}) } : {}
      const wsPath = workspaceOf(s.projectPath).path
      const where = wsPath ? { workspace: basename(wsPath), workspacePath: wsPath } : {}
      if (workspace.isAssistantHome(s.projectPath)) return { projectPath: s.projectPath, project: ASSISTANT_NAME, status: s.status, provider: s.provider, ...where, ...watch }
      // Every agent by its name and id (#572: the dialog's table has an Agent column, and its Card is found by the id).
      return { projectPath: s.projectPath, project: basename(s.projectPath), status: s.status, provider: s.provider, ...where, agent: s.agentName ?? s.agentId, agentId: s.agentId, ...watch }
    })

/**
 * The sessions with each agent's card (#572): the one it works on, or reviews, from its workspace's board, read once a
 * workspace. A board that can't be read leaves its agents without one.
 */
async function withCards(list: QuitSession[]): Promise<QuitSession[]> {
  const boards = new Map<string, Promise<TaskCard[]>>()
  const board = (projectPath: string): Promise<TaskCard[]> => {
    const ws = workspaceOf(projectPath)
    const key = (ws.path ?? '').toLowerCase()
    if (!boards.has(key)) boards.set(key, allTasks(ws, { archived: false }).catch(() => []))
    return boards.get(key)!
  }
  return Promise.all(
    list.map(async (s) => {
      if (!s.agentId) return s
      const card = agentCardText(await board(s.projectPath), s.project, s.agentId)
      return card ? { ...s, card } : s
    })
  )
}
/** Agents that are working, or waiting on background tasks that will set them working again. */
// A watching agent whose card is being worked on by another agent isn't done either: it carries on when woken.
const workingCount = (): number => sessions.liveStates().filter((s) => s.status === 'working' || s.status === 'background' || !!watchKeepsQuitWaiting(s)).length

/** Shows the quit (or close) dialog in a window and waits for the answer. */
function ask(e: HiveWindow, req: { sessions: QuitSession[]; unsaved: string[]; scope: QuitScope }): Promise<QuitChoice> {
  showWindow(e.win)
  return new Promise<QuitChoice>((answer) => {
    // Held at once, so a second request finds it; shown once the agents' cards are read (#572).
    e.question = { request: req.sessions, unsaved: req.unsaved, scope: req.scope, answer }
    void withCards(req.sessions).then((listed) => {
      if (e.question?.answer !== answer) return
      e.question.request = listed
      emitTo(e.win, { type: 'quit-request', sessions: listed, unsaved: req.unsaved, scope: req.scope })
    })
  }).finally(() => {
    e.question = null
  })
}

/**
 * Quitting, asking first as Confirm on quit and unsaved files say. `intent` is Restart and Update's ('update') or
 * Restart Hive's ('restart'): it belongs to this request only (HI-2427), set for the quit once it goes ahead.
 */
async function requestQuit(opts: { force?: boolean; intent?: 'update' | 'restart' } = {}): Promise<void> {
  const forUpdate = opts.intent === 'update'
  const forRelaunch = opts.intent === 'restart'
  // A quit under way, or waiting for its agents: it goes ahead with this request's install or restart too (cancelling
  // a waiting quit forgets it).
  if (quitting || pendingQuit) {
    installOnQuit ||= forUpdate
    relaunchOnQuit ||= forRelaunch
  }
  if (quitting) return
  // Already waiting to quit: asking again means "now", after the final look at unsaved files (HI-2336).
  if (pendingQuit) return finishPendingQuit()
  const asking = hiveWindows().find((e) => e.question)
  if (asking) {
    // A dialog is already open: just bring it forward. Its answer is about what it asked: this request's install or
    // restart is dropped, never kept for a later quit (HI-2427); its notice keeps Restart and Update.
    if (opts.intent) log.info(`${forUpdate ? 'Restart and Update' : 'Restart Hive'} while a question is open: brought it forward, not kept for a later quit`)
    showWindow(asking.win)
    return
  }
  // Only a quit that goes ahead from here on installs the update, or restarts; a cancelled one forgets it.
  installOnQuit = false
  relaunchOnQuit = false
  const live = sessions.liveStates()
  const mode = config.settings.general.confirmOnQuit
  const unsavedIn = hiveWindows().filter((e) => e.unsaved.length > 0)
  const askSessions = !opts.force && live.length > 0 && (mode === 'always' || (mode === 'working' && sessions.busyStates().length > 0))
  const target = unsavedIn.find((e) => e === lastFocused()) ?? unsavedIn[0] ?? lastFocused()
  if ((askSessions || unsavedIn.length > 0) && target) {
    // Unsaved edits live in each window's page: a window with some is asked about them first.
    for (const other of unsavedIn.filter((e) => e !== target)) {
      const first = await ask(other, { sessions: [], unsaved: other.unsaved, scope: 'app' })
      if (first === 'cancel') return
      // Its files are dealt with, but its agents weren't listed: closing it asks about them as Close Window does.
      if (first === 'window') return closeWindowOnly(other, { unsaved: true })
    }
    const choice = await ask(target, { sessions: askSessions ? quitSessions() : [], unsaved: target.unsaved, scope: 'app' })
    if (choice === 'cancel') return
    // Close this window only: the Close Window path, without asking again about what the dialog listed.
    if (choice === 'window') return closeWindowOnly(target, { sessions: askSessions, unsaved: true })
    installOnQuit = forUpdate
    relaunchOnQuit = forRelaunch
    if (choice === 'wait') return startPendingQuit()
    return quitNow(!askSessions && live.length > 0)
  }
  installOnQuit = forUpdate
  relaunchOnQuit = forRelaunch
  return quitNow(live.length > 0)
}

/** Whether to ask before stopping these sessions: the Confirm on quit setting, the same for quitting, windows and workspaces. */
function askBeforeStopping(mine: QuitSession[]): boolean {
  const mode = config.settings.general.confirmOnQuit
  // The same as quitting's (sessions.busyStates): a watching agent is in the middle of its card loop too.
  const busy = mine.some((s) => s.status === 'working' || s.status === 'waiting' || s.status === 'background' || s.status === 'watching')
  return mine.length > 0 && (mode === 'always' || (mode === 'working' && busy))
}

/**
 * Closing a window's workspace, or switching the window to another one: its agents are stopped, after asking as
 * closing the window does. False when the user cancels. Unsaved files were already dealt with by the page.
 */
async function stopWorkspaceAgents(from: BrowserWindow, scope: 'workspace' | 'switch'): Promise<boolean> {
  const e = hiveWindows().find((x) => x.win === from)
  if (!e) return false
  if (e.question) {
    showWindow(e.win)
    return false
  }
  const mine = quitSessions(e.ws)
  if (mine.length && askBeforeStopping(mine) && (await ask(e, { sessions: mine, unsaved: [], scope })) === 'cancel') return false
  // Also cancels agents still starting (not listed: they have no session yet). No new one starts until the
  // workspace has closed or switched (ipc clears the flag).
  e.ws.closing = true
  await sessions.stopWhereAndWait((s) => workspaceFor(s.projectPath) === e.ws, 3000, 'closed')
  // Their slot writers released while the workspace is open (HI-2299: released after it closed, they failed). Each
  // waits for its run's job to be seen empty (about 2 s), so a bound of 5 s, as the quit's look has.
  await sessions.writersSettled(5000, (p) => workspaceFor(p) === e.ws)
  return true
}

/** What the quit dialog has just dealt with, before Close this window only: its agents (listed) and its unsaved files. */
type AlreadyAsked = { sessions?: boolean; unsaved?: boolean }

/**
 * Closing a window (not the last): its workspace's agents are stopped, after asking as quitting does, about what the
 * quit dialog hasn't already (`done`).
 */
async function requestCloseWindow(e: HiveWindow, done: AlreadyAsked = {}): Promise<void> {
  if (e.question) return showWindow(e.win)
  const mine = quitSessions(e.ws)
  const askSessions = !done.sessions && askBeforeStopping(mine)
  const unsaved = done.unsaved ? [] : e.unsaved
  if (askSessions || unsaved.length) {
    const choice = await ask(e, { sessions: askSessions ? mine : [], unsaved, scope: 'window' })
    if (choice === 'cancel') return
  }
  e.ws.closing = true
  await sessions.stopWhereAndWait((s) => workspaceFor(s.projectPath) === e.ws, 3000, 'closed')
  // Their slot writers released while the workspace is open (HI-2299: released after it closed, they failed). Each
  // waits for its run's job to be seen empty (about 2 s), so a bound of 5 s, as the quit's look has.
  await sessions.writersSettled(5000, (p) => workspaceFor(p) === e.ws)
  saveWindowsWithout(e)
  // Its workspace closed here, its close command run in it while it is still shown (HI-1368), then the window goes.
  await closeWithCommand(e.ws, 'window', e.win).catch((err) => log.warn("closing the window's workspace", err))
  e.closing = true
  if (!e.win.isDestroyed()) e.win.close()
}

/**
 * The quit dialog's Close this window only (shown only with several windows open). Were it the last window by now,
 * it closes as the last window's X does: to the tray, or quitting.
 */
function closeWindowOnly(e: HiveWindow, done: AlreadyAsked): Promise<void> {
  if (hiveWindows().length > 1) return requestCloseWindow(e, done)
  if (config.settings.general.closeToTray) {
    e.win.hide()
    return Promise.resolve()
  }
  return quitNow(sessions.liveCount() > 0)
}

/** Remembers the windows as they will be once this one has closed. */
function saveWindowsWithout(e: HiveWindow): void {
  const others = hiveWindows().filter((x) => x !== e)
  if (!others.length) return
  config.update((c) => {
    c.windows = (c.windows ?? []).filter((w) => w.workspace?.toLowerCase() !== e.ws.path?.toLowerCase() || !e.ws.path)
  })
}

function startPendingQuit(): void {
  pendingQuit = true
  setTrayPendingQuit(true)
  emit({ type: 'quit-pending', pending: true, working: workingCount() })
  for (const e of hiveWindows()) e.win.hide()
  checkPendingQuit()
}

function cancelPendingQuit(): void {
  if (!pendingQuit) return
  pendingQuit = false
  installOnQuit = false
  relaunchOnQuit = false
  setTrayPendingQuit(false)
  emit({ type: 'quit-pending', pending: false, working: 0 })
}

function checkPendingQuit(): void {
  if (!pendingQuit) return
  const working = workingCount()
  if (working === 0) void finishPendingQuit()
  else emit({ type: 'quit-pending', pending: true, working })
}

/** The pending quit's final look at unsaved files under way (HI-2336): repeated session events open its dialog once. */
let finishingPendingQuit: Promise<void> | null = null

/**
 * A pending quit going ahead (the last agent finished, or Quit Now while it waits; HI-2336): a window reopened during
 * the wait may hold edits made since the quit was asked for, so each window with unsaved files asks about them first,
 * as quitting does (save or discard). Cancel there keeps Hive running (the pending quit is cancelled). Once at a time.
 */
function finishPendingQuit(): Promise<void> {
  if (finishingPendingQuit) {
    const asking = hiveWindows().find((e) => e.question)
    if (asking) showWindow(asking.win)
    log.info('Pending quit: its final look at unsaved files is already asking; brought forward, not asked again')
    return finishingPendingQuit
  }
  finishingPendingQuit = (async () => {
    try {
      for (const e of hiveWindows().filter((x) => x.unsaved.length > 0)) {
        if (!pendingQuit || quitting) return
        const choice = await ask(e, { sessions: [], unsaved: e.unsaved, scope: 'app' })
        if (choice === 'cancel') return cancelPendingQuit()
        // Close this window only: its files are dealt with; the quit still waits for the rest.
        if (choice === 'window') return void closeWindowOnly(e, { unsaved: true })
      }
      if (pendingQuit && !quitting) await quitNow(true)
    } finally {
      finishingPendingQuit = null
    }
  })()
  return finishingPendingQuit
}

async function quitNow(tellUser: boolean): Promise<void> {
  if (quitting) return
  // Remember the windows before they close.
  saveWindows()
  quitting = true
  // Restart and Update's notice says Installing only now (HI-2425): a quit cancelled before this kept its button.
  if (installOnQuit) markInstalling()
  const stopped = sessions.liveCount()
  // Quitting without a dialog (or after waiting): say where the sessions went, as a Windows notification when no Hive
  // window is focused (HI-2320: its windows are closing, so never a pop-up; nothing while you are looking at Hive).
  if (tellUser && stopped > 0) {
    const { title, body, apiTitle, apiTitleText } = closedNotice(stopped)
    tell({ kind: 'quit', title, message: body, apiTitle, apiTitleText, onWindowsClick: () => undefined })
  }
  // The slots' passes (#1628): none starts as the sessions stop (no builder placed), and one running ends before the
  // boards close (will-quit); what it didn't get to is the next start's.
  const slotsQuiet = quitSlotCards()
  // The agents that were working, watching or in a lane (HI-1707): recorded for the next start, and told when Hive is
  // restarting for an update, an install or a restart (an ordinary quit is offered back at the next start instead).
  stopRestartRecovery()
  stopWatchingRestartRequests()
  const reason: RestartReason = quitReason ?? (installOnQuit || installsOnQuit() ? 'update' : relaunchOnQuit ? 'restart' : 'quit')
  await recordClosing(reason).catch((e) => log.warn('recording the agents as Hive closes', e))
  await sessions.stopAllAndWait(3000)
  await quitLeftovers()
  // The stopped runs' slot writers released before the workspaces close (HI-1801): their outcomes are known by now.
  await sessions.writersSettled(3000)
  // The merge queues' runners: their processes ended and their leases given up, so another Hive can run them at once.
  await releaseQueueRunners()
  // Codex's checks (HI-1757): those under way settled, each held one's end tried once more (bounded); what is left ends
  // with its job (kill on close) as Hive exits.
  await stopCodexChecks().catch((e) => log.warn("ending Codex's checks as Hive closes", e))
  await slotsQuiet
  await usageHistory.stop()
  await progress.saveNow().catch(() => undefined)
  await flushMetrics().catch(() => undefined)
  // The close commands (HI-1368), each window's and then When Hive quits, waited for as their panels say.
  await closeCommandsOnQuit(reason === 'update' ? 'update' : 'quit').catch((e) => log.warn('running the close commands as Hive quits', e))
  await config.flush()
  // Apps that find Hive by its discovery file stop looking for this one (#620).
  await clearDiscovery()
  // A downloaded update installs here, at the end of the quit, never for one cancelled (#1647: only over an older copy).
  if (installOnQuit) installNow(true)
  else if (installsOnQuit()) installNow(relaunchOnQuit)
  else {
    if (relaunchOnQuit) relaunch()
    exitBy('app.quit', relaunchOnQuit ? 'quitting to restart' : 'quitting', () => app.quit())
  }
}

/**
 * The close commands as Hive quits (HI-1368): only when a window's workspace or When Hive quits has one; otherwise the
 * quit goes on as before, its databases closed by will-quit. Every window's workspace closes at once, each command run
 * in its window once its saving step is done, then When Hive quits in the last one used: not run if a workspace's close
 * failed, or the user didn't wait for one to finish saving (its Don't wait, the only way past a saving step).
 */
async function closeCommandsOnQuit(reason: CloseReason): Promise<void> {
  const entries = hiveWindows()
  const global = config.settings.commands
  if (!quitRunsAny(entries.map((e) => e.ws), global)) return
  // When Hive quits runs only once every workspace has closed and drained, theirs with a command or not (HR6's round 1).
  // No timer: each window's saving step shows, and its Don't wait is the user's (Darren's decision, 28 Oct ~14:15).
  const drain = quitCommandPlanned(global, reason)
  const outcomes = await Promise.all(entries.map((e) => closeWithCommand(e.ws, reason, e.win, { drain }).catch((err): RunOutcome => (log.warn("closing a window's workspace as Hive quits", err), 'notDrained'))))
  const last = lastFocused() ?? entries[0]
  await runQuitCommand(global, reason, last?.win ?? null, outcomes.includes('notDrained') ? 'failed' : outcomes.includes('leftSaving') ? 'left' : null)
}

/** Starts Hive again once this one has quit, as it was started but for the once-only --disable-gpu. */
function relaunch(): void {
  const args = relaunchArgs(process.argv)
  // A test copy records it instead: a copy of Hive its suite didn't start would outlive the run.
  const record = !app.isPackaged ? process.env.HIVE_TEST_RELAUNCH_LOG : undefined
  if (record) appendFileSync(record, `${JSON.stringify({ args })}
`)
  else exitBy('app.relaunch', 'restarting once this copy has quit', () => app.relaunch({ args }))
}

/**
 * Hive quitting: what agents left running (#507), the sessions just stopped included, is ended as Settings → Agents
 * says, or after asking in a window still shown; otherwise (a quit with no window shown, or to install an update) it
 * keeps running, and stays listed in Hive's profile for the next start to offer again (#614). Test copies ask only with
 * HIVE_TEST_ASK_LEFTOVERS=1.
 */
async function quitLeftovers(): Promise<void> {
  await Promise.race([leftoversSettled(), new Promise((r) => setTimeout(r, 5000))])
  const left = allLeftovers()
  if (left.length) {
    let end = config.settings.agents.leftoverProcesses === 'end'
    // A quiet test copy asks only when its suite says so: a native dialog no suite answers would hold its quit.
    const shown = !testQuiet() || process.env.HIVE_TEST_ASK_LEFTOVERS === '1' ? hiveWindows().find((e) => e.win.isVisible()) : undefined
    const asking = !end && !!shown && !installOnQuit
    if (asking && shown) {
      const n = left.reduce((sum, l) => sum + l.processes.length + l.more, 0)
      const { response } = await dialog.showMessageBox(shown.win, {
        type: 'question',
        title: tr(msg({ id: 'main.quit.dialogTitle', defaultMessage: 'Quit Combwork', description: 'The title of the question, as Hive quits, about the processes agents left running.' })),
        message: tr(msg({ id: 'main.leftovers.quitMessage', defaultMessage: '{n, plural, one {Agents left # process running} other {Agents left # processes running}}', description: 'The question as Hive quits: processes the agents started are still running. {n} is how many.' }), { n }),
        // The processes, a line per agent, then the question.
        detail: `${left.map((l) => `${basename(l.projectPath)} · ${l.agentName}: ${leftoversSummary(l, undefined, { tr, list: fmt.list })}`).join('\n')}\n\n${tr(msg({ id: 'main.leftovers.quitDetail', defaultMessage: '{n, plural, one {The agents started it, and it may hold project folders or ports. End it as Combwork quits, or leave it running?} other {The agents started them, and they may hold project folders or ports. End them as Combwork quits, or leave them running?}}', description: 'The question as Hive quits, under the list of the processes agents left running. {n} is how many.' }), { n })}`,
        buttons: [tr(msg({ id: 'main.leftovers.end', defaultMessage: 'End Them', description: 'Button: ends the processes the agents left running.' })), tr(msg({ id: 'main.leftovers.leave', defaultMessage: 'Leave Running', description: 'Button: leaves the processes the agents left running.' }))],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      })
      end = response === 0
    }
    // Not asked: left running, and still listed for the next start (#614).
    if (end || asking) await settleAllLeftovers(end ? 'end' : 'keep')
  }
  // The runs seen ended, the stopped launches' jobs looked at until empty (at most 5 s), kept (HI-1886): the next start
  // settles their slot writers if their releases aren't written before Hive exits.
  await recordEndedLaunches().catch((e) => log.warn('keeping the ended runs for their slot writers as Hive quits', e))
  await leftoversSaved()
  stopOrphanWatch()
  closeProcessTracking()
}

/**
 * What agents left running before Hive last closed without asking, or crashed (#614): those still running as the same
 * processes are listed again and offered as when an agent stops, or ended, with Settings → Agents → End them.
 */
async function offerRestoredLeftovers(): Promise<void> {
  for (const l of await restoreLeftovers()) {
    if (config.settings.agents.leftoverProcesses === 'end' && (await settleLeftovers(l.projectPath, l.agentId, 'end').then(() => true, () => false))) continue
    const n = l.processes.length + l.more
    // Its buttons act on exactly what it lists (HI-2320).
    const offer = leftoversOffer(l.projectPath, l.agentId)
    toast(
      'warning',
      tr(msg({ id: 'main.leftovers.restoredTitle', defaultMessage: '{n, plural, one {{agent} left # process running} other {{agent} left # processes running}}', description: 'A notice at start: processes an agent started before Hive last closed still run. {agent} is the agent (or project) name; {n} how many.' }), { agent: l.agentName || basename(l.projectPath), n }),
      tr(msg({ id: 'main.leftovers.restoredBody', defaultMessage: "{n, plural, one {{processes}. It was started by the agent before Combwork last closed, and may hold the project's folder or ports.} other {{processes}. They were started by the agent before Combwork last closed, and may hold the project's folder or ports.}}", description: 'The notice at start about processes an agent left running. {processes} lists them ("node serve.js, 2 × tail -f capture.log"); {n} is how many.' }), { processes: leftoversSummary(l, undefined, { tr, list: fmt.list }), n }),
      [
        { label: tr(msg({ id: 'main.leftovers.end', defaultMessage: 'End Them', description: 'Button: ends the processes the agents left running.' })), command: 'session.settleLeftovers', args: [l.projectPath, l.agentId, 'end', offer] },
        { label: tr(msg({ id: 'main.leftovers.keep', defaultMessage: 'Keep Running', description: 'Button: leaves the processes an agent left running.' })), command: 'session.settleLeftovers', args: [l.projectPath, l.agentId, 'keep', offer] }
      ],
      l.projectPath,
      { kind: 'agent', projectPath: l.projectPath, agentId: l.agentId, name: l.agentName || basename(l.projectPath), project: basename(l.projectPath) },
      { offer }
    )
  }
}

/** Archived cards' attachments past their project's days (HI-1842), once a day (also on open: ipc.ts). */
const CARD_CLEANUP_EVERY_MS = 86_400_000

/** Archives Done cards past Settings → Board's days in every open workspace (also on open: ipc.ts). */
function archiveOldDoneEverywhere(): void {
  for (const w of openWorkspaces()) void archiveOldDone(w).catch((e) => log.warn('archiving old Done cards', e))
}

function wireSettingsEffects(): void {
  config.onSettingsChanged((s, prev) => {
    emit({ type: 'settings-changed', settings: s })
    // The developer console's windows follow the theme, and close when developer features are turned off (#637).
    sendToConsoles({ type: 'settings-changed', settings: s })
    if (prev.advanced.showDeveloperFeatures && !s.advanced.showDeveloperFeatures) closeConsoleWindows()
    setDateStyle({ date: s.general.dateFormat, time: s.general.timeFormat })
    // A new language: main's own text at once, then every window, the developer consoles too (#767).
    if (s.general.language !== prev.general.language) {
      void switchLanguage(s).then((language) => {
        if (!language) return
        emit({ type: 'language-changed', language })
        sendToConsoles({ type: 'language-changed', language })
      })
    }
    if (s.board.archiveDoneDays !== prev.board.archiveDoneDays) archiveOldDoneEverywhere()
    if (s.general.launchAtLogin !== prev.general.launchAtLogin) {
      app.setLoginItemSettings({ openAtLogin: s.general.launchAtLogin, args: ['--hidden'] })
    }
    if (s.appearance.theme !== prev.appearance.theme) {
      nativeTheme.themeSource = s.appearance.theme
      for (const e of hiveWindows()) {
        setTitleBarColors(e.win, titleBarColors())
      }
    }
    const refreshAll = (): void => {
      for (const w of openWorkspaces()) w.scheduleRefresh()
    }
    if (JSON.stringify(s.agentApi) !== JSON.stringify(prev.agentApi)) void startApiServer().then(refreshAll)
    // Session settings changed: refresh "restart to apply", and offer to switch running agents to a new permission mode.
    else if (JSON.stringify(s.providers) !== JSON.stringify(prev.providers) || JSON.stringify(s.assistant) !== JSON.stringify(prev.assistant)) refreshAll()
    for (const p of PROVIDERS) {
      const now = providerSettings(s, p.id)
      const before = providerSettings(prev, p.id)
      if (before.enableDangerousMode && !now.enableDangerousMode) void revertDangerousModes(p.id)
      if (JSON.stringify([now.prices, now.pricesRemoved, now.costSource]) !== JSON.stringify([before.prices, before.pricesRemoved, before.costSource])) {
        sessions.clearUsageCache()
        void sessions.repriceLive()
      }
      if (now.executablePath !== before.executablePath || (now.enabled && !before.enabled)) void providerService.refresh(p.id, now.enabled)
    }
  })
}

/** A provider's no-guardrails modes were turned off: projects and agents set to any of them (in every window) go back to Inherit. */
async function revertDangerousModes(provider: string): Promise<void> {
  const desc = PROVIDERS.find((d) => d.id === provider)
  const danger = desc ? dangerModes(desc) : []
  if (!danger.length) return
  const isDanger = (mode: string | undefined): boolean => danger.some((m) => m.value === mode)
  const changed: string[] = []
  for (const w of openWorkspaces()) {
    for (const p of await w.listProjectPaths()) {
      const cfg = await workspace.projectConfig(p)
      let touched = false
      if (isDanger(projectProviderConfig(cfg, provider).permissionMode)) {
        await workspace.mutateProjectConfig(p, (now) => ({ providers: { ...now.providers, [provider]: { ...projectProviderConfig(now, provider), permissionMode: 'inherit' } } }))
        touched = true
      }
      for (const a of projectAgents(cfg)) {
        if (isDanger(a.permissionMode)) {
          await workspace.updateAgent(p, a.id, { permissionMode: undefined })
          touched = true
        }
      }
      if (touched) changed.push(basename(p))
    }
  }
  if (changed.length) {
    toast(
      'warning',
      tr(msg({ id: 'main.danger.off', defaultMessage: '{modes} turned off', description: "A notice after a provider's dangerous permission modes were turned off in Settings. {modes} lists them." }), { modes: labelList(danger.map((m) => m.label)) }),
      tr(msg({ id: 'main.danger.offBody', defaultMessage: 'These projects were switched back to Inherit: {projects}. Running sessions keep their mode until restarted.', description: "The notice after dangerous permission modes were turned off: the projects that used one. Inherit is a choice of the project's settings: keep it as Hive shows it." }), { projects: fmt.list(changed) })
    )
  }
}

/** Damaged settings or records found before a window can show them (config.json at startup) wait here. */
const corruptReports: [string, string, boolean][] = []
let reportsReady = false
function showCorrupt(file: string, aside: string, restored: boolean): void {
  log.warn(`${userText(file)} could not be read; set aside as ${userText(aside)}${restored ? ', restored from its .bak copy' : ''}`)
  toast(
    restored ? 'warning' : 'error',
    restored ? tr(msg({ id: 'main.corrupt.restored', defaultMessage: '{file} was damaged and has been restored', description: "A notice: one of Hive's settings or record files couldn't be read, and Hive went back to its last good copy. {file} is its name." }), { file: basename(file) }) : tr(msg({ id: 'main.corrupt.damaged', defaultMessage: '{file} was damaged', description: "A notice: one of Hive's settings or record files couldn't be read. {file} is its name." }), { file: basename(file) }),
    restored ? tr(msg({ id: 'main.corrupt.restoredBody', defaultMessage: 'Combwork went back to its last good copy. The damaged file was kept as {aside}.', description: 'The notice about a damaged file Hive restored. {aside} is where the damaged file was kept.' }), { aside }) : tr(msg({ id: 'main.corrupt.defaultsBody', defaultMessage: 'Combwork had no good copy, so it started from defaults. The damaged file was kept as {aside}.', description: 'The notice about a damaged file Hive had no good copy of. {aside} is where the damaged file was kept.' }), { aside }),
    undefined,
    file
  )
}
/** What the board says as it moves the cards' files into its database, or finds cards an older Hive saved (#1017). */
onBoardNotice((path, n) => {
  if (n.kind === 'imported') {
    if (!n.damaged.length) return
    toast('warning', tr(msg({ id: 'main.board.damagedTitle', defaultMessage: "{n, plural, one {# card file couldn't be read} other {# card files couldn't be read}}", description: "A notice as Hive moved the board's cards into its database: some card files weren't valid. {n} is how many." }), { n: n.damaged.length }), tr(msg({ id: 'main.board.damagedBody', defaultMessage: '{files} stayed out of the board. They are kept in {folder}.', description: "The notice about card files Hive couldn't read as it moved the board into its database: {files} lists them, {folder} is where they are kept." }), { files: fmt.list(n.damaged.slice(0, 5), 'unit'), folder: join(path, '.hive', n.folder) }), undefined, 'board')
  } else {
    toast('warning', tr(msg({ id: 'main.board.foundTitle', defaultMessage: '{n, plural, one {# card made by an older Combwork was found: review it} other {# cards made by an older Combwork were found: review them}}', description: "A notice: this workspace was opened in an older Hive meanwhile, and it saved cards; they weren't added to the board, but kept for the user to review. {n} is how many." }), { n: n.cards }), tr(msg({ id: 'main.board.foundBody', defaultMessage: 'They are kept, unchanged, in {folder}. Nothing on the board was changed for them: Review… adds each to the board or discards it.', description: 'The notice about cards an older Hive saved: {folder} is the folder where they are kept.' }), { folder: join(path, '.hive', n.folder) }), [{ label: tr(msg({ id: 'main.board.review', defaultMessage: 'Review…', description: "A button on the notice about cards an older Hive saved: opens a dialog listing them, to add each to the board or discard it." })), command: 'task.reviewSetAside' }], 'board')
  }
})

onCorruptFile((file, aside, restored) => (reportsReady ? showCorrupt(file, aside, restored) : void corruptReports.push([file, aside, restored])))

/** What Hive's windows may use: the clipboard (paste, copy). Everything else web pages can ask for is refused. */
const ALLOWED_PERMISSIONS = new Set(['clipboard-read', 'clipboard-sanitized-write'])

app.whenReady().then(async () => {
  config.load()
  // Server connections' key masking (HI-1772): what is known at once, then the fingerprints read (strict meanwhile).
  startCoverage()
  void loadCoverage()
  // Before anything shows text: notifications, the tray and dialogs in the user's language (#767).
  await startI18n(config.settings)
  // Advanced settings (#367): advanced.json's overrides, followed as it changes.
  advanced.load()
  // Agents per project from before HI-2001: Maximum agents in Hive's workflow defaults now.
  await migrateAgentsPerProject()
  // HI-1997: Hive's own workflow defaults' commit message from a preset, switched once to the branch's own.
  await settleGlobalCommitMessage()
  // Show developer features is one of them too, kept under its settings key: the file and the setting stay one value.
  bindAdvancedSettings(config)
  // The developer console's flight recorder (#698): its triggers are advanced settings, followed as they change.
  flightRecorder.start((source) => sessions.flightAgent(source))
  session.defaultSession.setPermissionRequestHandler((_wc, permission, done) => done(ALLOWED_PERMISSIONS.has(permission)))
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission))
  protocol.handle('hive-img', async (req) => {
    let p = resolve(decodeURIComponent(new URL(req.url).pathname.slice(1)))
    if (!SERVABLE_EXT.test(p) || insideArchive(p) || !workspace.isAllowedPath(p)) return new Response('Not found', { status: 404 }) // i18n-ignore: an HTTP reply to the window, never shown
    // Read with original-fs, never Electron's file: loader, which would open an archive on the path and keep it (#246, #261).
    let st = await stat(p).catch(() => null)
    // A path into the old .hive/images serves the file where it is now, in .hive/attachments (#387).
    const moved = st ? null : await movedAttachment(p)
    if (moved && workspace.isAllowedPath(moved)) {
      st = await stat(moved).catch(() => null)
      p = moved
    }
    if (!st?.isFile()) return new Response('Not found', { status: 404 }) // i18n-ignore: an HTTP reply to the window, never shown
    return new Response(Readable.toWeb(createReadStream(p)) as ReadableStream, { headers: { 'Content-Type': servableType(p), 'Content-Length': String(st.size) } })
  })
  nativeTheme.themeSource = config.settings.appearance.theme
  // Launch at login for this exe (HI-2460: an update can move it), when it is on.
  syncLoginItemAtStart(config.settings.general.launchAtLogin)
  setDateStyle({ date: config.settings.general.dateFormat, time: config.settings.general.timeFormat })
  Menu.setApplicationMenu(null)
  // Says the log marks the user's own text (userText()), so Copy Diagnostics can tell this run's lines from older ones.
  log.info(`Hive ${app.getVersion()} starting (Electron ${process.versions.electron}; ${MARKED_LOG})`)
  for (const line of profileLines) log.info(line)
  logCrashDumps()
  // The last run's marker (#984): still there, it ended without quitting; then this run's own.
  // The agents a restart or quit recorded (HI-1707), read first: the unexpected-close notice leaves those to it.
  loadRestartRecord()
  // A team pause is this run's only (HI-2156): what an earlier build saved of one goes, and Hive starts unpaused.
  clearSavedPauses()
  checkLastRun()
  startRunMarker()
  initRestartRecovery()
  // Agents whose turn a dropped connection ended, resumed once it is back (HI-1612; Settings → Advanced, off by default).
  startOutageResume()
  // An agent waiting long to retry its model request: the Assistant told (HI-1973).
  startRetryNotice()
  // An installer asking Hive to close for an install (installer.nsh): the agents are recorded and told, then Hive quits.
  watchRestartRequests(() => {
    quitReason = 'install'
    void quitNow(false)
  })
  // The main process's memory, now and every 5 minutes, and a snapshot before it runs out if the setting says so (#1005).
  startMemoryLog()
  startHeapSnapshots(app.getPath('userData'), heapSnapshots)
  watchMainStalls()
  // A replace that gave up because the file was held says which processes had it open (HI-1749).
  renameDiagnostics.holders = fileHolders
  setInterval(archiveOldDoneEverywhere, 3_600_000).unref()
  setInterval(queueCleanupEverywhere, CARD_CLEANUP_EVERY_MS).unref()

  // Each agent's start as main's stall check reads it (HI-1977), so the board's Stalled mark agrees; a change is told at
  // once, before the card's move it comes with (a refresh of the project came after it, and the mark showed meanwhile),
  // and the project read again so its kept info (a window loading it) has it too.
  workspace.setLiveProvider(async (p, cfg, scope) => withAgentStarts(p, await sessions.liveInfo(p, cfg, scope)))
  onAgentStartChange((p, agentId) => {
    emit({ type: 'agent-start', projectPath: p, agentId, start: agentStartOf(p, agentId) ?? null, seq: startSeq() })
    workspaceFor(p)?.scheduleRefresh()
  })
  sessions.apiEnv = apiEnv
  // hive-progress on every session's PATH (#137): shims in Hive's bin folder, timings beside them.
  void installShims(join(app.getPath('userData'), 'bin'), { exec: process.execPath, script: unpackedScript('hive-progress.js'), data: join(app.getPath('userData'), 'progress') }).then((dir) => {
    sessions.binDir = dir
    if (!dir) log.warn("Couldn't write the hive-progress command into Hive's bin folder; sessions start without it")
  })
  /** Tests only (development builds): where the hive MCP servers log the calls they ran (tests/scenarios). */
  const testMcpLog = (): Record<string, string> => (!app.isPackaged && process.env.HIVE_TEST_MCP_LOG ? { HIVE_TEST_MCP_LOG: process.env.HIVE_TEST_MCP_LOG } : {})
  sessions.hiveMcp = (projectPath, agentId): McpServerDef | null => {
    const s = config.settings.agentApi
    // The Hive Assistant always has Hive's tools, with its own token and its control level (Settings → Assistant).
    if (workspace.isAssistantHome(projectPath)) {
      const url = assistantApiUrl()
      const ws = workspaceOf(projectPath).path
      if (!url || !ws) return null
      return {
        command: process.execPath,
        args: [hiveMcpScript()],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          HIVE_API_URL: url,
          HIVE_API_TOKEN_FILE: assistantTokenFile(ws),
          HIVE_PROJECT: '',
          HIVE_WORKSPACE: ws,
          HIVE_ROLE: 'assistant',
          HIVE_ASSISTANT_CONTROL: config.settings.assistant?.control ?? 'projects',
          // Its settings tool (hive_update_setting) is offered only with Change settings on: a change restarts it.
          HIVE_ASSISTANT_SETTINGS: config.settings.assistant?.changeSettings === true ? '1' : '0',
          // Its journal's tools (#1031) only while the journal is on: a change is told to it, and applies at its next start.
          HIVE_JOURNAL: journalSettingsOf(workspaceOf(projectPath)).enabled ? '1' : '0',
          // What it may store, for its session contract's journal rule (#1032).
          HIVE_JOURNAL_SCOPE: journalSettingsOf(workspaceOf(projectPath)).scope.join(','),
          // The developer console's tool (hive_console) is offered only while Settings → Agent API lets agents read it.
          HIVE_DEV_CONSOLE: config.settings.agentApi.devConsole === true ? '1' : '0',
          ...mcpAdvancedEnv(),
          ...testMcpLog()
        }
      }
    }
    const url = assistantApiUrl()
    if (!s.enabled || !s.provideHiveMcp || !url) return null
    return {
      command: process.execPath,
      args: [hiveMcpScript()],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        HIVE_API_URL: url,
        // The agent's own token (made at each launch), which confines its board calls to its project.
        HIVE_API_TOKEN_FILE: agentId ? agentTokenFile(projectPath, agentId) : '',
        // The Assistant looks after the whole workspace: its tools have no project of their own.
        HIVE_PROJECT: workspace.isAssistantHome(projectPath) ? '' : basename(projectPath),
        // With several windows, the API answers the session's tools for its own workspace.
        HIVE_WORKSPACE: workspaceOf(projectPath).path ?? '',
        // Which agent's tools these are: Hive names it as the author of the handovers it writes.
        ...(agentId ? { HIVE_AGENT_ID: agentId } : {}),
        // Whether its instructions tell it to run long commands through hive-progress unasked.
        HIVE_PROGRESS_COMMANDS: wrapsLongCommands(config.settings.general) ? '1' : '0',
        // Whether it gives Hive's guidance as its instructions (#1285: Settings → Advanced, Hive's guidance for agents).
        HIVE_GUIDANCE: advanced.get<boolean>(HIVE_GUIDANCE) ? '1' : '0',
        HIVE_DEV_CONSOLE: s.devConsole === true ? '1' : '0',
        // Its reply timeout and wait caps (#367: Settings → Advanced).
        ...mcpAdvancedEnv(),
        ...testMcpLog()
      }
    }
  }
  // The hive MCP server's instructions, for providers that don't show MCP instructions to the model (Codex).
  initWatches()
  initLoopWakes()
  initLoopCheck()
  initDeliveries()
  initReviewsOnOpen()
  // Hive's skill copies in folders no session of Hive's works in (#1431), as each workspace opens.
  initSkillCopies((folder) => sessions.runningIn(folder))
  initInboxNotices()
  // What agents' commands leave running while they run (HI-2111).
  startOrphanWatch()
  initDecisionWakes()
  initWorkflowNotices()
  initDevConsole()
  initAssistantModes()
  // A watcher stops keeping a pending quit waiting when the card it waits on leaves another agent's work (no wake comes).
  onWatchedCardsMoved(() => checkPendingQuit())
  sessions.hiveGuidance = (projectPath) =>
    inWorkspace(workspaceOf(projectPath), async () => {
      if (!sessions.hiveMcp(projectPath)) return ''
      if (workspace.isAssistantHome(projectPath)) {
        const journal = journalSettingsOf(workspaceOf(projectPath))
        return hiveInstructions('', 'assistant', true, undefined, journal.enabled ? journal.scope : null)
      }
      // Hive's tools without its guidance (#1285, #966 row 13): the Assistant above always has its own.
      if (!advanced.get<boolean>(HIVE_GUIDANCE)) return ''
      const project = basename(projectPath)
      const latest = (await handoversFor(workspace, project))[0]
      // Naming only the skills its agents get (#1431).
      const off = new Set([...offNames(workspace.config.skillDelivery), ...offNames((await workspace.projectConfig(projectPath)).skillDelivery)])
      return withLatestHandover(hiveInstructions(project, 'agent', wrapsLongCommands(config.settings.general), off), latest?.relPath)
    })
  // The Assistant's state view at each start and after each compaction, while its journal is on (#1032).
  sessions.startContext = async (state, source) => {
    if (!workspace.isAssistantHome(state.projectPath)) return null
    const view = await assistantStartView(workspaceOf(state.projectPath), sessions.liveStates(), source)
    // Tests only (development builds): each view Hive gave, whatever the CLI does with it (tests/scenarios).
    if (view && !app.isPackaged && process.env.HIVE_TEST_START_VIEW_LOG) await appendFile(process.env.HIVE_TEST_START_VIEW_LOG, JSON.stringify({ at: new Date().toISOString(), provider: state.provider, source, text: view }) + '\n').catch(() => undefined)
    return view
  }
  sessions.recentHandovers = (projectPath, count) =>
    inWorkspace(workspaceOf(projectPath), async () => {
      const recent = (await handoversFor(workspace, basename(projectPath))).slice(0, count)
      return Promise.all(
        recent.map(async (h) => ({ relPath: h.relPath, modified: h.modified ?? '', session: handoverSession(await readFile(join(workspace.sharedDir, h.relPath), 'utf8').catch(() => '')) }))
      )
    })
  // Each Assistant launch gets a new token; each message to it starts a new turn (with a fresh limit of changes).
  sessions.onAssistantLaunch = async (projectPath) => {
    const ws = workspaceOf(projectPath).path
    if (ws) await newAssistantToken(ws)
  }
  sessions.onAssistantPrompt = (projectPath) => {
    const ws = workspaceOf(projectPath).path
    if (ws) newTurn(ws)
  }
  // When it stops, its token stops working and its questions are withdrawn (its workspace may be closed by now).
  sessions.onAssistantExit = (projectPath) => {
    const ws = resolve(projectPath, '..', '..')
    if (assistantHome(ws).toLowerCase() === resolve(projectPath).toLowerCase()) endAssistant(ws)
  }
  // The Assistant's role and mode (its workspace's choice, else Settings → Assistant's), for its launches.
  sessions.assistantInstructions = (projectPath, agent) => inWorkspace(workspaceOf(projectPath), () => assistantInstructions(assistantModeId(agent, config.settings), config.settings.assistant?.control ?? 'projects', config.settings.assistant?.changeSettings === true))
  // A project's notifications and focus checks use the window showing it.
  sessions.setWindowProvider((projectPath) => (projectPath ? windowForPath(projectPath)?.win : null) ?? lastFocused()?.win ?? null)
  // The one notification system's windows (HI-2320): the one the user is using (visible, not minimised, focused) owns
  // what is told; with none, the one showing the entry's workspace (or a source path's), else the last focused.
  setNotifyHost({
    focused: () => {
      const e = hiveWindows().find((x) => !x.win.isDestroyed() && x.win.isVisible() && !x.win.isMinimized() && x.win.isFocused())
      return e ? { win: e.win, workspacePath: e.ws.path, projectPath: e.showing } : null
    },
    fallback: (projectPath, source) => (projectPath ? windowForPath(projectPath) : null)?.win ?? (source && /[\\/]/.test(source) ? windowForPath(source)?.win : null) ?? lastFocused()?.win ?? null,
    workspaceOf: (projectPath) => workspaceOf(projectPath)?.path ?? null,
    // A result of a window's request is told in that window (HI-2355).
    requester: requestingWindow,
    // A toast's source that is a project (its folder): the entry's link (HI-2320).
    projectAt: (p) => {
      try {
        return workspaceOf(p)?.info()?.projects.find((x) => x.path.toLowerCase() === p.toLowerCase())?.path ?? null
      } catch {
        return null
      }
    }
  })
  // An agent no longer waiting for you: its entries say so, in whichever window owns them.
  startNoticeResolver()
  providerService.setLiveSessionCounter((p) => sessions.liveCount(p))
  // Agents stopped by a refused sign-in can carry on once the CLI is signed in again (#309).
  providerService.onSignedIn((p) => sessions.signedInAgain(p, true))
  // Connections (HI-980, HI-1755): new workspaces' defaults and the watches on their logins. Waited for: their order's
  // one-time move (HI-1875) is done before any workspace opens or the Agent API starts.
  await initConnections()
  initConnectionMoves()
  initUsageMoves()

  // Hook auth files of an earlier run of Hive: their tokens died with it (#345).
  await clearHookAuth()
  // A launch's side of the workflow for its metrics (HI-2049): before the Agent API or a window can start an agent.
  startLaunchSides()
  await startHookServer()
  // After an unexpected close, its port is tried again for a few seconds (HI-2196): the copy just ended may still hold
  // it. Awaited, so the agents resumed after it launch with the API's address.
  await startApiServer({ retryInUse: !!lastUnexpectedClose() })
  wireSettingsEffects()
  startBranchWatch()
  // The platform watcher (#1214): the open workspaces' repositories and folders.
  startObserving()
  // What it sees reconciled with the cards' facts: recorded (#1217), and acted on with the rules enforced (#1263).
  startReconciling()
  // A workspace closing gives up its merge queues' leases (#1360): their processes ended, then their rows deleted.
  WorkspaceService.closingTasks.add((path) => releaseQueueRunners((r) => !!r.cfg.workspace && r.cfg.workspace.toLowerCase() === path.toLowerCase()))
  // The merge queue (#1348): a host per project and target, started by enqueue actions and as workspaces open.
  startQueueHosts()
  // The slot pools (#1429): their idle slots tidied every hour.
  startSlots()
  // Unused Worktrees reads the slots through those pools (#1450, #1519).
  setSlotPools(poolFor)
  // …and asks whether a merge queue still needs a folder it kept (#1644): no workflow known, it does.
  setQueueNeed(async (ws, projectPath, target) => {
    const wf = await workflowFor(ws, projectPath)
    return wf ? queueFolderNeeded(wf, target) : true
  })
  // Cards on slots (#1438): a start lends its builder a slot and makes its line there, Done or put back gives it back.
  startSlotCards()
  startFinishPath()
  // Lanes' briefs outside slots, delivered once per revision (HI-1795).
  startLaneBriefs()
  // Agents' worktrees adopted as slots at the 1.0 upgrade (#1441): which projects are migrated, and their retired homes.
  startSlotMigration()
  startReviewerPool()
  // The nudge to start fresh when a project's work has finished (#1437).
  startFreshNudges()
  // Review and check copies (#1435): returning ones looked at again every 30 s, idle ones tidied every hour.
  startCopies()
  startReviewCopies()
  // The queue's order as agents read it (#1354): this Hive's entry testing now, at its step.
  setQueueLive(queueLive)
  // An agent's branch brought up to date between a lane's cards after a squash merge (#1271, SPEC §16.19.2), once the
  // agent is idle: in a turn (working, starting, asking a permission, its background tasks running) or given a prompt
  // its CLI hasn't taken yet, it is busy.
  setAgentBusy((project, agent) => {
    const now = sessions.agentNow(project, agent)
    return !!now && (now.pending || ['starting', 'working', 'waiting', 'background'].includes(now.status))
  })
  startLineUpdates()
  // G16 (#1481): each agent's file locks recorded on its current card.
  startLockRecords()
  // What an agent has going, which its submission waits for with "its own runs stopped" (#1265, G13): its open
  // Progress runs and its CLI's background tasks.
  setRunsGoing((project, agent) => {
    const p = project.toLowerCase()
    const runs = openWorkspaces().flatMap((w) => (w.path ? progress.list(w.path) : [])).filter((r) => r.source === 'agent' && r.agentId === agent && r.projectPath?.toLowerCase() === p && isOpenRun(r))
    const tasks = sessions.agentNow(project, agent)?.backgroundTasks ?? 0
    return [...runs.map((r) => r.title), ...(tasks ? [`its background tasks (${tasks})`] : [])] // i18n-ignore: agent-facing: what a refused submit names
  })

  // A review in progress holds another agent's start of it while its reviewer's session runs (HI-2487).
  setAgentRunning((project, agent) => {
    const now = sessions.agentNow(project, agent)
    return !!now && now.status !== 'stopped' && now.status !== 'error'
  })

  // A review waiting on its builder's Progress run for the card isn't stalled (HI-1993).
  setStallRuns((wsPath) => progress.list(wsPath))

  // The usage history (#1106): its tick for running sessions; each workspace's import starts as it opens.
  usageHistory.start()
  registerIpc(appInfo, {
    quit: () => void requestQuit(),
    restart: () => void requestQuit({ intent: 'restart' }),
    decide: (from, choice, dontAskAgain) => {
      const e = hiveWindows().find((x) => x.win === from)
      if (dontAskAgain && (choice === 'now' || choice === 'wait') && e?.question?.scope === 'app') config.updateSettings({ general: { confirmOnQuit: 'never' } })
      e?.question?.answer(choice)
    },
    cancelPending: cancelPendingQuit,
    state: (from) => {
      const q = hiveWindows().find((x) => x.win === from)?.question
      return { request: q?.request ?? null, unsaved: q?.unsaved ?? [], scope: q?.scope ?? 'app', pending: pendingQuit, working: pendingQuit ? workingCount() : 0 }
    },
    setUnsaved: (from, paths) => {
      const e = hiveWindows().find((x) => x.win === from)
      if (e) e.unsaved = paths
    },
    stopWorkspaceAgents,
    newWindow: () => {
      createWindow()
      saveWindowsSoon()
    }
  })

  // Keeps the PC awake while agents work, backs up transcripts when Windows shuts down, refreshes after sleep.
  startPowerWatch()
  startTaskbarFlash()
  // Long runs agents report (the Progress panel): stale runs, and the setting.
  startProgress()
  startMergeSlots()
  startLanes()
  // A lane's next card, started on its builder once the card before it is Done (HI-1990).
  startLaneStarts()
  startHandOverCheck()
  // Test builds can record the taskbar's progress calls, which the page can't see.
  if (!app.isPackaged && process.env.HIVE_TEST_TASKBAR_LOG) {
    const file = process.env.HIVE_TEST_TASKBAR_LOG
    setTaskbarTestHook((ws, bar) => appendFileSync(file, `${JSON.stringify({ ws, ...bar })}\n`))
  }
  const hidden = config.settings.general.startMinimized || process.argv.includes('--hidden')
  const restore = windowsToRestore()
  for (const w of restore) createWindow({ ...w, hidden })
  // A workspace reopening (#1155): the process tracker gets going beside the windows' loading, so a Resume as soon as
  // they show doesn't wait for it. A workspace opened later starts it once it shows agents (below).
  if (restore.some((w) => w.workspacePath)) warmProcessTracking()
  // The last restored window is on top: it counts as focused first.
  const first = hiveWindows()[0]
  first?.win.webContents.once('did-finish-load', () => {
    // Give the page a moment to subscribe to events.
    setTimeout(() => {
      reportsReady = true
      for (const r of corruptReports.splice(0)) showCorrupt(...r)
      void offerRestoredLeftovers().catch((e) => log.warn('offering what agents left running before Hive restarted', e))
      void tellUnexpectedClose().catch((e) => log.warn('telling Hive closed unexpectedly', e))
      void startRestartRecovery().catch((e) => log.warn('resuming the agents a restart recorded', e))
      void startProfileNotices().catch((e) => log.warn('telling which profile folders Hive uses', e))
    }, 1500)
  })
  if (!first) {
    void offerRestoredLeftovers().catch((e) => log.warn('offering what agents left running before Hive restarted', e))
    void tellUnexpectedClose().catch((e) => log.warn('telling Hive closed unexpectedly', e))
    void startRestartRecovery().catch((e) => log.warn('resuming the agents a restart recorded', e))
    void startProfileNotices().catch((e) => log.warn('telling which profile folders Hive uses', e))
  }
  createTray(() => lastFocused()?.win ?? null, {
    quit: () => void requestQuit(),
    // While a quit waits, Quit Now still asks about files edited since (HI-2336).
    quitNow: () => void (pendingQuit ? finishPendingQuit() : quitNow(true)),
    cancelPendingQuit
  })
  onHiveEvent((e) => {
    if (e.type === 'session-status' || e.type === 'session-exit') checkPendingQuit()
    // A window opened or closed its workspace: remember it for the next start.
    if (e.type === 'workspace-changed') saveWindowsSoon()
    // A workspace with agents to start (#1155): the process tracker gets going now, not as the first of them starts.
    if (e.type === 'workspace-changed' && e.workspace && (e.workspace.projects.some((p) => p.agents.length) || e.workspace.assistant?.agents.some((a) => a.resume))) warmProcessTracking()
    // A CLI's installed version: what a CLI-facing advanced override is made for, and flagged against (#367).
    if (e.type === 'provider-install' && !e.info.checking) advanced.noteCli(e.provider, e.info.found ? (e.info.version ?? null) : null)
    // A card moved to Doing (or was given to a running agent): its session records it.
    if (e.type === 'tasks-changed') void recordLiveCardsSoon(e.workspacePath, () => sessions.liveStates())
    // A reviewer whose session ended isn't reviewing any more: its cards stop showing it.
    if (e.type === 'session-exit') void endExitedReviews(e.projectPath, e.agentId)?.catch((err) => log.warn('ending the reviews of a session that ended', err))
  })
  initUpdater({
    restart: () => void requestQuit({ intent: 'update' })
  })
  void providerService.refresh()
  void checkGit()
})

// A file picked to import in the Dialects view is its window's (HI-2444): gone when the window closes.
app.on('browser-window-created', (_e, w) => {
  const id = w.id
  w.on('closed', () => forgetPicks({ window: id }))
})
app.on('second-instance', () => {
  const w = lastFocused()
  if (w) showWindow(w.win)
})

app.on('before-quit', (e) => {
  if (!quitting) {
    e.preventDefault()
    void requestQuit()
  }
})

app.on('will-quit', () => {
  // Any other way out (the updater's install, a renderer crash's quit) clears it too.
  clearDiscoveryNow()
  killAll()
  stopOrphanWatch()
  closeProcessTracking()
  unwatchAll()
  stopObserving()
  stopReconciling()
  stopQueueHosts()
  stopSlotCards()
  stopLaneBriefs()
  stopSlotMigration()
  stopReviewerPool()
  stopSlots()
  stopCopies()
  stopReviewCopies()
  flightRecorder.stop()
  advanced.stop()
  destroyTray()
  // The boards' databases: checkpointed and closed, the stubs older versions read brought up to date (#1017).
  closeAllBoards()
  closeAllJournals()
})

app.on('window-all-closed', () => {
  // Hive lives in the tray; quitting is explicit.
})
