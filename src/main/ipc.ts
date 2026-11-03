import { pickUpBuilds } from './buildFacts'
import { checkDocRef } from './docSections'
import { legacyWorktree } from '../shared/agentFolders'
import { BrowserWindow, ClipboardItem, app, clipboard, dialog, ipcMain, nativeImage, shell } from 'electron'
import { freemem, totalmem } from 'os'
import { AsyncLocalStorage } from 'async_hooks'
import type { WebContents } from 'electron'
import { existsSync } from 'original-fs'
import { basename, dirname, isAbsolute, join, resolve } from 'path'
import { readFile } from 'original-fs/promises'
import type { HiveChannel, HiveRequests } from '../shared/api'
import * as updater from './updater'
import type { LaneStartRequest, MergeResult, ProviderId, QuitChoice } from '../shared/types'
import { instructionFiles, instructionsShared, shareInstructions, SHARED_INSTRUCTIONS, type InstructionsFile } from '../shared/instructions'
import { extraArgsProblem, isKnownProvider, providerDescriptor } from '../shared/providers'
import { isProjectPref, projectPrefValue, withProjectPref } from '../shared/uiPrefs'
import { applyBoardFold } from '../shared/tasks'
import { keptLaneOrder } from '../shared/laneBar'
import { EMPTY_TIPS_STATE, applyTipsChange, tipsChange, tipsState } from '../shared/tips'
import { allProviders } from './providers'
import { providerService } from './providerService'
import { connectionInput, type ConnectionPatch } from '../shared/accounts'
import { accountsView, addAccount, addConnection, connectionHomes, duplicateConnection, moveConnectionInAccount, removeConnection, updateConnection, dismissConnectionsIntro, keepNewLogin, removeAccount, renameAccount, setUsageMove, moveConnection, setAccountOn, setUpPlace, setUpSignInConnection, signInAccount, getAccount, isServer } from './accounts'
import { addServerConnection, cancelServerModels, editServerConnection, readServerModels, removeServerKey, setServerKey, setUpServerConnection } from './serverConnections'
import { requireMasking } from './keyCoverage'
import { resetMasking } from './keyStore'
import { maskDeep, maskKeys } from './keyMatcher'
import { dismissMovedNotice, movedNotice } from './connectionMoves'
import { config } from './config'
import { clearRecent, recentChanged, recentFor, removeRecent } from './recentWorkspaces'
import { emit, emitTo, onHiveEvent } from './events'
import { setPinned } from './pin'
import { presentWindow } from './testQuiet'
import { insideArchive, insideReal, isFile, samePlace, writeTextAtomic, writeTextUnlessChanged } from './fsutil'
import { gitDiff, gitStatus } from './git'
import { compareBranches, compareDiff, compareLines } from './gitCompare'
import { initCheck, initRepo } from './gitInit'
import { addRemote, branchDrops, branchUpdatePlan, createBranch, createTag, deleteBranches, deleteRemoteBranches, fetchAll, pull, push, pushToRemote, remoteTracking, removeRemote, renameRemote, leftoverInfo, repoHistory, repoInfo, repoSummary, setIdentity, setRemoteUrl, setUpstream, switchBranch, updateBranch, workTargetOf } from './gitRepo'
import { checkGit, gitTool } from './gitTool'
import { refreshPath, refreshPathBeforeStart } from './freshPath'
import { openExternalTerminal } from './externalTerminal'
import { hiveWorktreeOf, mergeUnused, removalPreview, removeUnusedWorktree, unusedBranchOf, unusedBranchStatus, unusedWorktrees } from './unusedWorktrees'
import { branchMergeStatus, lineCard, lineConfirmed, mergeBranch, mergeBranches } from './branchMerge'
import { createLogger, logsDir, userText } from './logger'
import { closeCommandsRun, closeCommandState, closeWithCommand, controlRun, dismiss, dontWait, runByHand, runOpenCommands } from './closeCommand/closeCommands'
import { cleanHive, cleanWorkspace } from '../shared/commands'
import { diagnostics } from './diagnostics'
import { resumeAfterClose, startupStep, stopLeftAfterClose } from './lastRun'
import { keepProfileBackups, removeProfileBackups } from './profileMoveNotices'
import { dismissOffered, resumeOffered, workspaceRecovering } from './restartResume'
import { keepAwakeCount } from './power'
import { progress, progressSeq } from './progressService'
import { mergeSlots, recoverMergeSlots, workspaceSlots } from './mergeSlotHost'
import { followNames } from './projectRename'
import { slotBranch } from './mergeSlots'
import { endLane, listLanes, stampLaneProjects } from './lanes'
import { laneStartInfo, oweFreshForTest, retryFreshStart, startLaneFromWindow } from './laneStart'
import { loopChecksOf } from './loopCheck'
import { sweepWorkspaceLeftovers } from './leftovers'
import { AfterOpen, assertNotOpening, claimWindow, openProgress, openStep, releaseWindow, windowClaim } from './openProgress'
import { boardState, boardWaits, cardHeads, exportBoard, movedNames, onBoardUpgraded, projectKeys, restoreBoardBackup, upgradeBoard } from './boardStore'
import { cardCosts, cardRoundCosts, laneCosts } from './cardCosts'
import { badgeDescription } from '../shared/taskbar'
import * as files from './files'
import * as mcp from './mcp'
import * as mcpCatalog from './mcpCatalog'
import * as notes from './notes'
import * as removal from './projectRemoval'
import * as tasks from './tasks'
import { changeProjectKey, createProjectWithKey, keyProjects, sayKeysOnce } from './projectKeys'
import { startTask } from './taskStart'
import * as assistantControl from './assistantControl'
import { revertSetting } from './settingsTools'
import { finalWhys } from '../shared/assistantActivity'
import { changeGroups } from './assistantChanges'
import { UndoNotFound, userUndo } from './assistantUndo'
import { advanced, resetSettingsChecked, updateSettingsChecked } from './advanced'
import type { AdvancedState } from '../shared/advanced'
import { switchMode } from './assistantMode'
import * as modes from './modes'
import { syncBundled } from './bundled'
import { checkMoved, finishPending, movePlan, repairMove } from './workspaceMove'
import { missingWorktree, recreateWorktree, unlinkMissingWorktree } from './agentWorktree'
import { projectAgents as agentsOf } from '../shared/defaults'
import type { MoveOptions, TaskCard } from '../shared/types'
import { killPty, ptyBuffer, ptySize, resizePty, writePty } from './ptyHost'
import { apiInfo, createViewer, regenerateToken, revokeViewer } from './servers'
import * as projectAgents from './projectAgents'
import * as templates from './templates'
import * as branchWatch from './branchWatch'
import { sessions } from './sessions'
import { activityCardAgents, activityNowAll, launchesNow } from './activityWorkspace'
import { usageHistory } from './usageHistory'
import { noticeActionDone, noticeActionIn } from './notify'
import { mayHandOverNow } from './handOverCheck'
import { transcripts } from './transcripts'
import * as skills from './skills'
import * as storage from './storage'
import { applyCleanupPlan, cardCleanupPreview, queueCleanup } from './cardAttachmentCleanup'
import { antivirusStatus, antivirusSuggestion, applyAntivirus, dismissAntivirus, moveDefenderPlan, prepareAntivirus } from './antivirus'
import { agentsMemory, allLeftovers, endAgentProcess, leftoversSettled, settleLeftovers, settleOffer } from './agentProcesses'
import { cardWork, forYou, workBadges } from './workflow/cardWork'
import { contextWorkspace, currentWorkspace, inWorkspace, workspace, workspaceFor, workspaceOf, WorkspaceService } from './workspace'
import { ensureHiveExcluded, trackedHiveFiles, untrackHive, vcsOf } from './hiveVcs'
import { hiveWindows, windowForPath, windowOf, windowShowing } from './windows'
import { noteLongTasks, noteWhere } from './rendererWatch'
import { cleanTasks, cleanWhere } from '../shared/windowHealth'
import { setTitleBarBackdrops, setTitleBarColors } from './titleBar'
import { showWindow } from './tray'
import { resetMetrics } from './metrics'
import { beginWork, recentStalls } from './mainStalls'
import { metricsExport, metricsReport } from './metricsUsage'
import { cancelWatch, stampWatchProjects } from './watches'
import { cancelMessages, deliverWaiting } from './agentMessages'
import { freshPlan, startFreshIfIdle } from './freshStarts'
import { cardBusy } from './cardBusy'
import { devConsole } from './devConsole'
import { consoleSources } from './devConsoleSources'
import { CONSOLE_WINDOW_CHANNELS, consoleOwner, openConsoleWindow, sendToConsoles } from './consoleWindow'
import { isRecordingName, latestRecording, listCaptures, recordingOf, recordingsDir, startRecording, stopRecording, stopRecordingsWhere } from './consoleRecorder'
import { mayRead, type ConsoleEvent } from '../shared/devConsole'
import { benchContext, importBenchmark, keepReport, listBenchmarks, pinBenchmark, readBenchmark, removeBenchmark, selectBenchmarks } from './benchmarks'
import { capturedText, englishError, HiveError, hiveError, windowError } from './hiveError'
import { deleteJournalEntry, deleteWorkspaceJournal, editJournalEntry, forgetJournalEntries, forgetJournalPreview, journalEntry, journalStatus, setJournalSettings } from './journalService'
import { browseJournal, journalProjects } from './journal'
import { runActions } from './workflow/actionWorker'
import { adoptWorkspace } from './workflow/adoption'
import { repairStages } from './workflow/stageRepair'
import { attachableSource, attachToCard, cardAttachmentGroups, cardAttachments, previewCardAttachment, recoverCardAttachments, removeCardAttachment, stageDrafts } from './cardAttachments'
import { settleSlotsUpToDate } from './workflow/slotsUpToDateStep'
import { settleCommitMessageDefault } from './workflow/commitMessageStep'
import { migrateSlots, releaseCarried } from './slotMigration'
import { boardSlots, heldWriter, releaseHeldWriter } from './agentFolders'
import { copyV09Templates, sayV09TemplatesOnce } from './templateUpgrade'
import { checkWorkflowChange, chooseMerge, presetsNotice, settleMergeChoices, presetsNoticeSaid, projectStages, setWorkflowOptions, workflowForm } from './workflow/optionsForm'
import { checkPlatformSwitch, setPlatform } from './workflow/platformSwitch'
import { presetNotNow } from './workflow/presetStep'
import { checkLevelChange, levelForm, setLevelOptions } from './workflow/levels'
import { rulesetsNow } from './workflow/rulesets'
import { poolFor, slotTest, slotViews } from './slotsApp'
import { projectSlotCopy, setSlotDefault, setSlotSetting, slotLevelForm } from './slotSettings'
import { copyViews, stopIsolated } from './copiesApp'
import { branchQueueCard, markQueueSeen, mergedOutsideQueue, pauseQueue, queueCardChange, queueHistory, queueViews, resumeQueue } from './workflow/queueControls'
import { reconcileCard, reconcileWorkspace } from './workflow/reconciler'
import { cardFacts } from './workflow/recorder'
import { msg, tr } from '../shared/i18n'
import { withSkillDelivered } from '../shared/skillDelivery'
import { pauseApp, resumeApp } from './teamPause'
import { endParkedProcess, installIfParked, teamPauseState } from './teamParked'

/**
 * What the window is told when a call is refused (#845): thrown as HiveErrors, so the window reads them in its language
 * and anything else that calls these services reads English. The native dialogs' text is the window's too.
 */
const M = {
  queueMerges: msg({ id: 'errors.merge.queueMerges', defaultMessage: "Hive merges {card} through the merge queue. Merge it there, or choose Merge anyway in the Merge dialog.", description: "Refusal of a Merge of an agent's branch whose card Hive's merge queue merges (the dialog's state was out of date). {card} is the card's key. Merge anyway is a button: keep it as Hive shows it. Glossary 2.5: merge queue." }),
  unknownProvider: msg({ id: 'errors.provider.unknown', defaultMessage: 'Unknown provider "{provider}".', description: "A call named a coding-agent CLI this version of Hive doesn't know. {provider} is the id it gave." }),
  insideArchive: msg({ id: 'errors.file.insideArchive', defaultMessage: 'Hive opens no files inside .asar archives.', description: 'Refusal to open a file inside an Electron .asar archive. Keep ".asar" as it is.' }),
  outsideWorkspace: msg({ id: 'errors.file.outsideWorkspace', defaultMessage: "Hive can only read and write files inside the workspace, and the agents' instruction, memory and skill files.", description: 'Refusal to open or save a file outside what Hive may touch.' }),
  noLog: msg({ id: 'errors.log.none', defaultMessage: 'That run reported no log.', description: "Progress panel: a run's log can't be opened because the run never said where it was." }),
  logNotFull: msg({ id: 'errors.log.notFullPath', defaultMessage: 'The run reported its log without a full path: {path}', description: "Progress panel: a run gave its log as a relative path, which Hive won't open. {path} is that path." }),
  logGone: msg({ id: 'errors.log.gone', defaultMessage: "The log isn't there any more: {path}", description: "Progress panel: a run's log file was deleted or moved. {path} is where it was." }),
  logNotText: msg({ id: 'errors.log.notText', defaultMessage: 'Hive opens only text logs and reports, not {file}: use Show in folder.', description: "Progress panel: a run's log isn't a text file, so Hive won't open it. {file} is its file name. \"Show in folder\" is the menu item beside it." }),
  commandsMoved: msg({ id: 'errors.commands.otherWorkspace', defaultMessage: "This window shows another workspace now, so the commands you changed weren't saved.", description: "An error: the user changed a workspace's commands in Settings (HI-1954), and the window switched to another workspace before the change was saved, so Hive didn't save it into the wrong one." }),
  notProjectPref: msg({ id: 'errors.pref.notProjectPref', defaultMessage: 'Not a project preference.', description: "Refusal of a call to save a per-project view setting that doesn't exist (a programming error, rarely seen)." }),
  notPrefValue: msg({ id: 'errors.pref.notValue', defaultMessage: 'Not a {pref} value.', description: "Refusal of a per-project view setting's value. {pref} is the setting's internal name." }),
  notTipsChange: msg({ id: 'errors.tips.notChange', defaultMessage: 'Not a tips change.', description: 'Refusal of a call to change which tips were seen (a programming error, rarely seen).' }),
  workspaceNotFound: msg({ id: 'errors.workspace.notFound', defaultMessage: "The workspace folder {path} can't be found. It may have been moved or deleted, or be on a drive that isn't connected.", description: "Opening a workspace whose folder isn't there. {path} is the folder." }),
  undoWhich: msg({ id: 'errors.assistantUndo.which', defaultMessage: "Choose one change of the Assistant's to undo, or one message's changes.", description: "An error: the window asked to undo the Hive Assistant's changes without saying which: one change, or all the changes made for one of the user's messages." }),
  undoGone: msg({ id: 'errors.assistantUndo.gone', defaultMessage: "That change of the Assistant's is no longer kept: changes are kept for 7 days.", description: "An error: the user asked to undo a change the Hive Assistant made, but it is older than 7 days (or was never kept), so it can't be undone any more." }),
  noWorkspace: msg({ id: 'errors.workspace.none', defaultMessage: 'No workspace is open.', description: 'An action needs an open workspace and this window has none.' }),
  notWorktree: msg({ id: 'errors.worktree.notGit', defaultMessage: "{path} isn't a git worktree (it has no .git file). Choose the folder the worktree was moved to.", description: "Repair: the folder chosen as an agent's moved worktree isn't one. {path} is that folder. Keep \".git\" as it is." }),
  removeHow: msg({ id: 'errors.project.removeHow', defaultMessage: 'Unknown way to remove a project: {how}', description: "Refusal of a call to remove a project in a way that doesn't exist (a programming error, rarely seen). {how} is what it asked for." }),
  stopFirst: msg({ id: 'errors.project.stopFirst', defaultMessage: 'Stop the running session before deactivating this project.', description: 'Turning a project off while one of its agents is running.' }),
  noRepo: msg({ id: 'errors.hive.noRepo', defaultMessage: 'No git repository holds this project: exclude .hive in the version control or sync service you use.', description: "Exclude .hive from git: the project isn't in a git repository. Keep \".hive\" as it is." }),
  stillTracked: msg({ id: 'errors.hive.notIgnored', defaultMessage: "Git still doesn't ignore .hive here: a rule in a .gitignore (a line starting with !) may bring it back. Hive doesn't edit .gitignore files.", description: 'Exclude .hive from git: after excluding it, git still sees it. Keep ".hive", ".gitignore" and "!" as they are.' }),
  cantList: msg({ id: 'errors.hive.cantList', defaultMessage: "Git couldn't list the files it tracks in .hive.", description: 'Listing the files of .hive that git tracks failed. Keep ".hive" as it is.' }),
  notImage: msg({ id: 'errors.image.not', defaultMessage: 'Not an image', description: "Copy image: the file isn't an image Hive can read." }),
  holdRequired: msg({ id: 'errors.mergeSlot.holdRequired', defaultMessage: 'Which hold to release is required', description: 'Releasing a merge slot without saying which (a programming error, rarely seen).' }),
  laneRequired: msg({ id: 'errors.lane.required', defaultMessage: 'Which lane to end is required', description: 'Ending a card loop without saying which (a programming error, rarely seen).' }),
  laneBuilderRequired: msg({ id: 'errors.lane.builderRequired', defaultMessage: "A lane's builder is required", description: 'Starting a lane (a card loop) without saying which agent builds it (a programming error, rarely seen).' }),
  consoleHidden: msg({ id: 'errors.console.hidden', defaultMessage: 'The developer console is hidden: turn on Settings → Advanced → Show developer features.', description: 'Opening the developer console while it is turned off. "Settings → Advanced → Show developer features" is the way to the setting: translate it as Settings shows it.' }),
  sourcesList: msg({ id: 'errors.console.sourcesList', defaultMessage: 'The sources to watch must be a list.', description: "The developer console asked to watch sources in a form Hive doesn't take (a programming error, rarely seen)." }),
  notSource: msg({ id: 'errors.console.notSource', defaultMessage: 'Not a developer console source this window can record', description: "Recording a developer console source this window can't read." }),
  notRecording: msg({ id: 'errors.console.notRecording', defaultMessage: 'Not a developer console recording', description: "Showing a developer console recording that isn't one of Hive's." }),
  notFileOf: msg({ id: 'errors.changes.notFile', defaultMessage: "{file} isn't a file of {folder}.", description: 'Changes tab: opening a file outside the folder it shows. {file} is the file, {folder} the folder.' }),
  // The native dialogs.
  openWorkspace: msg({ id: 'errors.dialog.openWorkspace', defaultMessage: 'Open Workspace', description: "Title and button of Windows' folder picker for opening a workspace." }),
  createWorkspaceTitle: msg({ id: 'errors.dialog.createWorkspaceTitle', defaultMessage: 'Choose or create a folder for the new workspace', description: "Title of Windows' folder picker for a new workspace." }),
  createWorkspace: msg({ id: 'errors.dialog.createWorkspace', defaultMessage: 'Create Workspace', description: "Button of Windows' folder picker for a new workspace." }),
  exportMetrics: msg({ id: 'errors.dialog.exportMetrics', defaultMessage: 'Export Performance Metrics', description: "Title of Windows' save dialog for exporting the Performance view." }),
  exportBoard: msg({ id: 'errors.dialog.exportBoard', defaultMessage: 'Export Board to JSON: Choose a Folder', description: "Title of Windows' folder picker for Export Board to JSON: the board's cards are saved as JSON files in a new folder inside the one chosen." }),
  exportBoardButton: msg({ id: 'errors.dialog.exportBoardButton', defaultMessage: 'Export Here', description: "The button of Windows' folder picker for Export Board to JSON." }),
  importBenchmark: msg({ id: 'errors.dialog.importBenchmark', defaultMessage: 'Import a Benchmark or Performance Export', description: "Title of Windows' file picker in Performance → Compare." }),
  locateWorktree: msg({ id: 'errors.dialog.locateWorktree', defaultMessage: "Locate {agent}'s worktree", description: "Title of Windows' folder picker in Repair, for an agent's moved worktree. {agent} is the agent's name." }),
  locateAgentWorktree: msg({ id: 'errors.dialog.locateAgentWorktree', defaultMessage: "Locate the agent's worktree", description: "Title of Windows' folder picker in Repair, for a moved worktree whose agent is gone." }),
  useFolder: msg({ id: 'errors.dialog.useFolder', defaultMessage: 'Use This Folder', description: "Button of Windows' folder picker in Repair." }),
  exportTemplate: msg({ id: 'errors.dialog.exportTemplate', defaultMessage: 'Export Template', description: "Title of Windows' save dialog for a template." }),
  importTemplate: msg({ id: 'errors.dialog.importTemplate', defaultMessage: 'Import a Template', description: "Title of Windows' file picker for a template." }),
  templateFiles: msg({ id: 'errors.dialog.templateFiles', defaultMessage: 'Hive template', description: "The file type in Windows' file dialogs for templates." }),
  exportTranscript: msg({ id: 'errors.dialog.exportTranscript', defaultMessage: 'Export Transcript as Markdown', description: "Title of Windows' save dialog for a session's transcript." }),
  addSkill: msg({ id: 'errors.dialog.addSkill', defaultMessage: 'Add a skill from a file', description: "Title of Windows' file picker for a skill." }),
  skillFiles: msg({ id: 'errors.dialog.skillFiles', defaultMessage: 'Skill (.md or .zip)', description: "The file type in Windows' file picker for a skill. Keep \".md\" and \".zip\" as they are." }),
  addMcp: msg({ id: 'errors.dialog.addMcp', defaultMessage: 'Add an MCP server from a file', description: "Title of Windows' file picker for an MCP server." }),
  mcpFiles: msg({ id: 'errors.dialog.mcpFiles', defaultMessage: 'MCP server (.json definition or .zip folder)', description: "The file type in Windows' file picker for an MCP server. Keep \".json\" and \".zip\" as they are." })
}

/** Settings → Advanced's state for the calling window: advanced.json's overrides and its workspace's own values (#367). */
const advancedState = (): AdvancedState => advanced.state(workspace.path ? (workspace.config.advanced ?? {}) : null)

/** The window an IPC call came from, for calls that keep something per window (the developer console's subscription). */
const senderStore = new AsyncLocalStorage<WebContents>()

/**
 * The Hive window whose IPC request is being served now (HI-2355), or null outside one (a timer, a hook, the Agent API):
 * a result or warning made for that request is told in that window (main/notify.ts), even if another has the focus by
 * then. A console window's request is its own, not a Hive window's: none.
 */
export function requestingWindow(): BrowserWindow | null {
  const wc = senderStore.getStore()
  const w = wc ? windowOf(wc)?.win : null
  return w && !w.isDestroyed() ? w : null
}
/**
 * Windows subscribed to the developer console, each with the workspace (lower case) it subscribed in: a subscription ends
 * when its window closes or leaves that workspace (#637), so no capture outlives the workspace it was for.
 */
const consoleWindows = new Map<string, { wc: WebContents; workspace: string }>()
/** Pages whose subscription already ends when they close. */
const consolePages = new WeakSet<WebContents>()
const consoleWorkspace = (wc: WebContents): string => ((windowOf(wc) ?? consoleOwner(wc))?.ws.path ?? '').toLowerCase()
onHiveEvent((e) => {
  if (e.type !== 'workspace-changed') return
  for (const [id, sub] of consoleWindows) {
    if (!sub.wc.isDestroyed() && consoleWorkspace(sub.wc) === sub.workspace) continue
    consoleWindows.delete(id)
    devConsole.unsubscribe(id)
  }
  // A recording ends with the workspace it recorded in too (#638).
  stopRecordingsWhere((wc, recordedIn) => !!recordedIn && consoleWorkspace(wc) !== recordedIn, 'workspace')
})
/**
 * Settings → Advanced → Developer console: show text (#699): while it is on, the console's windows are sent prompt, reply
 * and command text (secrets still masked, shared/devConsole.ts); a change applies to their subscriptions at once.
 */
const consoleShowsText = (): boolean => advanced.get<boolean>('hive.console.showText') === true
advanced.onChange(() => {
  const showText = consoleShowsText()
  for (const id of consoleWindows.keys()) devConsole.setIncludeText(id, showText)
  sendToConsoles({ type: 'console-options', showText })
})
/** Whether this window's workspace may read a console source (its own agents, its Assistant and Hive there). */
const windowMayRead = (source: string): boolean => {
  const ws = currentWorkspace().path
  return !!ws && mayRead({ kind: 'assistant', workspace: ws }, source, (p) => workspaceFor(p)?.path ?? null)
}

/** The instruction files of the given providers in a project, with their content. */
async function projectInstructions(project: string, ids: ProviderId[]): Promise<InstructionsFile[]> {
  const descriptors = ids.map(providerDescriptor)
  const content = new Map<string, string | null>()
  for (const d of descriptors) content.set(d.instructionsFile, await readFile(join(project, d.instructionsFile), 'utf8').catch(() => null))
  return instructionFiles(descriptors, (f) => content.get(f) ?? null)
}

type Impl = { [C in HiveChannel]: (...args: Parameters<HiveRequests[C]>) => ReturnType<HiveRequests[C]> | Promise<ReturnType<HiveRequests[C]>> }

/** A provider id this version knows; anything else is refused (it would become a settings key). */
function knownProvider(id: unknown): ProviderId {
  if (typeof id !== 'string' || !isKnownProvider(id)) throw hiveError(M.unknownProvider, { provider: String(id) }, { kind: 'invalid' })
  return id
}

/** Refuses extra arguments with a bare "--" (#523): Hive passes the task after its own. */
function assertExtraArgs(args: unknown): void {
  const problem = typeof args === 'string' ? capturedText((t) => extraArgsProblem(args, t)) : null
  if (problem) throw new HiveError(problem, { kind: 'invalid' })
}

function guardFile(path: string, write = false): string {
  if (insideArchive(path)) throw hiveError(M.insideArchive, undefined, { kind: 'forbidden' })
  // A CLI's own files: its connections' homes on in this workspace (HI-1755), else the CLI's own home.
  if (workspace.isAllowedPath(path) || allProviders().some((p) => p.fileAllowed(path, write, connectionHomes(p.id, workspace.path ? workspace.config : null)?.map((h) => h.home)))) return path
  // The skills that ship with Hive, to view one the workspace doesn't have.
  if (!write && insideReal(path, [skills.bundledSkillsDir()])) return path
  throw hiveError(M.outsideWorkspace, undefined, { kind: 'forbidden' })
}

/** The log files Hive opens itself (#251): text and reports. Anything else is only shown in its folder, never run. */
const OPENABLE_LOG = /\.(md|markdown|txt|log|out|err|json|jsonl|csv|tsv|xml|html?)$/i

/**
 * A progress run's log, to open or show (#251): only the path that run reported (by its agent's token) when it finished,
 * looked up by the run's id, never a path the window passes; a full path to a file that is there. Logs can be anywhere
 * (an e2e run's record is under %LOCALAPPDATA%), so this doesn't go through guardFile.
 */
async function runLog(id: unknown): Promise<string> {
  const p = workspace.path && typeof id === 'string' ? progress.logOf(workspace.path, id) : null
  if (!p) throw hiveError(M.noLog, undefined, { kind: 'notFound' })
  if (!isAbsolute(p)) throw hiveError(M.logNotFull, { path: p }, { kind: 'invalid' })
  if (!(await isFile(p))) throw hiveError(M.logGone, { path: p }, { kind: 'notFound' })
  return p
}

/** Quitting and closing windows (index.ts): each call names the window it came from. */
export interface QuitControl {
  quit: () => void
  /** Quits as quit does (asking about running agents), then starts Hive again (#676). */
  restart: () => void
  decide: (from: BrowserWindow, choice: QuitChoice, dontAskAgain: boolean) => void
  cancelPending: () => void
  state: (from: BrowserWindow) => ReturnType<HiveRequests['app:quitState']>
  setUnsaved: (from: BrowserWindow, paths: string[]) => void
  newWindow: (from: BrowserWindow) => void
  /** Before closing or switching a window's workspace: asks (per Confirm on quit) and stops its agents; false if cancelled. */
  stopWorkspaceAgents: (from: BrowserWindow, scope: 'workspace' | 'switch') => Promise<boolean>
}

/** Whether any agent of this workspace is running or starting. */
function workspaceLive(ws: WorkspaceService): boolean {
  return [...sessions.liveStates().map((s) => s.projectPath), ...sessions.pendingStarts()].some((p) => workspaceFor(p) === ws)
}

/** Opens a workspace in this window. Its old workspace's agents were stopped for it: starts are allowed again either way. */
async function openHere(path: string): ReturnType<WorkspaceService['open']> {
  const ws = contextWorkspace()!
  // The window claimed here, where the open begins to change it, after any folder picker or agents' stop a second
  // request may have outlasted (HI-1694): refused while another holds it. Its steps shown as they go, until it is open.
  const claim = claimWindow(ws, path, 'projects')
  try {
    // A switch: the workspace it had closes first, running its close command (HI-1368), then the next one opens.
    if (ws.path) await closeWithCommand(ws, 'switch', ws.window)
    return await workspace.open(path)
  } finally {
    ws.closing = false
    releaseWindow(ws, claim)
  }
}

const log = createLogger('ipc')

/** Repair…'s choices as the window sent them, with anything else dropped (#146). */
function moveOptions(o: unknown): MoveOptions {
  const v = (o ?? {}) as Record<string, unknown>
  const locate = v.locate && typeof v.locate === 'object' ? Object.fromEntries(Object.entries(v.locate as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string' && !!e[1])) : undefined
  const list = (x: unknown): string[] | undefined => (Array.isArray(x) ? x.filter((y): y is string => typeof y === 'string') : undefined)
  const unlink = list(v.unlink)
  const recreate = list(v.recreate)
  return { ...(locate ? { locate } : {}), ...(unlink ? { unlink } : {}), ...(recreate ? { recreate } : {}), ...(v.defender === true ? { defender: true } : {}) }
}


/**
 * Every merge route's authorization, decided now in main (#1357 and #1450, OP-13): a branch whose card Hive's merge
 * queue merges goes only as Merge anyway for that card (then recorded on it as an override, with the reason); a line
 * whose card isn't Done otherwise only when the request names that card, after the window's confirmation. So no dialog
 * whose lookup was pending, failed or out of date, and no older route, merges a card's work plainly.
 */
async function authorizedMerge(path: string, branch: string | null | undefined, opts: { card?: number; outsideQueue?: { card: number; reason: string } } | undefined, run: () => Promise<MergeResult>): Promise<MergeResult> {
  const queued = branch ? await branchQueueCard(workspace, path, branch) : null
  const out = opts?.outsideQueue
  if (queued && (!out || out.card !== queued.card)) throw hiveError(M.queueMerges, { card: queued.key }, { kind: 'conflict' })
  if (!queued) await lineConfirmed(path, branch, opts?.card)
  const r = await run()
  // Merged anyway, outside the merge queue: an override on the card, with the user's reason.
  if (r.ok && queued && out) await mergedOutsideQueue(workspace, path, queued.card, typeof out.reason === 'string' ? out.reason.slice(0, 2000) : '').catch((e) => log.warn('recording a merge outside the queue', e))
  return r
}
/**
 * What a workspace's opening does with its board, each step in the background. A 0.9 board waiting for its upgrade takes
 * no writes, and its tables aren't 1.0's yet: none of the steps runs on it (HI-1694: the stage repair failed against it),
 * and all of them run once it is upgraded (#1621), with no restart; each changes nothing the second time.
 */
function boardSteps(ws: WorkspaceService, upgraded = false, after?: AfterOpen): void {
  if (boardWaits(ws)) return
  // Each chain timed in the open's "after opening" line (HI-1705), when an open started it.
  const timed = <T>(what: string, p: Promise<T>): Promise<T> => (after ? after.track(what, p) : p)
  // Just upgraded at the user's word: the adoption and the slots that follow are shown as the open's last steps (HI-1694).
  const path = ws.path
  // The upgrade's claim of the window (board:upgrade), which the adoption and slots carry on and let go; none for an
  // upgrade made another way, so never another operation's.
  const claim = upgraded && openProgress(ws)?.step === 'upgrade' ? windowClaim(ws) : null
  const step = (s: 'adoption' | 'slots'): void => {
    if (claim && path && ws.path === path) openStep(ws, s, { token: claim })
  }
  // Each card, lane and card watch names its project by its stable id (#508), then old Done cards are archived.
  void timed(
    "projects' ids and keys, old Done cards", // i18n-ignore: a part of a log line's timing
    tasks
      .stampCardProjects(ws)
      .catch((e) => log.warn("giving the cards their projects' ids", e))
      .then(() => stampLaneProjects(ws).catch((e) => log.warn("giving the lanes their projects' ids", e)))
      .then(() => stampWatchProjects(ws).catch((e) => log.warn("giving the card watches their projects' ids", e)))
      // Each project its key (#1219), and once after the upgrade gave them, a quiet notice saying so.
      .then(() => keyProjects(ws).catch((e) => log.warn('giving the projects their keys', e)))
      .then(() => sayKeysOnce(ws))
      .then(() => tasks.archiveOldDone(ws))
      .catch((e) => log.warn('archiving old Done cards', e))
      // Then archived cards' attachments past their project's days (HI-1842): queued, run once the PC is idle.
      .then(() => queueCleanup(ws))
  )
  // The cards' actions a crash or a close left pending (#1215, SPEC §16.4.5): run once, in the order written.
  void timed('pending card actions', runActions(ws)) // i18n-ignore: a part of a log line's timing
  // The 1.0 upgrade's adoption (#1218, SPEC §16.17): each project's options and its old cards, until it has run once;
  // then what changed in its projects while it was closed, recorded as observed facts (#1217): the cards adopted too.
  // Then its agents' worktrees become slots (#1441), each project once, before what changed is observed.
  // And G15 saved before P7 settled once (#1445), so a Pair or Team project gets its preset's On.
  // And a card the board has in Done while its stage isn't (HI-1674) brought into line, before what changed is observed.
  step('adoption')
  void timed(
    'adoption, slots, repairs and what changed while closed', // i18n-ignore: a part of a log line's timing
    adoptWorkspace(ws)
      .then(() => settleSlotsUpToDate(ws))
      // HI-1997: a commit message a preset stored as Hive's, switched once to the branch's own (a proven choice kept).
      .then(() => settleCommitMessageDefault(ws))
      .then(() => step('slots'))
      .then(() => migrateSlots(ws))
      .then(() => repairStages(ws))
      // HI-1697: a merge choice the board recorded and a save stopped before writing to project.json, written there now.
      .then(() => settleMergeChoices(ws))
      // What an interrupted card attachment operation left (HI-1700), settled from its records against the board.
      .then(() => recoverCardAttachments(ws))
      .finally(() => {
        releaseWindow(ws, claim)
        return reconcileWorkspace(ws)
      })
  )
  // 0.9's agent templates copied into the 0.9 backup once after the upgrade (#1436), and a quiet notice saying so.
  void timed(
    "0.9's agent templates", // i18n-ignore: a part of a log line's timing
    copyV09Templates(ws)
      .then(() => sayV09TemplatesOnce(ws))
      .catch((e) => log.warn("copying 0.9's agent templates (tried again at the next open)", e))
  )
  // HI-2059: choices dropped converting MCP servers to added servers, said once.
  void mcp.sayMcpAddedOnce(ws).catch((e) => log.warn('the MCP added-servers notice', e))
}

export function registerIpc(getAppInfo: () => ReturnType<HiveRequests['app:info']>, quitControl: QuitControl): void {
  // A board upgraded to 1.0 while its workspace is open: what its opening skipped, now (#1621).
  onBoardUpgraded((ws) => boardSteps(ws, true))
  // Each time a workspace opens: Hive's bundled skills and modes it hasn't got, or has untouched older copies of.
  // After the open, not before it (HI-1705): a launch waits for it.
  WorkspaceService.bringItemsUpToDate = (fresh) => syncBundled({ fresh })
  WorkspaceService.runsCommands = closeCommandsRun
  // Each part in the background, timed in the open's "after opening" line (HI-1705).
  WorkspaceService.onOpened = async (_fresh, after) => {
    const ws = workspace
    // Its usage history imports the sessions it had, the first time (#1106), in the background.
    void after.track('usage history', usageHistory.opened(contextWorkspace()!)) // i18n-ignore: a part of a log line's timing
    // Its board's steps: skipped while the board waits for its upgrade to 1.0, and run again once it is upgraded.
    boardSteps(contextWorkspace()!, false, after)
    // Builds of Hive left for it while it was closed (#1534), into the journal once.
    void after.track('builds left for it', pickUpBuilds(ws).catch((e) => log.warn('recording the builds left for Hive', e))) // i18n-ignore: a part of a log line's timing
    // What failed or interrupted saves and the project-id migration left in the .hive folders (#1016).
    void after.track('leftovers', sweepWorkspaceLeftovers(ws).catch((e) => log.warn('removing leftover temp and backup files', e))) // i18n-ignore: a part of a log line's timing
    // Its open point's commands (HI-1954), in its window, its agents held until they're done (the gate reserved as it opened).
    void after.track('open commands', runOpenCommands(contextWorkspace()!)) // i18n-ignore: a part of a log line's timing
    // Moved since it was last opened (#146)? In the background: the window opens meanwhile, and a banner follows.
    void after.track('whether it moved', checkMoved(contextWorkspace()!).catch((e) => log.warn('checking whether the workspace moved', e))) // i18n-ignore: a part of a log line's timing
    // A merge slot an agent held when Hive closed: its merge may be half done (#350).
    // At start, the notice that Hive closed unexpectedly waits for it, and tells its holds (#984).
    // Resumes after a restart wait for it too (HI-1707).
    if (ws.path) {
      const recovery = after.track('merge slots', recoverMergeSlots(ws.path).catch((e) => log.warn('recovering the merge slots', e))) // i18n-ignore: a part of a log line's timing
      startupStep(recovery)
      workspaceRecovering(ws.path, recovery)
    }
  }
  // Each read of the projects' ids (#514): their names by id, and what follows a rename, follow it.
  WorkspaceService.onIdsRead = (ws, seen) => {
    followNames(ws, seen)
    // A project added since (made, or a folder opened): its key (#1219).
    void keyProjects(ws).catch((e) => log.warn('giving the projects their keys', e))
  }
  /** The window the current request came from. */
  const win = (): BrowserWindow => {
    const w = contextWorkspace()?.window
    if (!w || w.isDestroyed()) throw new Error('No window') // i18n-ignore: a call from a window that has closed: nobody sees it
    return w
  }
  /** Opening a workspace another window shows brings that window forward instead (as VS Code does). */
  const shownElsewhere = (target: string): boolean => {
    const other = windowShowing(target)
    if (!other || other.win === win()) return false
    showWindow(other.win)
    return true
  }

  const impl: Impl = {
    'app:info': () => getAppInfo(),
    'app:planUsage': () => config.get().planUsage,
    'app:connectionPlanUsage': () => config.get().connectionPlanUsage ?? {},
    'app:quit': () => quitControl.quit(),
    'app:restart': () => quitControl.restart(),
    'app:quitDecision': (choice, dontAskAgain) => quitControl.decide(win(), choice, dontAskAgain),
    'app:cancelPendingQuit': () => quitControl.cancelPending(),
    'closeCommand:state': () => closeCommandState(win()),
    'closeCommand:dontWait': (id) => dontWait(win(), String(id)),
    'closeCommand:dismiss': (id) => dismiss(win(), String(id)),
    'closeCommand:control': (id, action, step, attempt) => controlRun(win(), String(id), action, step, attempt),
    // Only the user sets them, from the window (HI-1954, as HI-1368's): the Assistant proposes, the user confirms.
    'commands:setWorkspace': async (workspacePath, commands) => {
      const ws = currentWorkspace()
      // To the workspace it was edited in: one switched away from meanwhile keeps its own (HR2's round 1).
      if (!ws.path || typeof workspacePath !== 'string' || !samePlace(ws.path, workspacePath)) throw hiveError(M.commandsMoved, undefined, { kind: 'conflict' })
      const saved = cleanWorkspace(commands)
      await ws.saveWorkspaceConfigWith(() => ({ commands: saved }))
      ws.scheduleRefresh()
      return saved
    },
    'commands:setHive': (commands) => {
      const saved = cleanHive(commands)
      config.updateSettings({ commands: saved })
      return saved
    },
    'commands:run': (ref) => runByHand(win(), currentWorkspace(), ref),
    'app:quitState': () => quitControl.state(win()),
    'app:openExternal': (url) => {
      if (/^https?:\/\//i.test(url) || url.startsWith('mailto:')) void shell.openExternal(url)
    },
    'app:openPath': (p) => void shell.openPath(guardFile(p)),
    'app:showInFolder': (p) => shell.showItemInFolder(guardFile(p)),
    'app:openLogs': () => void shell.openPath(logsDir()),
    // Not while server connections' keys can't be masked (HI-1772): nothing is copied.
    'app:diagnostics': async (opts) => {
      await requireMasking()
      return diagnostics({ recording: opts?.recording === true })
    },
    'app:keepAwake': () => keepAwakeCount(),
    'app:resumeAfterClose': async () => {
      const r = await resumeAfterClose()
      return { resumed: r.resumed.length, failed: r.failed.length }
    },
    'app:stopLeftAfterClose': () => stopLeftAfterClose(),
    'app:removeProfileBackup': () => removeProfileBackups(),
    'app:keepProfileBackup': () => keepProfileBackups(),
    'app:resumeRestart': () => resumeOffered(),
    'app:dismissRestart': () => dismissOffered(),
    'update:state': () => updater.updateState(),
    'update:check': () => updater.check(true),
    'update:download': () => updater.download(),
    'update:install': (version) => updater.restartAndInstall(typeof version === 'string' ? version : undefined),
    'update:skip': (version) => updater.skip(version),
    'team:state': () => teamPauseState(),
    'team:pause': async () => {
      const r = await pauseApp()
      return { done: r.done, failed: r.failed }
    },
    'team:resume': async () => {
      const r = await resumeApp()
      return { done: r.done, failed: r.failed }
    },
    // The asking window's own workspace only, checked on its own service (the `workspace` proxy would find another
    // window's by the path): another workspace's process is ended from its own window (HI-2095).
    'team:endProcess': (p, agentId, pid, created) => endParkedProcess(contextWorkspace()!.assertSessionHost(String(p)), String(agentId), Number(pid), String(created)),
    'team:showWorkspace': (path) => {
      const other = windowShowing(String(path))
      if (!other) return false
      showWindow(other.win)
      return true
    },
    'team:install': () => installIfParked(),
    'app:openChromiumLicenses': () => {
      const file = join(dirname(process.execPath), 'LICENSES.chromium.html')
      if (!existsSync(file)) return false
      void shell.openPath(file)
      return true
    },

    'window:minimize': () => win().minimize(),
    'window:toggleMaximize': () => (win().isMaximized() ? win().unmaximize() : win().maximize()),
    'window:close': () => win().close(),
    'window:count': () => hiveWindows().length,
    'window:new': () => quitControl.newWindow(win()),
    'window:toggleDevTools': () => win().webContents.toggleDevTools(),
    'window:zoom': (dir) => {
      const wc = win().webContents
      wc.setZoomLevel(dir === 'reset' ? 0 : Math.max(-3, Math.min(4, wc.getZoomLevel() + (dir === 'in' ? 0.5 : -0.5))))
    },
    'window:toggleFullScreen': () => win().setFullScreen(!win().isFullScreen()),
    'window:setAlwaysOnTop': (on) => {
      const w = win()
      const now = setPinned(w, contextWorkspace()?.path ?? null, on)
      emitTo(w, { type: 'window-state', maximized: w.isMaximized(), focused: w.isFocused(), alwaysOnTop: now })
      return now
    },
    'window:getAlwaysOnTop': () => win().isAlwaysOnTop(),
    'window:showing': (projectPath) => {
      const e = hiveWindows().find((x) => x.win === win())
      if (e) e.showing = projectPath
    },
    'notice:open': (projectPath) => {
      const target = (projectPath ? windowForPath(projectPath)?.win : null) ?? win()
      presentWindow(target)
      if (projectPath) emitTo(target, { type: 'menu-command', command: 'project.focus', args: [projectPath] })
    },
    'notice:action': (projectPath, command, args) => {
      // The window that has the project, which may not be the one the entry is in; the button's spinner lasts until the
      // command there has finished (HI-2320, HR2's round 1), its failure shown where the button was.
      const target = windowForPath(projectPath)?.win ?? win()
      presentWindow(target)
      emitTo(target, { type: 'menu-command', command: 'project.focus', args: [projectPath] })
      return noticeActionIn(target, command, Array.isArray(args) ? args : [])
    },
    'notice:actionDone': (reply, error) => noticeActionDone(String(reply), typeof error === 'string' ? error : null, win().webContents.id),
    'notice:target': (target) => {
      // The window that has its project, or a workspace card's workspace; else this one, which says it's gone.
      const where = target?.projectPath ?? (target?.kind === 'card' ? target.workspacePath : null)
      const at = (typeof where === 'string' && where ? windowForPath(where)?.win : null) ?? win()
      presentWindow(at)
      emitTo(at, { type: 'menu-command', command: 'notice.openTarget', args: [target] })
    },
    'window:edit': (role) => {
      const wc = win().webContents
      ;({ undo: () => wc.undo(), redo: () => wc.redo(), cut: () => wc.cut(), copy: () => wc.copy(), paste: () => wc.paste(), selectAll: () => wc.selectAll() })[role]()
    },
    'window:setBadge': (count, png, scale) => {
      const w = win()
      if (w.isDestroyed()) return
      const img = count > 0 && typeof png === 'string' ? nativeImage.createFromBuffer(Buffer.from(png, 'base64'), { scaleFactor: Number(scale) || 1 }) : null
      w.setOverlayIcon(img && !img.isEmpty() ? img : null, count > 0 ? badgeDescription(count) : '')
    },
    'window:setTitleBarColors': (color, symbolColor) => setTitleBarColors(win(), { color, symbolColor }),
    'window:setBackdrops': (count) => setTitleBarBackdrops(win(), count),
    // The page's health in hive.log (HI-1775): where it is, and its long tasks.
    'window:where': (where) => {
      const wc = senderStore.getStore()
      const entry = wc ? windowOf(wc) : null
      if (entry) noteWhere(entry, cleanWhere(where))
    },
    'window:longTasks': (list, where) => {
      const wc = senderStore.getStore()
      const entry = wc ? windowOf(wc) : null
      if (entry) noteLongTasks(entry, cleanTasks(list), cleanWhere(where))
    },

    'settings:get': () => config.settings,
    // Show developer features is kept in advanced.json too: written there first, or refused (#367).
    'settings:update': (patch) => updateSettingsChecked(patch, (p) => config.updateSettings(p)),
    'settings:setKeybinding': (id, key) => config.setKeybinding(id, key),
    'settings:setProviderPrices': (provider, prices, removed) => config.setProviderPrices(knownProvider(provider), prices, removed),
    'settings:setProviderFallback': (provider, kind, list) => config.setProviderFallback(knownProvider(provider), kind === 'efforts' ? 'efforts' : 'models', list),
    'settings:reset': async (section) => {
      // All of them: advanced.json's overrides too (#367), first, as it can refuse (a file it can't read).
      if (!section) {
        await advanced.resetAll()
        return config.resetSettings()
      }
      // A section with a value kept there too (Show developer features): the file first, in one turn (HI-2418).
      return resetSettingsChecked(section, () => config.resetSettings(section))
    },
    // Advanced settings (#367): the overrides in advanced.json, and this window's workspace's own values.
    'advanced:state': () => advancedState(),
    'advanced:set': async (id, value, scope) => {
      if (scope === 'workspace') {
        await workspace.setAdvanced(String(id), value)
        emit({ type: 'advanced-changed' })
      } else await advanced.set(String(id), value)
      return advancedState()
    },
    'advanced:keep': async (id) => {
      await advanced.keep(String(id))
      return advancedState()
    },
    'advanced:open': () => advanced.open(),
    'ui:get': () => config.get().ui,
    // Not the per-project maps nor the tips: a window's copy of them is stale for other windows' changes (ui:setProjectPref, #245; ui:changeTips, #266).
    'ui:set': (ui) => config.update((c) => Object.assign(c.ui, Object.fromEntries(Object.entries(ui ?? {}).filter(([k]) => !isProjectPref(k) && k !== 'tips')))),
    'ui:setPane': (key, size) =>
      config.update((c) => {
        c.ui.panes ??= {}
        if (typeof size === 'number' && Number.isFinite(size)) c.ui.panes[String(key)] = size
        else delete c.ui.panes[String(key)]
      }),
    'ui:setProjectPref': (pref, project, value) => {
      if (!isProjectPref(pref) || typeof project !== 'string' || !project) throw hiveError(M.notProjectPref, undefined, { kind: 'invalid' })
      const key = project.toLowerCase()
      const kept = value === null ? null : projectPrefValue(pref, value)
      if (kept === undefined) throw hiveError(M.notPrefValue, { pref }, { kind: 'invalid' })
      // This project's value merged into the saved map, never the window's whole copy of it.
      config.update((c) => {
        ;(c.ui as Record<string, unknown>)[pref] = withProjectPref(c.ui[pref] as Record<string, unknown> | undefined, key, kept)
      })
      emit({ type: 'ui-pref-changed', pref, project: key, value: kept })
    },
    'ui:changeTips': (change) => {
      const kept = tipsChange(change)
      if (!kept) throw hiveError(M.notTipsChange, undefined, { kind: 'invalid' })
      // The change applied to what is saved, never the window's whole copy of the state.
      let tips = EMPTY_TIPS_STATE
      config.update((c) => void (c.ui.tips = tips = applyTipsChange(tipsState(c.ui.tips), kept)))
      emit({ type: 'tips-changed', tips })
      return tips
    },
    'ui:changeBoardFold': (change) => {
      // This window's workspace only, applied to what is saved now: another window's folds stay as they are.
      const ws = workspace.path
      if (ws && change && typeof change === 'object') config.update((c) => void (c.ui.boardFold = applyBoardFold(c.ui.boardFold, ws, change)))
      return config.get().ui.boardFold ?? {}
    },
    'ui:setLaneOrder': (ids) => {
      // This window's workspace only, on what is saved now (#568): lane ids, a bounded list.
      const ws = workspace.path
      if (ws)
        config.update((c) => {
          const all = { ...c.ui.laneOrder }
          const kept = keptLaneOrder(ids)
          if (kept.length) all[ws.toLowerCase()] = kept
          else delete all[ws.toLowerCase()]
          c.ui.laneOrder = all
        })
      return config.get().ui.laneOrder ?? {}
    },

    'workspace:get': () => workspace.info(),
    'workspace:open': async (path) => {
      // Never a second open in this window while one is under way (HI-1694: in the middle of an upgrade, say).
      assertNotOpening(contextWorkspace()!)
      let target = path
      if (!target) {
        const r = await dialog.showOpenDialog(win(), { title: tr(M.openWorkspace), properties: ['openDirectory'], buttonLabel: tr(M.openWorkspace) })
        if (r.canceled || !r.filePaths[0]) return workspace.info()
        target = r.filePaths[0]
      }
      if (shownElsewhere(target)) return workspace.info()
      // A recent workspace whose folder was deleted or moved (#144): said plainly, so the window can offer to forget it.
      if (!existsSync(target)) throw hiveError(M.workspaceNotFound, { path: target }, { kind: 'notFound' })
      // This window's workspace already, or the one it is opening (its restore at start), by any name (an 8.3 short name,
      // a junction, #455): left as it is, never closed and opened again, which ended what its passes were writing
      // (HI-2141); it keeps the name it has, which its agents' sessions use.
      const here = await workspace.alreadyHere(target)
      if (here) return here
      if (workspace.path && workspaceLive(contextWorkspace()!)) {
        if (!(await quitControl.stopWorkspaceAgents(win(), 'switch'))) return workspace.info()
      }
      return openHere(target)
    },
    'workspace:create': async () => {
      assertNotOpening(contextWorkspace()!)
      const r = await dialog.showOpenDialog(win(), {
        title: tr(M.createWorkspaceTitle),
        properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
        buttonLabel: tr(M.createWorkspace)
      })
      if (r.canceled || !r.filePaths[0]) return workspace.info()
      if (shownElsewhere(r.filePaths[0])) return workspace.info()
      if (workspace.path && workspaceLive(contextWorkspace()!)) {
        if (!(await quitControl.stopWorkspaceAgents(win(), 'switch'))) return workspace.info()
      }
      const { mkdir } = await import('original-fs/promises')
      await mkdir(r.filePaths[0], { recursive: true })
      return openHere(r.filePaths[0])
    },
    'workspace:close': async () => {
      assertNotOpening(contextWorkspace()!)
      if (workspaceLive(contextWorkspace()!) && !(await quitControl.stopWorkspaceAgents(win(), 'workspace'))) return false
      const ws = contextWorkspace()!
      // Claimed after the agents' stop, which an open may have outlasted (HI-1694): refused while one holds the window.
      const claim = claimWindow(ws, ws.path ?? '', null)
      try {
        // Its close command run once it has closed (HI-1368), the window on its welcome page after.
        await closeWithCommand(ws, 'window', win())
      } finally {
        ws.closing = false
        releaseWindow(ws, claim)
      }
      emitTo(win(), { type: 'workspace-changed', workspace: null })
      // Other windows' lists no longer say it is open here.
      recentChanged()
      return true
    },
    'workspace:recent': () => recentFor(workspace.path),
    'workspace:usage': async () => {
      const ws = workspace
      if (!ws.path) throw hiveError(M.noWorkspace, undefined, { kind: 'conflict' })
      // From the usage history (#1106): each host's records and its sessions there, no transcript read.
      const projects = []
      for (const p of await ws.listProjectPaths()) projects.push({ name: basename(p), path: p, items: await sessions.usageItems(p).catch(() => []) })
      const assistant = existsSync(ws.assistantHome) ? await sessions.usageItems(ws.assistantHome).catch(() => []) : []
      return { workspacePath: ws.path, projects, assistant, hidden: ws.hiddenProjects().length, history: usageHistory.progressOf(ws.path) }
    },
    'metrics:query': (q) => metricsReport(currentWorkspace(), q),
    'metrics:reset': () => resetMetrics(currentWorkspace()),
    'performance:stalls': () => recentStalls(),
    'metrics:export': async (q, sanitize) => {
      // The report is taken before the dialog: the workspace this window shows now, not whatever it shows later.
      const report = await metricsReport(currentWorkspace(), { ...q, trend: true })
      const scope = q.scope.kind === 'project' && !sanitize ? q.scope.project.replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').trim().slice(0, 60) : q.own ? 'own-work' : q.scope.kind
      const r = await dialog.showSaveDialog(win(), {
        title: tr(M.exportMetrics),
        defaultPath: join(app.getPath('downloads'), `hive-performance-${scope}-${new Date().toISOString().slice(0, 10)}.json`),
        filters: [{ name: 'JSON', extensions: ['json'] }]
      })
      if (r.canceled || !r.filePath) return null
      // Masked by every key's fingerprint (HI-1772); refused, nothing written, while they can't be read.
      await requireMasking()
      await writeTextAtomic(r.filePath, JSON.stringify(maskDeep(metricsExport(report, app.getVersion(), sanitize)), null, 2) + '\n')
      return r.filePath
    },
    // Each takes the workspace's folder and lifetime before awaiting anything (benchContext): work whose workspace closes
    // or switches meanwhile (a dialog left open, a slow read) is refused, never written into the next one.
    'watch:cancel': (projectPath, agentId) => cancelWatch(workspaceOf(projectPath), projectPath, agentId),
    'session:cancelMessages': (projectPath, agentId) => cancelMessages(projectPath, agentId, 'the user'), // i18n-ignore: who cancelled them, as their agent is told (English)
    'session:deliverNow': (projectPath, agentId) => deliverWaiting(projectPath, agentId),
    'session:freshPlan': (projectPath) => freshPlan(projectPath),
    'session:startFresh': (projectPath, agentId) => startFreshIfIdle(projectPath, agentId),
    'benchmarks:list': (scope) => listBenchmarks(benchContext(currentWorkspace()), scope),
    'benchmarks:import': async (scope, answer) => {
      const ctx = benchContext(currentWorkspace())
      if (answer) return importBenchmark(ctx, scope, { token: answer.token, useProjectPart: answer.useProjectPart })
      const r = await dialog.showOpenDialog(win(), { title: tr(M.importBenchmark), properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] })
      if (r.canceled || !r.filePaths[0]) return null
      return importBenchmark(ctx, scope, { path: r.filePaths[0] })
    },
    'benchmarks:keep': async (q, label) => {
      const w = currentWorkspace()
      const ctx = benchContext(w)
      return keepReport(ctx, await metricsReport(w, q), app.getVersion(), label)
    },
    'benchmarks:read': (scope, id) => readBenchmark(benchContext(currentWorkspace()), scope, id),
    'benchmarks:remove': (scope, id) => removeBenchmark(benchContext(currentWorkspace()), scope, id),
    'benchmarks:pin': (scope, id, pinned) => pinBenchmark(benchContext(currentWorkspace()), scope, id, pinned),
    'benchmarks:select': (scope, base, run) => selectBenchmarks(benchContext(currentWorkspace()), scope, base, run),
    'workspace:removeRecent': (p) => {
      removeRecent(String(p ?? ''))
      return recentFor(workspace.path)
    },
    'workspace:clearRecent': () => {
      clearRecent()
      return recentFor(workspace.path)
    },
    'workspace:refresh': async () => (workspace.path ? workspace.refresh() : null),
    'workspace:movePlan': (opts) => movePlan(currentWorkspace(), moveOptions(opts)),
    'workspace:moveRepair': (opts) => repairMove(currentWorkspace(), moveOptions(opts)),
    'workspace:moveDefender': async () => {
      const w = currentWorkspace()
      const from = (await movePlan(w))?.from
      return from ? moveDefenderPlan(w, from) : null
    },
    'workspace:moveLocate': async (projectPath, agentId) => {
      const agent = agentsOf(await workspace.projectConfig(workspace.assertProject(projectPath))).find((a) => a.id === agentId)
      const title = agent ? tr(M.locateWorktree, { agent: agent.name }) : tr(M.locateAgentWorktree)
      const r = await dialog.showOpenDialog(win(), { title, properties: ['openDirectory'], buttonLabel: tr(M.useFolder) })
      if (r.canceled || !r.filePaths[0]) return null
      if (!(await isFile(join(r.filePaths[0], '.git')))) throw hiveError(M.notWorktree, { path: r.filePaths[0] }, { kind: 'invalid' })
      return r.filePaths[0]
    },

    'project:create': (name, key) => createProjectWithKey(workspace, name, key),
    'project:removalInfo': (p) => removal.removalInfo(p),
    'project:remove': (p, how) => {
      if (!['hide', 'remove', 'delete'].includes(how)) throw hiveError(M.removeHow, { how: String(how) }, { kind: 'invalid' })
      return removal.removeProject(p, how)
    },
    'project:hidden': () => workspace.hiddenProjects(),
    'project:restore': (name) => removal.restoreProject(name),
    'project:forget': (name) => removal.forgetHidden(name),
    'project:takeRemovedData': (p, keep) => removal.takeRemovedData(p, keep),
    'board:state': () => boardState(currentWorkspace()),
    'board:upgrade': async () => {
      const ws = currentWorkspace()
      // Shown as the open's steps (HI-1694): the upgrade, then the adoption and slots, until they are done.
      // The window claimed, shown as the open's steps (HI-1694): the upgrade, then the adoption and slots, which carry the
      // claim on and let it go (boardSteps).
      const claim = claimWindow(ws, ws.path ?? '', 'upgrade')
      // Then what the workspace's opening skipped (boardSteps, through onBoardUpgraded): the adoption (#1218), its
      // agents' worktrees adopted as slots (#1441), 0.9's templates copied aside (#1436), the cards' ids and keys.
      try {
        return await upgradeBoard(ws)
      } finally {
        // Refused, or upgraded already (nothing pending): no steps after it carry the claim on.
        if (openProgress(ws)?.step === 'upgrade') releaseWindow(ws, claim)
      }
    },
    'board:restore09': () => {
      const ws = currentWorkspace()
      return restoreBoardBackup(ws, () => (ws.path ? sessions.agentsIn(ws.path) : 0))
    },
    'tasks:list': (fullArchive) => tasks.windowTasks(workspace, fullArchive === true),
    'tasks:changes': (since) => tasks.windowChanges(workspace, since && typeof since === 'object' && typeof since.board === 'string' && Number.isSafeInteger(since.mark) ? { board: since.board, mark: since.mark } : null),
    'tasks:export': async () => {
      // The board as this window shows it now; the files go in a folder of their own inside the one chosen.
      const ws = currentWorkspace()
      const r = await dialog.showOpenDialog(win(), { title: tr(M.exportBoard), buttonLabel: tr(M.exportBoardButton), defaultPath: app.getPath('documents'), properties: ['openDirectory', 'createDirectory'] })
      if (r.canceled || !r.filePaths[0]) return null
      const dir = join(r.filePaths[0], `hive-board-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`)
      await requireMasking()
      return { dir, cards: await exportBoard(ws, dir, maskDeep) }
    },
    'tasks:create': async (input, drafts) => tasks.changeWithAttachments({ kind: 'user' }, await stageDrafts(currentWorkspace(), drafts, input.project ?? null), 'description', () => tasks.createTask(input, { kind: 'user' })),
    'tasks:setKind': (n, kind, opts) => tasks.setKind(n, kind, { kind: 'user' }, opts ?? {}),
    'tasks:confirmKind': (n, accept) => tasks.confirmKind(n, accept === true, { kind: 'user' }),
    'tasks:setReviewSkip': (n, skip, opts) => tasks.setReviewSkip(n, skip === true, { kind: 'user' }, { reason: opts?.reason }),
    // The window's change never skips a rule unasked (#1275): its moves go through tasks:move, which asks.
    'tasks:update': async (n, patch, more) => {
      const user = { kind: 'user' } as const
      const comment = typeof more?.comment === 'string' && more.comment.trim() ? more.comment : undefined
      // The dialog's Save (HI-1700): its change, its comment and the drafts of both boxes, in one change.
      const drafts = more?.drafts?.files?.length ? await stageDrafts(currentWorkspace(), more.drafts, (await tasks.getTask(n)).project ?? null) : null
      const run = (): Promise<TaskCard> => (Object.keys(patch).length ? tasks.updateTask(n, patch, user, { ask: true, ...(comment ? { comment } : {}) }) : comment ? tasks.commentTask(n, comment, user) : tasks.getTask(n))
      return tasks.changeWithAttachments(user, drafts, comment ? 'comment' : 'description', run)
    },
    'tasks:move': (n, column, opts) => tasks.moveTask(n, column, opts ?? {}),
    'tasks:columns': (n) => tasks.moveColumns(n),
    'tasks:facts': (n) => cardFacts(currentWorkspace(), n),
    'tasks:forYou': (project) => {
      const ws = currentWorkspace()
      return ws.path ? forYou(ws, typeof project === 'string' ? project : null) : { items: [], count: 0 }
    },
    'tasks:answer': (n, request, answer) => tasks.answerTask(n, request, answer),
    'docs:section': (p, ref) => checkDocRef(p ? workspace.assertProject(p) : null, workspace.sharedDir, String(ref ?? '')),
    'tasks:comment': async (n, text, drafts) => tasks.changeWithAttachments({ kind: 'user' }, await stageDrafts(currentWorkspace(), drafts, (await tasks.getTask(n)).project ?? null), 'comment', () => tasks.commentTask(n, text, { kind: 'user' })),
    'cards:attachments': (n) => cardAttachments(currentWorkspace(), n),
    'cards:projectAttachments': (p) => cardAttachmentGroups(currentWorkspace(), workspace.assertProject(p)),
    'cards:removeAttachment': (n, id) => removeCardAttachment(currentWorkspace(), n, String(id)),
    'cards:readAttachment': (n, id) => previewCardAttachment(currentWorkspace(), n, String(id), files.MAX_ATTACHMENT_TEXT),
    'cards:attachFromPane': async (n, host, path) => {
      const ws = currentWorkspace()
      const from = await attachableSource(ws, { kind: 'pane', host: workspace.assertSessionHost(host) }, String(path))
      return (await attachToCard(ws, n, [{ path: from }], 'You', 'pane')).attachments[0] // i18n-ignore: stored with the row in English, as agents read it
    },
    'tasks:archive': (n, archived) => tasks.archiveTask(n, archived),
    'tasks:editDecision': (n, id, text) => tasks.editDecision(n, id, text, { kind: 'user' }),
    'tasks:archiveBatch': (numbers, req) => {
      // Who is on a card is checked again as each is archived (#351), in this window's workspace.
      const ws = currentWorkspace()
      // A stage column's batch (#1420): each card's stage as its facts say now.
      return tasks.archiveBatch(numbers, req, { kind: 'user' }, { busy: (c) => cardBusy(ws, c), stageOf: (c) => cardWork(ws, c.number)?.stage ?? null })
    },
    'tasks:unarchiveBatch': (id) => tasks.unarchiveBatch(id, { kind: 'user' }),
    'tasks:archiveBatches': () => tasks.archiveBatches(),
    'journal:status': () => journalStatus(currentWorkspace()),
    'journal:set': (patch) => setJournalSettings(currentWorkspace(), patch ?? {}),
    'journal:delete': () => deleteWorkspaceJournal(currentWorkspace()),
    'journal:browse': (filter, offset, limit) => {
      const ws = currentWorkspace()
      return ws.path ? browseJournal(ws.assistantHome, filter ?? {}, offset, limit) : { rows: [], total: 0 }
    },
    'journal:projects': () => {
      const ws = currentWorkspace()
      return ws.path ? journalProjects(ws.assistantHome) : []
    },
    'journal:entry': (id) => journalEntry(currentWorkspace(), id),
    'journal:edit': (id, edit) => editJournalEntry(currentWorkspace(), id, edit ?? {}),
    'journal:deleteEntry': (id) => deleteJournalEntry(currentWorkspace(), id),
    'journal:forgetPreview': (filter) => forgetJournalPreview(currentWorkspace(), filter),
    'journal:forget': (filter, token) => forgetJournalEntries(currentWorkspace(), filter, token),
    'tasks:setAside': () => tasks.setAsideCards(currentWorkspace()),
    'tasks:addSetAside': (file) => tasks.addSetAsideCard(currentWorkspace(), file),
    'tasks:discardSetAside': (file) => tasks.discardSetAsideCard(currentWorkspace(), file),
    'tasks:delete': (n) => tasks.deleteTask(n),
    'tasks:start': async (n, target, opts) => {
      // A start that skips rules asks first (#1275), before any agent is added or anything launched.
      if (!opts?.confirm) {
        const ask = await tasks.startAsks(n, target.kind === 'agent' ? target.agentId : null)
        if (ask.length) return { ask }
      }
      const r = await startTask(n, target, { kind: 'user' }, undefined, opts?.reason)
      return { agentId: r.agentId, agentName: r.agentName, added: r.added }
    },
    'tasks:work': (n) => {
      const ws = currentWorkspace()
      if (!ws.path) return null
      // Read for its Work section: reconciled soon, whatever its stage (#1217); the board is told of what that records.
      const project = cardHeads(ws, [n])[0]?.project
      if (typeof project === 'string' && project) reconcileCard(ws, n, project)
      return cardWork(ws, n)
    },
    'tasks:workBadges': async () => {
      const ws = currentWorkspace()
      if (!ws.path) return []
      // Each project's ruleset now, for the old rules marks (#1421): read before the board, then the badges on one snapshot.
      const now = await rulesetsNow(ws)
      return ws.path ? workBadges(ws, now) : []
    },
    'project:setActive': async (p, active) => {
      p = workspace.assertProject(p)
      if (!active && sessions.liveFor(p)) throw hiveError(M.stopFirst, undefined, { kind: 'conflict' })
      if (active) await workspace.ensureProject(p)
      workspace.setActive(p, active)
      return workspace.refresh()
    },
    'project:keys': async () => {
      const ws = workspace
      const ids = await ws.projectIds()
      const held = projectKeys(ws)
      return [...ids.byId].flatMap(([id, projectPath]) => {
        const mine = held.filter((k) => k.projectId === id)
        const current = mine.find((k) => k.current)
        return current ? [{ projectPath, key: current.key, aliases: mine.filter((k) => !k.current).map((k) => k.key) }] : []
      })
    },
    'project:setKey': (p, key) => changeProjectKey(workspace, workspace.assertProject(p), key),
    'project:movedCardNames': () => movedNames(workspace),
    'project:updateConfig': (p, patch) => {
      for (const c of Object.values(patch.providers ?? {})) assertExtraArgs(c?.extraArgs)
      // The workflow options are checked as a whole (contradictions, what this version offers): workflow:setOptions.
      if (patch.workflow !== undefined) throw new HiveError({ lines: ["A project's workflow options change through workflow:setOptions"] }, { kind: 'invalid' }) // i18n-ignore: a mistake in Hive's code, never shown
      // Its version control switches only with its checks and its options kept per platform (#1419): workflow:setPlatform.
      if (patch.platform !== undefined) throw new HiveError({ lines: ["A project's version control changes through workflow:setPlatform"] }, { kind: 'invalid' }) // i18n-ignore: a mistake in Hive's code, never shown
      const projectPath = workspace.assertProject(p)
      // A project has no provider pages or default provider since HI-2106/HI-2107: its agents' connections hold what they
      // set (HI-2122: nothing is made from them), and project.json keeps none.
      const { providers: _p, defaultProvider: _d, ...rest } = patch
      return workspace.updateProjectConfig(projectPath, rest)
    },
    'workflow:form': (p) => workflowForm(workspace, workspace.assertProject(p)),
    'workflow:check': (p, change) => checkWorkflowChange(workspace, workspace.assertProject(p), change),
    'workflow:setOptions': (p, change, opts) => setWorkflowOptions(workspace, workspace.assertProject(p), change, { applyTo: Array.isArray(opts?.applyTo) ? opts.applyTo.filter((n) => Number.isInteger(n)) : [] }),
    'workflow:stages': (p) => projectStages(workspace, workspace.assertProject(p)),
    'workflow:chooseMerge': (p, choice) => chooseMerge(workspace, workspace.assertProject(p), choice),
    'board:stages': async () => Object.fromEntries(await Promise.all((workspace.info()?.projects ?? []).map(async (p) => [p.path.toLowerCase(), await projectStages(workspace, p.path).catch(() => null)] as const))),
    'workflow:checkPlatform': (p, to) => checkPlatformSwitch(workspace, workspace.assertProject(p), to),
    'workflow:setPlatform': (p, to, opts) => setPlatform(workspace, workspace.assertProject(p), to, { expected: opts?.expected }),
    'workflow:presetNotNow': (p, platform) => presetNotNow(workspace, workspace.assertProject(p), platform),
    'workflow:presetsNotice': () => presetsNotice(workspace),
    'workflow:presetsNoticeSaid': () => presetsNoticeSaid(workspace),
    'workflow:levelForm': (level, platform) => levelForm(workspace, level, platform),
    'workflow:levelCheck': (level, platform, change) => checkLevelChange(workspace, level, platform, change),
    'workflow:setLevel': (level, platform, change) => setLevelOptions(workspace, level, platform, change),
    'queue:list': (p, target) => queueViews(workspace, workspace.assertProject(p), typeof target === 'string' && target ? target : undefined, true),
    'slots:list': async (p) => slotViews(await poolFor(workspace, workspace.assertProject(p))),
    'slots:setSetting': (p, key, value) => setSlotSetting(workspace, workspace.assertProject(p), key, value),
    'slots:copyOf': (p) => projectSlotCopy(workspace, workspace.assertProject(p)),
    'slots:levelForm': (level) => slotLevelForm(workspace, level),
    'slots:setLevelDefault': async (level, key, value) => {
      await setSlotDefault(workspace, level, key, value)
      return slotLevelForm(workspace, level)
    },
    'slots:releaseCarried': (p, agentId) => releaseCarried(workspace, workspace.assertProject(p), String(agentId)),
    'slots:heldWriter': (p, slot) => heldWriter(workspace.assertProject(p), String(slot)),
    'slots:releaseWriter': (p, slot, run, end) => releaseHeldWriter(workspace.assertProject(p), String(slot), String(run), { end: end === true }),
    'copies:list': (p) => copyViews(workspace, workspace.assertProject(p)),
    'slots:test': async (p, op) => {
      if (app.isPackaged) throw new Error('slots:test is for test copies') // i18n-ignore: a test channel, never shown
      return slotTest(await poolFor(workspace, workspace.assertProject(p)), op)
    },
    'queue:history': (p, target) => queueHistory(workspace, workspace.assertProject(p), queueTarget(target)),
    'queue:seen': (p, target, entries) => markQueueSeen(workspace, workspace.assertProject(p), queueTarget(target), Array.isArray(entries) ? entries.filter((e): e is string => typeof e === 'string').slice(0, 100) : []),
    'queue:pause': (p, target) => pauseQueue(workspace, workspace.assertProject(p), queueTarget(target), 'user'),
    'queue:resume': (p, target) => resumeQueue(workspace, workspace.assertProject(p), queueTarget(target)),
    'queue:remove': async (n, reason) => (await queueCardChange(workspace, n, { kind: 'user' }, 'removeFromQueue', typeof reason === 'string' ? reason : '')).card,
    'queue:retry': async (n, reason) => (await queueCardChange(workspace, n, { kind: 'user' }, 'retryMerge', typeof reason === 'string' ? reason : '')).card,
    'project:excludeHive': async (p) => {
      p = workspace.assertProject(p)
      const r = await ensureHiveExcluded(p)
      if (!r) throw hiveError(M.noRepo, undefined, { kind: 'conflict' })
      if (!r.excluded) throw hiveError(M.stillTracked, undefined, { kind: 'conflict' })
      return workspace.refresh()
    },
    'project:hiveTracked': async (p) => {
      p = workspace.assertProject(p)
      const found = vcsOf(p)
      if (found?.kind !== 'git') return []
      const tracked = await trackedHiveFiles(p, found.root, { fresh: true })
      if (tracked === null) throw hiveError(M.cantList)
      return tracked
    },
    'project:untrackHive': async (p, confirmed) => {
      p = workspace.assertProject(p)
      await untrackHive(p, confirmed)
      return workspace.refresh()
    },
    'project:openInExplorer': (p) => void shell.openPath(workspace.assertProject(p)),
    'project:openTerminal': async (p) => {
      const dir = workspace.assertProject(p)
      // A new terminal gets what was installed since Hive started (#821).
      await refreshPathBeforeStart()
      openExternalTerminal(dir)
    },

    'session:list': (p, opts) => sessions.list(p, { own: opts?.own === true }),
    'session:start': (p, opts) => sessions.start(p, opts),
    // From the window: the user's stop (HI-1881: its pane says "stopped by you").
    'session:stop': (p, agentId) => sessions.stop(workspace.assertSessionHost(p), agentId, 'you'),
    'session:carryOn': (p, agentId) => sessions.carryOn(workspace.assertProject(p), agentId),
    'session:joinResume': (p, agentId, sessionId) => sessions.joinResume(p, agentId, sessionId),
    'session:markIdle': (p, agentId) => sessions.markIdle(workspace.assertSessionHost(p), agentId),
    'session:retryInput': (p, agentId, since) => sessions.retryInput(workspace.assertSessionHost(p), agentId, String(since)),
    'session:archive': (p, id, archived) => sessions.archive(p, id, archived),
    'session:rename': (p, id, name) => sessions.rename(p, id, name),
    'session:delete': (p, id) => sessions.delete(p, id),
    'session:bulk': (p, action, ids) => sessions.bulk(p, action, ids),
    'session:keptUsage': (p) => sessions.keptUsage(p),
    // A request is the calling window's: only it abandons it, and its page going abandons it too (#260).
    'storage:project': (p, refresh, request) => storage.projectStorage(p, refresh, typeof request === 'string' ? request : undefined, win().webContents.id),
    'storage:workspace': (refresh, request) => storage.workspaceStorage(refresh, typeof request === 'string' ? request : undefined, win().webContents.id),
    'storage:abandon': (request) => {
      if (typeof request === 'string') storage.abandonStorage(request, win().webContents.id)
    },
    'antivirus:status': (refresh) => antivirusStatus(refresh === true),
    'antivirus:prepare': (action) => prepareAntivirus(action),
    'antivirus:apply': (id) => applyAntivirus(id),
    'antivirus:suggestion': () => antivirusSuggestion(),
    'antivirus:dismiss': () => dismissAntivirus(),
    'storage:cleanupPreview': (p, opts) => storage.cleanupPreview(p, opts),
    'storage:cleanup': (p, opts, listed) => storage.cleanup(p, opts, listed),
    'storage:cardCleanupPreview': (p) => cardCleanupPreview(workspace.assertProject(p)),
    'storage:cardCleanup': (p, plan) => applyCleanupPlan(workspace.assertProject(p), String(plan ?? '')),
    'storage:purgePreview': (target) => storage.purgePreview(target),
    'storage:purge': (previewId, listed, permanent) => storage.purge(previewId, listed, permanent === true),
    'session:clearUsageCache': () => sessions.forgetUsageCache(),
    'session:adopt': (p, id) => sessions.adopt(p, id),
    'session:usage': (p, id) => sessions.usage(workspace.assertSessionHost(p), id),
    'session:hooks': (p, agentId) => sessions.sessionHooks(workspace.assertSessionHost(p), agentId),
    'session:markSeen': (p, ids) => sessions.markSeen(p, ids),
    'session:live': () => sessions.liveStates(),
    'session:setMode': (p, agentId, mode) => sessions.setPermissionMode(p, agentId, mode),
    'session:restartInMode': (p, agentId, mode) => sessions.restartInMode(p, agentId, mode),
    'session:setPlanMode': (p, agentId, on) => sessions.setPlanMode(p, agentId, on),
    'session:leftovers': async (settled) => {
      const ws = currentWorkspace()
      if (settled === true) await leftoversSettled()
      return allLeftovers((p) => workspaceFor(p) === ws)
    },
    'session:settleLeftovers': (p, agentId, how) => settleLeftovers(workspace.assertSessionHost(p), agentId, how === 'end' ? 'end' : 'keep'),
    // A notice's End Them / Keep Running (HI-2320): only what it listed, by id and start time, checked again first.
    'session:settleOffer': async (p, offer, how) => {
      workspace.assertSessionHost(p)
      if (typeof offer !== 'string' || !offer.startsWith('leftovers:')) throw new Error('not a leftovers offer') // i18n-ignore: a malformed call, never shown
      await settleOffer(offer, how === 'end' ? 'end' : 'keep')
    },
    'session:stopBackgroundAndResume': (p, agentId, jobId, sessionId, offer) => sessions.stopBackgroundAndResume(p, agentId, jobId, sessionId, typeof offer === 'string' ? offer : undefined),
    'session:handOver': (p, from, to, opts) => sessions.handOver(p, from, to, opts),
    'session:mayHandOverNow': (p, agentId) => mayHandOverNow(workspace.assertSessionHost(p), String(agentId)),
    // The long-conversation notice's Hand Over to… (HI-2320): only for the conversation it was about.
    'session:handOverOffer': async (p, agentId, sessionId) => {
      const host = workspace.assertSessionHost(p)
      if (!sessions.handOverOfferCurrent(host, String(agentId), String(sessionId))) return 'stale'
      return (await mayHandOverNow(host, String(agentId))) ? 'ok' : 'busy'
    },
    'session:allowLockedEdit': (p, agentId, path, offer) => sessions.allowLockedEdit(p, agentId, path, typeof offer === 'string' ? offer : undefined),
    'session:applyModes': (offer) => (typeof offer === 'string' && offer.startsWith('modes:') ? sessions.applyModeOffer(offer) : sessions.applyModeSettings()),
    'session:compact': (p, focus, agentId) => sessions.compact(p, focus, agentId),
    'session:pasteImage': (p, agentId) => sessions.pasteImage(p, agentId),
    'session:planAttach': (p, sources, agentId) => sessions.planAttach(p, sources, agentId),
    'session:attach': (p, sources, agentId) => sessions.attach(p, sources, agentId),

    // The user's own add (HI-2001): up to the most a project can have, past the workflow's Maximum agents.
    'agents:add': (p, opts) => projectAgents.addAgent(p, opts, 'user'),
    'agents:testLegacy': (p, opts) => {
      if (app.isPackaged) throw new Error('agents:testLegacy is for test copies') // i18n-ignore: a test channel, never shown
      return projectAgents.addLegacyAgent(p, opts)
    },
    'agents:memory': async () => ({ running: await agentsMemory(), total: totalmem(), free: freemem() }),
    'agents:update': (p, id, patch) => projectAgents.updateAgent(p, id, patch),
    'agents:remove': (p, id, opts) => projectAgents.removeAgent(p, id, opts),
    'agents:worktreeChecks': (p) => projectAgents.worktreeChecks(p),
    'agents:missingWorktree': (p, id) => missingWorktree(workspace.assertProject(p), String(id)),
    'agents:recreateWorktree': async (p, id) => {
      const project = workspace.assertProject(p)
      const def = await recreateWorktree(project, String(id))
      // At a new place: its sessions and data follow it now (or, if that fails, Repair… does).
      await finishPending(currentWorkspace(), project)
      await workspace.refresh()
      return def
    },
    'agents:unlinkWorktree': async (p, id) => {
      const def = await unlinkMissingWorktree(workspace.assertProject(p), String(id))
      await workspace.refresh()
      return def
    },
    'agents:move': (p, id, index) => projectAgents.moveAgent(p, id, index),
    'agents:swap': (p, id, other) => projectAgents.swapAgents(p, id, other),
    'agents:place': (p, layout, cells) => projectAgents.placePanes(p, layout, cells),
    'templates:list': (p) => templates.listTemplates(p),
    'templates:save': (p, scope, name, overwrite, usePatterns, includeWorkflow) => templates.saveTemplate(p, scope, name, overwrite, usePatterns === true, includeWorkflow !== false),
    'templates:plan': (p, scope, file, from, names) => templates.templatePlan(p, scope, file, from, names),
    'templates:load': (p, scope, file, expected, from, names, connections, applyWorkflow) => templates.loadTemplate(p, scope, file, expected, from, names, connections, applyWorkflow === true),
    'templates:addAgent': (p, scope, file, index, from, name, connection) => templates.addAgentFromTemplate(p, scope, file, index, from, name, 'user', connection),
    'templates:connectionsPlan': (p) => templates.connectionsPlan(p),
    'templates:applyConnections': (p, connections, expected) => templates.applyConnections(p, connections, { expected: Array.isArray(expected) ? expected : [] }),
    'templates:all': () => templates.listAllTemplates(),
    'templates:rename': (ref, name) => templates.renameTemplate(ref, name),
    'templates:update': (ref, edited, savedAt) => templates.updateTemplate(ref, edited, savedAt),
    'templates:duplicate': (ref, to) => templates.duplicateTemplate(ref, to),
    'templates:delete': (ref) => templates.deleteTemplate(ref),
    'templates:export': async (ref) => {
      // Checked before the dialog: a template that is gone or can't be used is said at once.
      const name = await templates.exportName(ref)
      const r = await dialog.showSaveDialog(win(), { title: tr(M.exportTemplate), defaultPath: join(app.getPath('downloads'), name), filters: [{ name: tr(M.templateFiles), extensions: ['json'] }] })
      if (r.canceled || !r.filePath) return null
      await requireMasking()
      await templates.exportTemplate(ref, r.filePath, maskDeep)
      return r.filePath
    },
    'templates:pickImport': async () => {
      const r = await dialog.showOpenDialog(win(), { title: tr(M.importTemplate), properties: ['openFile'], filters: [{ name: tr(M.templateFiles), extensions: ['json'] }] })
      if (r.canceled || !r.filePaths[0]) return null
      return templates.inspectImport(r.filePaths[0])
    },
    'templates:import': (path, to, onClash) => templates.importTemplate(path, to, onClash),
    'agents:gitInfo': (p) => projectAgents.gitInfo(p),
    'agents:worktreeMatch': (p, branch, base, name) => projectAgents.worktreeMatch(p, branch, base, name),
    'agents:branchStatus': async (p, id) => {
      const st = await projectAgents.branchStatus(p, id)
      branchWatch.record(p, id, st)
      return st
    },
    'agents:branchStatuses': () => branchWatch.statuses(),
    'agents:merge': async (p, id, opts) => {
      const path = workspace.assertProject(p)
      const branch = legacyWorktree(agentsOf(await workspace.projectConfig(path)).find((a) => a.id === id))?.branch
      return authorizedMerge(path, branch, opts, () => projectAgents.merge(p, id, opts))
    },
    'worktrees:unused': (p) => unusedWorktrees(p),
    'worktrees:unusedBranchStatus': (p, path) => unusedBranchStatus(p, path),
    'worktrees:mergeUnused': async (p, path, opts) => {
      const project = workspace.assertProject(p)
      const r = await authorizedMerge(project, await unusedBranchOf(project, path), opts, () => mergeUnused(p, path, opts))
      if (r.cleanedUp) storage.forgetStorage(p)
      return r
    },
    'worktrees:removalPreview': (p, path) => removalPreview(p, path),
    'worktrees:mergeBranches': (p) => mergeBranches(p),
    'worktrees:branchMergeStatus': (p, branch, target) => branchMergeStatus(p, branch, target),
    'worktrees:branchCards': async (p, branch) => {
      const path = workspace.assertProject(p)
      return { queue: await branchQueueCard(workspace, path, branch), line: await lineCard(path, branch) }
    },
    'worktrees:mergeBranch': async (p, branch, opts) => {
      const path = workspace.assertProject(p)
      return authorizedMerge(path, branch, opts, () => mergeBranch(path, branch, { target: opts.target, squash: opts.squash, message: opts.message }))
    },
    'worktrees:removeUnused': async (p, path, opts) => {
      const r = await removeUnusedWorktree(p, path, opts ?? {})
      if (r.deleted) {
        storage.forgetStorage(p)
        workspace.scheduleRefresh()
      }
      return r
    },

    'files:list': (p, rel) => files.listDir(p, rel),
    'files:create': (p, parent, name, isDir) => files.create(p, parent, name, isDir),
    'files:rename': (p, rel, name) => files.renameEntry(p, rel, name),
    'files:move': (p, rels, dest) => files.move(p, rels, dest),
    'files:copy': (p, rels, dest) => files.copy(p, rels, dest),
    'files:import': (p, sources, dest) => files.importPaths(p, sources, dest),
    'files:trash': (p, rels) => files.trash(p, rels),
    'files:find': (p, q) => files.find(p, q),
    'files:read': (p, rel) => files.readText(p, rel),
    'files:write': (p, rel, text, expected, bom) => files.writeText(p, rel, text, expected, bom),
    'files:open': async (p, rel) => {
      const err = await shell.openPath(files.absPath(p, rel))
      if (err) throw new Error(err)
    },
    'files:reveal': (p, rel) => shell.showItemInFolder(files.absPath(p, rel)),
    'files:linkFiles': (p, rels) => files.linkFiles(p, rels),
    'files:watch': (p) => files.watchProject(p),
    'files:setUnsaved': (paths) => quitControl.setUnsaved(win(), Array.isArray(paths) ? paths.filter((p) => typeof p === 'string') : []),
    'files:unwatch': (p) => files.unwatchProject(p),

    'attachments:list': (p) => files.listAttachments(p),
    'attachments:read': (p, path) => files.readAttachment(p, path),
    'attachments:trash': (p, path) => files.trashAttachment(p, path),
    'attachments:trashGroup': (p, id) => files.trashAttachmentGroup(p, id),
    'transcript:read': (p, id, opts) => transcripts.read(p, id, opts ?? {}),
    'transcript:tool': (p, id, itemId) => transcripts.tool(p, id, itemId),
    // A project or the Assistant's home (HI-1664: Activity's workspace level shows the Assistant too).
    'activity:now': async (p) => {
      p = workspace.assertSessionHost(p)
      return { launches: await launchesNow(p), tasks: sessions.backgroundTasks(p), blocks: sessions.hookBlocks(p) }
    },
    'activity:nowAll': (paths) => activityNowAll(paths),
    'activity:cardAgents': (card) => activityCardAgents(card),
    'activity:turns': (p, id, known) => transcripts.turns(p, id, known),
    'activity:sessions': (p, hours) => sessions.activitySessions(workspace.assertSessionHost(p), Math.max(1, Math.min(24 * 7, Number(hours) || 24))),
    'activity:detail': (p, id, itemId) => transcripts.detail(p, id, Number(itemId)),
    // The asking window's own workspace only, as team:endProcess (HI-2096): the `workspace` proxy would find another
    // window's by the path, so its process would end from here.
    'activity:endProcess': (p, agentId, pid, created) => endAgentProcess(contextWorkspace()!.assertSessionHost(String(p)), String(agentId), Number(pid), String(created)),
    'transcript:image': (p, id, imageId) => transcripts.image(p, id, imageId),
    'transcript:search': (p, query, id) => transcripts.search(p, query, id),
    'transcript:compactions': (p, id) => transcripts.compactions(p, id),
    'transcript:viewing': (view, p, id) => transcripts.viewing(win().webContents.id, view, p, id),
    'transcript:export': async (p, id, title) => {
      const safe = title.replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || id
      const r = await dialog.showSaveDialog(win(), {
        title: tr(M.exportTranscript),
        defaultPath: join(app.getPath('downloads'), `${safe}.md`),
        filters: [{ name: 'Markdown', extensions: ['md'] }] // i18n-ignore: a file format's name
      })
      if (r.canceled || !r.filePath) return null
      // No server connection's key in it (HI-1772), whatever the session printed: masked by every key's fingerprint, kept
      // since it was saved; refused, nothing written, while they can't be read.
      await requireMasking()
      await writeTextAtomic(r.filePath, maskKeys(await transcripts.markdown(p, id, title)))
      return r.filePath
    },
    'attachments:copyImage': async (path) => {
      // From its bytes: nativeImage reading a path itself is asar-aware (#246).
      const img = nativeImage.createFromBuffer(await readFile(guardFile(path)))
      if (img.isEmpty()) throw hiveError(M.notImage, undefined, { kind: 'invalid' })
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(img.toPNG())], { type: 'image/png' }) })])
    },

    'pty:write': (key, data) => {
      sessions.noteUserInput(key, data)
      writePty(key, data)
    },
    'pty:resize': (key, cols, rows) => resizePty(key, cols, rows),
    'pty:buffer': (key) => ptyBuffer(key),
    'pty:size': (key) => ptySize(key),
    'pty:kill': (key) => {
      if (key.startsWith('task:')) killPty(key)
    },
    'pty:clipboardRefused': (key, reason) => {
      log.info(`terminal ${userText(key)}: OSC 52 clipboard ${reason === 'read' ? 'read' : 'write'} refused (${String(reason).slice(0, 20)})`)
    },

    'skills:list': (p) => {
      skills.invalidateSkillCache()
      return skills.listSkills(p ? workspace.assertProject(p) : undefined)
    },
    'skills:workspace': () => skills.hiveSkills(true),
    'skills:create': async (name, description, targets) => {
      const s = await skills.createSkill(name, description, targets)
      emit({ type: 'skills-changed' })
      return s
    },
    'skills:pickFile': async () => {
      const r = await dialog.showOpenDialog(win(), {
        title: tr(M.addSkill),
        properties: ['openFile'],
        filters: [{ name: tr(M.skillFiles), extensions: ['md', 'markdown', 'zip'] }]
      })
      if (r.canceled || !r.filePaths[0]) return null
      return { path: r.filePaths[0], name: await skills.suggestSkillName(r.filePaths[0]) }
    },
    'skills:addFromFile': async (file, name, targets) => {
      const s = await skills.addSkillFromFile(file, name, targets)
      emit({ type: 'skills-changed' })
      return s
    },
    'skills:delete': async (path) => {
      await skills.deleteSkill(path)
      emit({ type: 'skills-changed' })
    },
    'skills:restoreBundled': async (name) => {
      const s = await skills.restoreBundledSkill(name)
      emit({ type: 'skills-changed' })
      return s
    },
    'skills:copyToWorkspace': async (path) => {
      const s = await skills.copySkillToWorkspace(path)
      skills.invalidateSkillCache()
      emit({ type: 'skills-changed' })
      return s
    },
    'skills:openFolder': () => void shell.openPath(workspace.skillsDir),
    'skills:files': (path, p) => skills.listedSkillFiles(path, p ? workspace.assertProject(p) : undefined),
    'skills:setDelivered': async (p, name, on) => {
      if (typeof name !== 'string' || !skills.validSkillName(name)) throw hiveError(msg({ id: 'content.skill.deliveredName', defaultMessage: 'That is not a skill name.', description: 'An error switching a skill on or off for agents (Skills → Delivered to agents): the name given is not a valid skill name.' }))
      if (p) await workspace.mutateProjectConfig(workspace.assertProject(p), (cfg) => ({ skillDelivery: withSkillDelivered(cfg.skillDelivery, name, on === true) }))
      else await workspace.saveWorkspaceConfigWith((c) => ({ skillDelivery: withSkillDelivered(c.skillDelivery, name, on === true) }))
      emit({ type: 'skills-changed' })
      workspace.scheduleRefresh()
    },

    'mcp:list': () => mcp.listMcp(true),
    'mcp:add': async (target, name, expected) => {
      await mcp.addMcpTo(target === 'assistant' ? 'assistant' : { project: workspace.assertProject(target) }, name, expected)
      emit({ type: 'skills-changed' })
      workspace.scheduleRefresh()
    },
    'mcp:remove': async (target, name) => {
      await mcp.removeMcpFrom(target === 'assistant' ? 'assistant' : { project: workspace.assertProject(target) }, name)
      emit({ type: 'skills-changed' })
      workspace.scheduleRefresh()
    },
    'mcp:places': async (name, expected, projects, assistant) => {
      // The projects are this window's workspace's (checked again in the turn, before the first write).
      const picks = projects && typeof projects === 'object' ? Object.fromEntries(Object.entries(projects).map(([p, on]) => [workspace.assertProject(p), on === true])) : {}
      try {
        return await mcp.setMcpPlaces(name, expected, picks, typeof assistant === 'boolean' ? assistant : undefined)
      } finally {
        emit({ type: 'skills-changed' })
        workspace.scheduleRefresh()
      }
    },
    'mcp:create': async (name) => {
      const m = await mcp.createMcp(name)
      emit({ type: 'skills-changed' })
      return m
    },
    'mcp:read': (name) => mcp.readMcp(name),
    'mcp:save': async (name, text, expected) => {
      const m = await mcp.saveMcp(name, text, expected)
      emit({ type: 'skills-changed' })
      workspace.scheduleRefresh()
      return m
    },
    'mcp:delete': async (name) => {
      await mcp.deleteMcp(name)
      emit({ type: 'skills-changed' })
      workspace.scheduleRefresh()
    },
    'mcp:projectServers': (p) => mcp.projectMcpServers(workspace.assertProject(p)),
    'mcp:importFromProject': async (p, names, shown) => {
      const imported = await mcp.importFromProject(workspace.assertProject(p), names, shown)
      emit({ type: 'skills-changed' })
      workspace.scheduleRefresh()
      return imported
    },
    'mcp:openFolder': () => void shell.openPath(workspace.mcpDir),
    'mcp:pickFile': async () => {
      const r = await dialog.showOpenDialog(win(), {
        title: tr(M.addMcp),
        properties: ['openFile'],
        filters: [{ name: tr(M.mcpFiles), extensions: ['json', 'zip'] }]
      })
      return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
    },
    'mcp:previewFile': (file) => mcp.previewMcpFile(file),
    'mcp:addFromFile': async (file, name, replace) => {
      const m = await mcp.addMcpFromFile(file, name, replace)
      emit({ type: 'skills-changed' })
      workspace.scheduleRefresh()
      return m
    },
    'mcp:catalog': (opts) => mcpCatalog.catalogPages(opts && typeof opts === 'object' ? opts : {}),
    'mcp:catalogNoted': (url) => mcpCatalog.noteCatalogSource(String(url)),
    'mcp:catalogPrepare': (source, name) => mcpCatalog.prepareCatalogServer(String(source), String(name)),
    'mcp:catalogDrop': (id) => mcpCatalog.dropPrepared(String(id)),
    'mcp:catalogInstall': async (id, name, replace) => {
      await mcpCatalog.installCatalogServer(String(id), String(name), replace === true)
      emit({ type: 'skills-changed' })
      workspace.scheduleRefresh()
    },
    'mcp:catalogUpdate': async (id, shown, places) => {
      const r = await mcpCatalog.updateCatalogServer(String(id), shown, { projects: Array.isArray(places?.projects) ? places.projects.filter((p): p is string => typeof p === 'string') : [], assistant: places?.assistant === true })
      emit({ type: 'skills-changed' })
      workspace.scheduleRefresh()
      return r
    },
    'mcp:catalogSources': () => config.settings.mcpCatalogs,
    'mcp:catalogSetSources': (next) => {
      const saved = mcpCatalog.setCatalogSources(next)
      emit({ type: 'settings-changed', settings: config.settings })
      return saved
    },

    'notes:tree': () => notes.notesTree(),
    'notes:create': (rel, isDir) => notes.createNote(rel, isDir),
    'notes:delete': (p) => notes.deleteNote(p),
    'notes:rename': (p, n) => notes.renameNote(p, n),

    'assistant:actions': () => (workspace.path ? assistantControl.actions(workspace.path) : []),
    'assistant:questions': () => (workspace.path ? assistantControl.questions(workspace.path) : []),
    'assistant:answer': (id, yes) => assistantControl.answer(id, yes),
    // Its question while its panel is hidden here (HI-2320): told once, as the routing table says.
    'assistant:tellQuestion': (id) => (workspace.path && typeof id === 'string' ? assistantControl.tellQuestion(workspace.path, id) : false),
    'assistant:switchMode': (modeId, save) => switchMode(String(modeId), save !== false),
    'assistant:revertSetting': async (actionId) => {
      if (!workspace.path) throw hiveError(M.noWorkspace, undefined, { kind: 'conflict' })
      await revertSetting(workspace.path, String(actionId))
    },
    // The window words what can't be undone in its language, from the reasons' codes (#1283).
    'assistant:changes': () => (workspace.path ? changeGroups(currentWorkspace()).map((g) => ({ ...g, changes: g.changes.map((c) => (c.final ? { ...c, finalWhy: finalWhys(c.final) } : c)) })) : []),
    'assistant:undo': async (sel) => {
      if (!workspace.path) throw hiveError(M.noWorkspace, undefined, { kind: 'conflict' })
      const s = sel && typeof sel === 'object' ? sel : {}
      const change = typeof s.change === 'string' && s.change ? s.change : undefined
      const group = typeof s.group === 'string' && s.group ? s.group : undefined
      if (!change === !group) throw hiveError(M.undoWhich, undefined, { kind: 'invalid' })
      try {
        return (await userUndo(currentWorkspace(), change ? { change } : { group })).map((r) => (r.final ? { ...r, finalWhy: finalWhys(r.final) } : r))
      } catch (e) {
        throw e instanceof UndoNotFound ? hiveError(M.undoGone, undefined, { kind: 'conflict' }) : e
      }
    },
    'mergeSlots:list': () => (workspace.path ? workspaceSlots(workspace.path) : []),
    'mergeSlots:release': (p, branch, holdId) => {
      if (typeof holdId !== 'string' || !holdId) throw hiveError(M.holdRequired, undefined, { kind: 'invalid' })
      return mergeSlots.releaseByUser(workspace.assertProject(p), slotBranch(branch), holdId)
    },
    'lanes:list': () => (workspace.path ? listLanes(currentWorkspace()) : []),
    'lanes:end': (id, abandoned) => {
      if (typeof id !== 'string' || !id) throw hiveError(M.laneRequired, undefined, { kind: 'invalid' })
      return endLane(currentWorkspace(), id, { abandoned: abandoned === true })
    },
    'lanes:retryFresh': (id) => {
      if (typeof id !== 'string' || !id) throw hiveError(M.laneRequired, undefined, { kind: 'invalid' })
      return retryFreshStart(currentWorkspace(), id)
    },
    'lanes:test': async (op) => {
      if (app.isPackaged) throw new Error('lanes:test is for test copies') // i18n-ignore: a test channel, never shown
      if (op?.op !== 'oweFresh' || typeof op.lane !== 'string' || (op.role !== 'builder' && op.role !== 'reviewer')) throw new Error('lanes:test: { op: "oweFresh", lane, role, minutesAgo? }') // i18n-ignore: a test channel, never shown
      return oweFreshForTest(currentWorkspace(), op.lane, op.role, typeof op.minutesAgo === 'number' ? op.minutesAgo : 0)
    },
    'loops:checks': (p, agentId) => {
      if (app.isPackaged) throw new Error('loops:checks is for test copies') // i18n-ignore: a test channel, never shown
      if (typeof agentId !== 'string' || !agentId) throw new Error('loops:checks: (projectPath, agentId)') // i18n-ignore: a test channel, never shown
      return loopChecksOf(workspace.assertProject(p), agentId)
    },
    'lanes:start': (p, req) => {
      const r = req && typeof req === 'object' ? req : ({} as LaneStartRequest)
      const cards = Array.isArray(r.cards) ? r.cards.filter((n: unknown): n is number => Number.isInteger(n) && (n as number) > 0).slice(0, 200) : []
      if (typeof r.builder !== 'string' || !r.builder) throw hiveError(M.laneBuilderRequired, undefined, { kind: 'invalid' })
      return startLaneFromWindow(currentWorkspace(), workspace.assertProject(p), { builder: r.builder, reviewer: typeof r.reviewer === 'string' && r.reviewer ? r.reviewer : null, pool: r.pool === true, cards, note: typeof r.note === 'string' ? r.note.slice(0, 4000) : '', name: typeof r.name === 'string' ? r.name.slice(0, 200) : null, ...(r.applyNow === true ? { applyNow: true } : {}) })
    },
    'lanes:startInfo': (p) => laneStartInfo(currentWorkspace(), workspace.assertProject(p)),
    'costs:cards': (q) => {
      if (!workspace.path) return []
      const numbers = Array.isArray(q?.numbers) ? q.numbers.filter((n) => Number.isInteger(n) && n > 0).slice(0, 1000) : undefined
      const time = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
      return cardCosts(currentWorkspace(), { numbers, project: typeof q?.project === 'string' ? q.project : null, from: time(q?.from), to: time(q?.to) })
    },
    'costs:rounds': (n) => (workspace.path && Number.isInteger(n) && n > 0 ? cardRoundCosts(currentWorkspace(), n) : null),
    'costs:lanes': (ids) => (workspace.path ? laneCosts(currentWorkspace(), Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : undefined) : []),
    'progress:list': async () => {
      const ws = workspace.path
      if (!ws) return []
      // Recent from before a restart joins the runs the first time the window asks (#352).
      await progress.loadHistory(ws)
      return progress.list(ws)
    },
    'progress:snapshot': async () => {
      const ws = workspace.path
      if (!ws) return { workspacePath: '', seq: 0, runs: [] }
      await progress.loadHistory(ws)
      // The list and the number of the last telling together: every telling sent after has a higher one (#1108).
      return { workspacePath: ws, seq: progressSeq(ws), runs: progress.list(ws) }
    },
    'progress:dismiss': (id) => {
      if (workspace.path) progress.dismiss(workspace.path, String(id))
    },
    'progress:stop': (id) => stopIsolated(workspace, String(id)),
    'progress:seen': () => {
      if (workspace.path) progress.seen(workspace.path)
    },
    'progress:openLog': async (id) => {
      const p = await runLog(id)
      if (!OPENABLE_LOG.test(p)) throw hiveError(M.logNotText, { file: basename(p) }, { kind: 'invalid' })
      const failed = await shell.openPath(p)
      if (failed) throw new Error(failed)
    },
    'progress:showLog': async (id) => shell.showItemInFolder(await runLog(id)),
    // The developer console (#636): this window's workspace's sources, and what it watches of them.
    'console:open': () => {
      const wc = senderStore.getStore()
      const owner = wc ? windowOf(wc) : null
      if (!owner) throw new Error('Not allowed') // i18n-ignore: a refusal of a page that isn't Hive's window (security, never shown)
      if (!config.settings.advanced.showDeveloperFeatures) throw hiveError(M.consoleHidden, undefined, { kind: 'conflict' })
      openConsoleWindow(owner)
    },
    'console:sources': () => consoleSources(currentWorkspace()),
    'console:options': () => ({ showText: consoleShowsText() }),
    'console:subscribe': (sources) => {
      const wc = senderStore.getStore()
      if (!wc) throw new Error('Not allowed') // i18n-ignore: a refusal of a page that isn't Hive's window (security, never shown)
      if (!Array.isArray(sources)) throw hiveError(M.sourcesList, undefined, { kind: 'invalid' })
      const ids = sources.filter((s): s is string => typeof s === 'string' && windowMayRead(s))
      const id = `window:${wc.id}`
      // A recording is of a source the window watches: watching another ends it, with what it captured until now.
      stopRecordingsWhere((w, _ws, recorded) => w === wc && !!recorded && !ids.includes(recorded), 'stopped')
      if (!ids.length) {
        consoleWindows.delete(id)
        devConsole.unsubscribe(id)
        return {}
      }
      consoleWindows.set(id, { wc, workspace: consoleWorkspace(wc) })
      if (!consolePages.has(wc)) {
        consolePages.add(wc)
        wc.once('destroyed', () => {
          consoleWindows.delete(id)
          devConsole.unsubscribe(id)
        })
      }
      const deliver = (events: ConsoleEvent[], dropped: number): void => {
        if (!wc.isDestroyed()) wc.send('hive:event', { type: 'console-events', events, ...(dropped ? { dropped } : {}) })
      }
      // Text only while the setting is on, whatever the page asks.
      return Object.fromEntries(devConsole.subscribe(id, ids, { deliver, includeText: consoleShowsText() }))
    },
    'console:snapshot': (source, since) => {
      const wc = senderStore.getStore()
      // Only what this window watches, and may read in the workspace it shows now.
      if (!wc || !windowMayRead(String(source))) return []
      return devConsole.eventsFor(`window:${wc.id}`, String(source), Number(since) || 0)
    },
    // Recording a source this window may read to a file (#638).
    'console:record': async (source, opts) => {
      const wc = senderStore.getStore()
      const id = String(source)
      const row = wc && windowMayRead(id) ? consoleSources(currentWorkspace()).find((s) => s.id === id) : undefined
      if (!wc || !row) throw hiveError(M.notSource, undefined, { kind: 'forbidden' })
      const shown = consoleWorkspace(wc)
      // Only while the window still watches that source in this workspace: a start overtaken by a close, another
      // source or another workspace records nothing.
      const stillWanted = (): boolean => consoleWorkspace(wc) === shown && devConsole.sourcesOf(`window:${wc.id}`).includes(id)
      return startRecording(wc, row, shown, opts?.includeText === true, stillWanted)
    },
    'console:stopRecording': async () => {
      const wc = senderStore.getStore()
      return wc ? stopRecording(wc.id, 'stopped') : null
    },
    'console:recordings': async () => {
      const wc = senderStore.getStore()
      return { active: wc ? recordingOf(wc.id) : null, latest: await latestRecording() }
    },
    'console:captures': () => listCaptures(),
    'console:showRecording': (name) => {
      // Only Hive's own recordings, by name, in its folder: never a path the page gives.
      if (typeof name !== 'string' || !isRecordingName(name)) throw hiveError(M.notRecording, undefined, { kind: 'invalid' })
      shell.showItemInFolder(join(recordingsDir(), name))
    },
    'modes:list': () => modes.listModes(),
    'modes:create': async (name) => {
      const p = await modes.createMode(name)
      workspace.emit({ type: 'modes-changed' })
      return p
    },
    'modes:delete': async (id) => {
      await modes.deleteMode(id)
      workspace.emit({ type: 'modes-changed' })
    },
    'modes:restore': async (id) => {
      const p = await modes.restoreMode(id)
      workspace.emit({ type: 'modes-changed' })
      return p
    },

    'file:read': async (p) => readFile(guardFile(p), 'utf8').catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? '' : Promise.reject(e))),
    'file:write': (p, content, expected) => writeTextUnlessChanged(guardFile(p, true), content, expected),

    'memory:list': async (p) => {
      const project = workspace.assertProject(p)
      return (await Promise.all(allProviders().map((a) => a.memorySources(project, connectionHomes(a.id, workspace.config))))).flat()
    },
    'memory:instructionsShared': async (p, ids) => {
      const project = workspace.assertProject(p)
      return instructionsShared(await projectInstructions(project, ids.map(knownProvider)))
    },
    'memory:shareInstructions': async (p, ids) => {
      const project = workspace.assertProject(p)
      const list = await projectInstructions(project, ids.map(knownProvider))
      const shared = await readFile(join(project, SHARED_INSTRUCTIONS), 'utf8').catch(() => null)
      const writes = shareInstructions(list, shared, basename(project))
      for (const [file, text] of Object.entries(writes)) await writeTextAtomic(join(project, file), text)
      return Object.keys(writes)
    },

    // An unused worktree too (#400): read only, as the Changes tab opens it.
    'git:status': (root, base) => gitStatus(workspace.assertChangesRoot(root), base),
    'git:diff': (root, f, base) => gitDiff(workspace.assertChangesRoot(root), f, base),
    'git:compareLines': async (p) => {
      p = workspace.assertProject(p)
      // The slots as the board records them: a plain read, never the slot pool or the 0.9 migration (it runs as the project opens).
      const slots = (await boardSlots(p)).map((s) => ({ name: s.name, folder: s.folder, card: s.open?.card ?? null, agent: s.open?.agent ?? null, target: s.target ?? null }))
      return compareLines(p, await workTargetOf(p), slots)
    },
    'git:leftovers': async (p) => {
      p = workspace.assertProject(p)
      return leftoverInfo(p, await workTargetOf(p))
    },
    'git:compare': (p, base, head, page, pinBase, pinHead) => compareBranches(workspace.assertProject(p), String(base ?? ''), String(head ?? ''), Number(page) || 1, { base: pinBase, head: pinHead }),
    'git:compareDiff': (p, base, head, f, pinned) => compareDiff(workspace.assertProject(p), String(base ?? ''), String(head ?? ''), String(f ?? ''), pinned && typeof pinned === 'object' ? pinned : null),
    // The file of the diff shown (#495): in the folder the Changes tab shows, which may be an unused worktree outside the
    // workspace that file IPC (guardFile) doesn't reach; inside it by its real location too, so a link can't lead out.
    'changes:openFile': (root, f) => {
      const dir = workspace.assertChangesRoot(root)
      const file = resolve(dir, f)
      if (file === dir || !insideReal(file, [dir]) || insideArchive(file)) throw hiveError(M.notFileOf, { file: f, folder: dir }, { kind: 'forbidden' })
      void shell.openPath(file)
    },
    'git:tool': (recheck) => (recheck ? checkGit() : gitTool()),
    // The Git view (#607): the project folder only, read and changed by the user from the window (never an agent tool).
    'git:summary': (p) => repoSummary(workspace.assertProject(p)),
    'git:info': async (p) => {
      p = workspace.assertProject(p)
      const info = await repoInfo(p, await workTargetOf(p))
      // Hive's own worktrees said as such (HI-1710): its review copies and the merge queue's folder.
      return { ...info, worktrees: info.worktrees.map((w) => {
        const hive = hiveWorktreeOf(p, w.path)
        return hive ? { ...w, hive } : w
      }) }
    },
    'git:deleteBranches': (p, items, unmerged) => deleteBranches(p, Array.isArray(items) ? items : [], !!unmerged),
    'git:deleteRemoteBranches': (p, remote, items) => deleteRemoteBranches(p, String(remote ?? ''), Array.isArray(items) ? items : []),
    'git:branchDrops': (p, name) => branchDrops(p, String(name ?? '')),
    'git:history': async (p, ref, page) => {
      p = workspace.assertProject(p)
      return repoHistory(p, { ref: typeof ref === 'string' ? ref : null, page: Number(page) || 1, workTarget: await workTargetOf(p) })
    },
    'git:switch': (p, branch) => switchBranch(p, String(branch ?? '')),
    // Update from <target> (HI-1180): what it would do, for its dialog, and the update itself.
    'git:updatePlan': (p, branch) => branchUpdatePlan(p, String(branch ?? '')),
    'git:updateBranch': (p, branch, how) => updateBranch(p, String(branch ?? ''), how === 'rebase' ? 'rebase' : 'merge'),
    'git:createBranch': (p, name, stay) => createBranch(p, String(name ?? ''), !!stay),
    'git:addRemote': (p, name, url) => addRemote(p, String(name ?? ''), String(url ?? '')),
    'git:setRemoteUrl': (p, name, url) => setRemoteUrl(p, String(name ?? ''), String(url ?? '')),
    'git:fetch': (p) => fetchAll(p),
    'git:pull': (p) => pull(p),
    'git:push': (p, remote) => push(p, remote ? String(remote) : undefined),
    'git:pushTo': (p, remote, scope, branch) => pushToRemote(p, String(remote ?? ''), scope === 'all' ? 'all' : 'branch', branch ? String(branch) : undefined),
    'git:remoteTracking': (p, remote) => remoteTracking(p, String(remote ?? '')),
    'git:removeRemote': (p, name, expected) => removeRemote(p, String(name ?? ''), Array.isArray(expected) ? expected.map(String) : undefined),
    'git:renameRemote': (p, from, to) => renameRemote(p, String(from ?? ''), String(to ?? '')),
    'git:setUpstream': (p, branch, remote, remoteBranch, pushFirst) => setUpstream(p, String(branch ?? ''), remote == null ? null : String(remote), String(remoteBranch ?? ''), !!pushFirst),
    'git:createTag': (p, name, message, pushTo) => createTag(p, String(name ?? ''), String(message ?? ''), pushTo ? String(pushTo) : undefined),
    'git:setIdentity': (p, name, email) => setIdentity(p, String(name ?? ''), String(email ?? '')),
    'git:initCheck': (p) => initCheck(p),
    'git:init': (p, opts) => initRepo(p, opts && typeof opts === 'object' ? opts : { gitignore: 'none' }),

    'provider:info': () => providerService.shown(),
    'provider:refresh': async (id) => {
      // Provider Setup's Check again looks at git too (#346), on the PATH a new process would get (#472).
      await refreshPath()
      await Promise.all([providerService.refresh(id, true), checkGit()])
      return providerService.shown()
    },
    'provider:task': async (id, task) => {
      await refreshPathBeforeStart()
      return providerService.runProviderTask(id, task)
    },
    'provider:retryUpdate': async (id) => {
      await refreshPathBeforeStart()
      return providerService.runProviderTask(id, 'update', true)
    },
    'provider:stopAgents': (id) => sessions.stopProvider(id),

    'connections:list': (check) => accountsView(check === true),
    'connections:add': (id, name) => addAccount(id, name),
    'connections:rename': (id, name) => renameAccount(id, name),
    'connections:remove': (id, opts) => removeAccount(id, { closeTerminal: opts?.closeTerminal === true }),
    'connections:signIn': async (id) => {
      await refreshPathBeforeStart()
      return signInAccount(id)
    },
    // A server connection (HI-1772): the key crosses here once, from its field to the key store, and never back.
    'connections:addServer': (input) => addServerConnection(input),
    'connections:editServer': (id, patch) => editServerConnection(id, patch),
    'connections:setKey': (id, key) => setServerKey(id, typeof key === 'string' ? key : ''),
    'connections:removeKey': (id) => removeServerKey(id),
    'connections:readModels': (id, request) => readServerModels(id, String(request)),
    'connections:cancelModels': (id, request) => cancelServerModels(id, String(request)),
    'connections:setUp': async (id) => {
      await refreshPathBeforeStart()
      // A sign-in connection's Set Up (HI-1826): the CLI on its folder, for the first-run screens its sign-in leaves.
      // Opened in the first folder of this workspace it doesn't trust yet, so the CLI asks there (HI-1870); else its own.
      const place = await setUpPlace(id)
      const key = await (isServer(getAccount(id)) ? setUpServerConnection(id, place?.folder) : setUpSignInConnection(id, place?.folder))
      // Where it opened, for its terminal's hint (HI-1871 round 1): the place used, not the one the window showed.
      return { key, ...(place ? { in: place } : {}) }
    },
    'connections:resetMasking': async () => {
      await resetMasking()
      emit({ type: 'connections-changed' })
    },
    'connections:keepLogin': (id) => keepNewLogin(id),
    'connections:setOn': (id, on) => setAccountOn(id, on),
    'connections:setUsageMove': (id, rule) => setUsageMove(String(id), rule ?? null),
    'connections:move': (id, index) => moveConnection(id, Number(index)),
    'connection:add': (account, input) => addConnection(String(account), connectionInput(input) as ConnectionPatch & { name: string }),
    'connection:update': (id, patch) => updateConnection(String(id), connectionInput(patch)),
    'connection:duplicate': (id) => duplicateConnection(String(id)),
    'connection:remove': (id) => removeConnection(String(id)),
    'connection:move': (id, index) => moveConnectionInAccount(String(id), Number(index)),
    'connections:switchAffected': () => sessions.switchAffected(workspace.path!),
    'connections:notice': () => movedNotice(workspace),
    'connections:dismissNotice': (keys) => dismissMovedNotice(workspace, Array.isArray(keys) ? keys.filter((k) => typeof k === 'string') : []),
    'connections:dismissIntro': () => dismissConnectionsIntro(),
    'session:switchConnection': (p, agentId) => sessions.switchAtSafePoint(p, agentId),

    'api:info': () => apiInfo(),
    'api:regenerateToken': async () => {
      await regenerateToken()
      return apiInfo()
    },
    'api:createViewer': (name) => createViewer(String(name ?? '')),
    'api:revokeViewer': (id) => revokeViewer(String(id ?? ''))
  }

  // Tests only (unpackaged builds), so a suite can see what the window does while an action runs or fails:
  // HIVE_TEST_SLOW_IPC="tasks:start=1500,git:diff=1500*1" delays those calls (`*n`: only the first n), and
  // HIVE_TEST_FAIL_IPC="git:status*1" makes them fail, and HIVE_TEST_BLOCK_IPC="app:info=1500*1" holds the main process
  // that long in them (a stall, #1109).
  // A suite may change them while Hive runs (in the main process): they are read again when they change.
  type TestCalls = { from: string; calls: Map<string, { ms: number; left: number }> }
  const testCalls = (name: string, held: TestCalls): TestCalls => {
    const from = app.isPackaged ? '' : (process.env[name] ?? '')
    if (from === held.from) return held
    const calls = new Map(
      from
        .split(',')
        .map((x) => x.trim().match(/^([^=*]+)(?:=(\d+))?(?:\*(\d+))?$/))
        .filter((m): m is RegExpMatchArray => !!m)
        .map((m) => [m[1], { ms: Number(m[2] ?? 0), left: m[3] ? Number(m[3]) : Infinity }] as const)
    )
    return { from, calls }
  }
  let slow: TestCalls = { from: '', calls: new Map() }
  let failing: TestCalls = { from: '', calls: new Map() }
  let blocking: TestCalls = { from: '', calls: new Map() }
  const take = (t: TestCalls, channel: string): { ms: number } | null => {
    const c = t.calls.get(channel)
    if (!c || c.left <= 0) return null
    c.left--
    return c
  }
  for (const [channel, fn] of Object.entries(impl)) {
    ipcMain.handle(channel, async (e, ...args: unknown[]) => {
      // Only Hive's own pages may call: not another window, and not a frame inside one (e.g. an HTML preview). A developer
      // console's page calls only the console's channels, in the workspace of the window it belongs to (#637).
      const w = windowOf(e.sender) ?? (CONSOLE_WINDOW_CHANNELS.has(channel) ? consoleOwner(e.sender) : null)
      if (!w || e.senderFrame?.parent) throw new Error('Not allowed') // i18n-ignore: a refusal of a page that isn't Hive's window (security, never shown)
      slow = testCalls('HIVE_TEST_SLOW_IPC', slow)
      failing = testCalls('HIVE_TEST_FAIL_IPC', failing)
      blocking = testCalls('HIVE_TEST_BLOCK_IPC', blocking)
      const delay = take(slow, channel)
      if (delay?.ms) await new Promise((r) => setTimeout(r, delay.ms))
      if (take(failing, channel)) throw new Error(`${channel} failed (HIVE_TEST_FAIL_IPC)`) // i18n-ignore: test-only
      // Named in a "main process was busy" warning that it overlaps (mainStalls.ts).
      const done = beginWork(`ipc ${channel}`) // i18n-ignore: a line of hive.log, in English
      // Everything the call does is for that window's workspace (and from that window: the console's subscriptions).
      try {
        const block = take(blocking, channel)
        if (block?.ms) for (const until = Date.now() + block.ms; Date.now() < until; );
        return await senderStore.run(e.sender, () => inWorkspace(w.ws, () => (fn as (...a: unknown[]) => unknown)(...args)))
      } catch (err) {
        // A failure that isn't one of Hive's own refusals (a file that couldn't be written, HI-1749): the window shows it, and
        // hive.log has it too, so every "Could not …" notification has its line.
        if (!(err instanceof HiveError)) log.warn(`ipc ${channel} failed: ${userText(englishError(err))}${typeof (err as NodeJS.ErrnoException)?.code === 'string' ? ` (${(err as NodeJS.ErrnoException).code})` : ''}`)
        throw windowError(err)
      } finally {
        done()
      }
    })
  }
}

/** A merge queue's target as the window names it (a branch): refused when it isn't one. */
function queueTarget(target: unknown): string {
  if (typeof target !== 'string' || !target || target.length > 255 || /[\s~^:?*[\\]/.test(target)) throw new HiveError({ lines: ['A merge queue is named by its target branch'] }, { kind: 'invalid' }) // i18n-ignore: a mistake in Hive's code, never shown
  return target
}
