import { endReason, type SessionEnd, type StopCause } from '../shared/sessionEnd'
import type { ActivityTask } from '../shared/activity'
import { maskText } from '../shared/redact'
import { randomUUID, randomBytes } from 'crypto'
import { StepTimes } from './stepTimes'
import { fmt, msg, onLanguageChange, tr } from '../shared/i18n'
import { COPIES_REVIEW, PROMPT_AS_TYPED, PROMPT_CLEAR_DRAFT, SIGN_FAIL_FAST, SIGN_TIMEOUT, drawnWaitId, englishText, overrideId, shownText, withValues, type Text, type TextPart } from '../shared/advanced'
import { launchPolicy, MCP_ISOLATION, terminalPreset, type LaunchPolicy } from '../shared/launchPolicy'
import { capturedText, errorText, combworkError, CombworkError, shownError } from './combworkError'
import { assertUpgraded } from './boardStore'
import { advanced } from './advanced'
import { withSessionSigner, type SessionSigner } from './platform/signerRules'
import { folderChanging, folderSteady, inFolder } from './folderFence'
import { basename, dirname, isAbsolute, join, resolve } from 'path'
import { copyFile, lstat, mkdir, open, readdir, rename, rm, rmdir, stat, writeFile } from 'original-fs/promises'
import { constants as fsConstants, existsSync, realpathSync } from 'original-fs'
import { TYPED_NEWLINE_KEYS, typedText } from '../shared/terminalInput'
import { failedStart, type StartFailure } from '../shared/startFailure'
import { startBegins, startFailed } from './agentStarts'
import { BrowserWindow, app, clipboard } from 'electron'
import { ASSISTANT_DIR, ASSISTANT_NAME } from '../shared/assistant'
import { formatDateTime } from '../shared/dates'
import { formatSize } from '../shared/units'
import { backgroundTaskMinutes } from '../shared/tasks'
import { assistantTools, hiddenForSide, isReservedServerName, sideAllows, toolSideOf, TOOLS_SERVER, workflowAllows, workflowHiddenOf } from '../shared/assistantTools'
import { CW_DIR, isCompacting, agentPtyKey, assertSessionId, cliRename, isSessionId, launchedWithOf, projectAgents, resumeRecord, transcriptWarnLimit } from '../shared/defaults'
import { defaultPurpose, legacySetupPending, legacyWorktree, namedFolders, type StoredAgent, resumeHold, resumeHome, shownPlace, slotAt, type FolderFacts, type FolderPurpose, type NamedFolder, type FolderSlot, type ResumeHold } from '../shared/agentFolders'
import { holdText } from '../shared/sessionResume'
import { coalesced, joined } from '../shared/coalesce'
import { atMost, whenAll } from '../shared/atMost'
import { agentPlace, bindSession, claimPlace, ClaimRefused, folderAgent, folderFacts, heldSlots, releaseWriter, settleWriter, slotHeldWords } from './agentFolders'
import { slotEnv } from './slots'
import { copiesDirOf, grantsCopies } from './copies'
import { agentWorkflowRole, inWorkflow, launchWorkflow, reviewsWork, type LaunchWorkflow } from '../shared/workflow/roles'
import { agentLaunchSettings, agentProvider, autoProviderPending, canSwitchModeLive, extraArgsProblem, isProviderEnabled, modeAllowed, permissionLabel, providerDescriptor, providerSettings, splitArgs, tasksWillWake } from '../shared/providers'
import { isCliOwnMode, modeInEffect } from '../shared/cliOwnMode'
import { accountInfo, dialectModelId, modelIdName, modelSwitched, resolvedModel } from '../shared/models'
import type {
  AutoCompactSetting,
  AgentDef,
  AgentInfo,
  EffortLevel,
  FileLockMode,
  HookCause,
  HooksMissing,
  LaunchDialect,
  LiveSessionState,
  ModelSwitch,
  RuntimeFacts,
  McpServerDef,
  AgentInstallInfo,
  McpServerInfo,
  PermissionMode,
  ProjectConfig,
  ProviderId,
  InboxSummary,
  SessionBulkAction,
  SessionBulkProgress,
  SessionBulkResult,
  Attached,
  AttachmentPlan,
  SessionListItem,
  NotifyKind,
  ToastTarget,
  SessionRecord,
  SessionSkipReason,
  CombworkErrorKind,
  SubSession,
  SessionStatus,
  SkillInfo,
  SessionUsage,
  TaskWatchInfo,
  ToastAction,
  StartedSession
} from '../shared/types'
import { provider as providerAdapter, allProviders } from './providers'
import { runSwitch, SlotHeld, SwitchIntents, type SwitchOp, type UsageIntent } from './connectionSwitch'
import { agentLaunchView, allAccounts, allConnections, checkAccount, firstUsableAccount, getConnection, launchOnChosen, onConnectionSignedIn, setAccountSessions, type LaunchConnection } from './accounts'
import { effortUsable, ensureMigrated, migrationDue } from './connectionMoves'
import { resolveAgentConnection } from '../shared/accounts'
import { connectionSwitchDue } from '../shared/connectionLabel'
import { ptyArgs, recacheEstimate, withoutAccountEnv, withServerEnv } from './providers/common'
import { GZ, compressFile, decompressTo, expandBackup, isGz } from './transcriptFiles'
import { usesOwnPrices } from '../shared/prices'
import { priceUsage, withCostFree } from '../shared/usageDays'
import { summaryOf, usageFromRows, type LedgerRow } from '../shared/usageLedger'
import type { AdoptionHandle, Ask, BackgroundTaskType, ExternalSession, HookEvent, HookOccurrence, LaunchContext, LaunchHooks, LaunchSkill, LiveDetails, NormalizedHook, ProviderAdapter, SkillDelivery } from './providers/types'
import { HOOK_FIRED_MAX, HOOK_SHORT_MAX, clip, type ActivityHookBlock, type HookFired, type SessionHooks } from '../shared/hooks'
import { providerService } from './providerService'
import { config } from './config'
import { emit, emitTo, onCombworkEvent, toast } from './events'
import { presentWindow, testNotifyLog, testQuiet } from './testQuiet'
import { admitLaunch, endAdmission, setLiveFolders } from './launchHolds'
import { hashText, heldOpen, insideReal, isInUse, placeRelative, removePath, samePlace, treeSignature, syncCopy, syncCopyLocked, syncCopyNow, trashAllOrNothing, withFileLock } from './fsutil'
import { createLogger, hookJournal, userText } from './logger'
import { HOOK_AUTH_FILE_ENV, HOOK_URL_ENV } from '../shared/claudeHookHandlers'
import { COMPACTING_TEXT, HOOKS_DOUBLED_NOTE, hooksMissingNote, addRetryWaited, retryWaitCurrent } from '../shared/runtime'
import { applyStep, compactionOver, expireTasks, failedTurnStep, hookStep, idleAfter, idleQuestionGone, markedIdle, safeguardAnswered, SAFEGUARD_IDLE_MESSAGE, startupScreen, startupWatched, titleStep, type HookStatusInput, type HookStep } from './hookStatus'
import { latestStop, memoModel, memoTools, memoTurn, newTurn, noteSafeguard, placeEvent, safeguardComment, safeguardText, seenInTurn, withScreenStops, type GuardTurns, type SafeguardEvent, type ScreenStop } from '../shared/safeguards'
import { applyStatus, idleNow, NO_STATUS, type StatusState } from './statusLineState'
import { acceptTurn, admit, describe as describeTurn, endRunning, expectInjected, failureTurn, heard, newLedger, openCalls, reconciles, silentFor, unheardStop, type ScreenReading, type TurnLedger } from './turnLedger'
import { Compaction } from './compaction'
import { lastTerminalTurn, lastTitle, type TerminalTurn } from './terminalTitle'
import { asksYou } from '../shared/inbox'
import type { DeliveryHooks, NewDelivery } from './deliveries'
import { readyFor } from './readiness'
import { HAND_OVER_TEXT, handOverNow } from '../shared/handOver'
import { NOTICE_PREFIX } from '../shared/doorbell'
import { FinishBatcher, finishedApiTitle, finishedApiTitleText, finishedNotice } from '../shared/bursts'
import { notifyRoute, type NotifyRoute } from '../shared/notify'
import { askOffer, focusedCombwork, notifyPending, offerOpen, resolveOffer, resolveOffers, tell } from './notify'
import { OUTCOME } from './outcomes'
import type { SlotNote } from './mergeSlots'
import { commentOnDoingCards, recordCards } from './cardSessions'
import { listMcp, toLaunchDef } from './mcp'
import { agentGetsMcp, assistantMcpAdded, serverOnIn } from '../shared/agentMcp'
import { launchEnded, leftoversOf, leftoversOffer, noteUntracked, settleLeftovers, STOPPED_BEFORE_START, trackingProblemText, trackingReady, trackLaunch, type TrackResult } from './agentProcesses'
import type { GateWord } from './launchGate'
import { leftoversSummary, processCount } from '../shared/agentProcesses'
import { childEnv, hasPty, killPty, refreshPty, spawnPty, startSize, writePty } from './ptyHost'
import { refreshPathBeforeStart } from './freshPath'
import { TerminalScreen } from './terminalScreen'
import { heldLineLost } from './heldLine'
import { KeysStopped, PickNotFound, typeKeySteps } from './keySteps'
import { withBinOnPath } from './progressReporters/shims'
import { combworkSkills, parseSkillFrontmatter, skillFor } from './skills'
import { copyBook, sessionEnded } from './skillCopies'
import { workspaceNotesFor } from './workspaceNotes'
import { independentIn } from './independent'
import { skillOff } from '../shared/skillDelivery'
import { samePath } from '../shared/movePaths'
import { chainGuidanceRevision, GUIDANCE_REVISION, launchParts, launchRecord } from './guidance'
import { say, setChainResolver } from '../shared/agentText'
import { inDefaultDialect, inDialectOf } from '../shared/agentText/asyncScope'
import { agentTextSchema, chainKey, dialectsDir, loadDialects, pickOf, sessionChainOf, writeDialectFile, type DialectSet, type ModelSlot, type ResolvedChain, type SessionDialect } from './dialects'
import { dialectModelSuggestions } from './dialects/suggestions'
import { apiChainChanged, forgetApiChain, requestApiChain } from './dialects/apiChain'
import type { DialectUsage } from '../shared/dialects'
import { SESSION } from './sessionText'
import { forgetConnectionUsage, reportPlanUsage } from './planUsage'
import { devConsole, sessionSourceId } from './devConsole'
import { flightRecorder } from './flightRecorder'
import { DETAILS_FIELDS, HOOK_FIELDS, HOOK_MADE_FIELDS, STATUSLINE_FIELDS, safeWord } from '../shared/devConsole'
import { hookSummary, launchEvent, statusLineSummary, transcriptEvent } from './devConsoleWords'
import { ScreenRecognition } from './screenRecognition'
import { revisionOf } from './revisions'
import { metricsHandle, recordLaunch } from './metrics'
import { headerOf } from './revisions'
import { utf8Bytes } from '../shared/metrics'
import { cardNamesOf, scopeOfHost } from './projectKeys'
import { inWorkspace, openWorkspaces, workspace, workspaceFor, workspaceOf, WorkspaceService, type SessionsFile } from './workspace'
import { githubHostsFor } from './githubHosts'
import { agentTempSetting, prepareAgentTemp, protectedFolders, withAgentTemp } from './agentTemp'
import { ServerMarks } from './serverMarks'
import { usageHistory, type StoredUsage } from './usageHistory'
import { journalSettingsOf } from './journalService'
import { endAgentToken, newAgentToken } from './agentTokens'
import { endHookToken, hooksRefused, newHookToken } from './hookTokens'
import { lookAtTurns, type TurnsReading } from './turnsReader'
import { hookSeen, hookTurn, hooksMissing, newHooksWatch, noteHooksMissing, promptSent, SeenOnce, transcriptReset, transcriptTurns, turnHeard, typedPending, type HooksWatch } from './hooksHealth'
import { beingRead, viewingWindows } from './transcriptReads'
import { trash } from './trash'
import { attachmentName, attachmentsDir, freeName, ownAttachmentsFolder } from './attachmentsFolder'
import { attachmentKind } from '../shared/attachments'
import { replyStart } from '../shared/tiles'
import { observer } from './platform/observe'
import { projectPreferences } from './workflow/preferences'
import { driveExitKeys, type ExitKeysIO } from './exitKeys'
import { movedFolders, movedPath } from './combworkMove'
import { freshReasonOf, SESSION_NAMES, type FreshReason } from '../shared/sessionFresh'
import type { FolderMove } from '../shared/combworkFolderMove'

const log = createLogger('sessions')

/** How long starts are quiet before the notice of conversations started fresh is shown (a restart resumes several at once). */
const RENAMED_NOTICE_QUIET_MS = 5_000
const RENAMED_FRESH = {
  title: msg({ id: 'session.renamedFresh.title', defaultMessage: 'Agents started new conversations', description: 'A notice once after the update that renamed what agents see (HI-2463): conversations from before were started fresh.' }),
  body: msg({ id: 'session.renamedFresh.body', defaultMessage: "{n, plural, one {# conversation} other {# conversations}} started fresh: Combwork renamed the tools agents use, so a conversation from before can't continue. The earlier ones are kept in Sessions to read.", description: 'The notice after the update that renamed what agents see (HI-2463). {n} counts the conversations that started fresh instead of resuming. Sessions is a tab of the window: keep it as the window names it.' })
}

/** The notice for conversations whose folder moved with a pre-1.1 data folder to `.combwork` (HI-2462). */
const MOVED_FRESH = {
  title: RENAMED_FRESH.title,
  body: msg({ id: 'session.movedFresh.body', defaultMessage: "{n, plural, one {# conversation} other {# conversations}} started fresh: {n, plural, one {its folder} other {their folders}} moved to .combwork with the old data folders, so {n, plural, one {it} other {they}} can't continue there. The earlier ones are kept in Sessions to read.", description: 'The notice after a workspace\'s old data folders moved to .combwork (HI-2462): conversations that ran in a folder inside one started new conversations instead of resuming. {n} counts them. Keep .combwork as it is; Sessions is a tab of the window.' })
}

/** The statuses in which a CLI's exit key cancels a turn (or its dialog) rather than arming its exit (HI-2272). */
const EXIT_IN_TURN: ReadonlySet<SessionStatus> = new Set<SessionStatus>(['starting', 'working', 'waiting'])
/** A stop's causes that are someone's Stop (HI-2815): the user's, the Assistant's, an agent's; not a lane's end, a closed window or one unsaid. */
const STOPPED_ON_PURPOSE: ReadonlySet<StopCause> = new Set<StopCause>(['you', 'assistant', 'agent'])
/** The statuses of an agent in a turn (or starting one): reached from any other, its next turn has begun (HI-2312). */
const BUSY: ReadonlySet<SessionStatus> = new Set<SessionStatus>(['starting', 'working', 'waiting'])

/**
 * Combwork's own words for sessions (#847, E10c of #677): errors (CombworkErrors, in the window's language through IPC and in
 * English for the Agent API), statuses (LiveSessionState.statusText beside the English statusMessage), notices (a
 * translated title with its English for the Agent API's stream) and toasts. Text agents read (prompts Combwork types, lock
 * replies, deliveries), the log and the developer console stay English.
 */
const M = {
  modelSwitchTitle: msg({ id: 'session.model.switchedTitle', defaultMessage: '{agent} runs another model', description: "A notice's title (HI-2609): an agent's coding agent now runs another model than Combwork started it with (its connection's). {agent} is the agent." }),
  modelSwitch: msg({ id: 'session.model.switched', defaultMessage: "{cli} now runs {running}, not {launched}, which its connection gave it. Restart the agent to go back to {launched}.", description: "The notice that an agent runs another model (HI-2609): its coding agent ({cli}, e.g. Codex) changed model by itself or at a prompt of its own. {running} and {launched} are model names (\"GPT-6 Luna\"); its connection is the account Combwork started it on." }),
  assistantCliOwn: msg({ id: 'session.mode.assistantCliOwn', defaultMessage: "The Assistant can't use the CLI's own setting: its Control setting relies on knowing the mode it runs in. Choose one of the CLI's modes.", description: "Switching the Combwork Assistant to the permission choice \"The CLI's own setting\" is refused. Control is the name of an Assistant setting." }),
  connectionFallbackTitle: msg({ id: 'session.connection.fallbackTitle', defaultMessage: '{agent} runs on another connection', description: "A notice's title (HI-2108): an agent started on another connection than its own (its own is off in this workspace, or was removed). {agent} is the agent." }),
  connectionFallback: msg({ id: 'session.connection.fallback', defaultMessage: "{why, select, missing {The connection chosen for it was removed} other {Its connection {wanted} is off in this workspace}}, so it started on {name}, its CLI's first usable one here. Choose another in its Agent Settings.", description: "A notice (HI-2108) when an agent starts on another connection than its own: its own was removed, or is on an account turned off in this workspace ({wanted}: its name). {name} is the account it started on. Agent Settings names a dialog." }),
  noSession: msg({ id: 'session.error.noSession', defaultMessage: 'No session is running for this agent.', description: "An action on an agent's session is refused: the agent isn't running." }),
  moveFailed: msg({ id: 'session.start.moveFailed', defaultMessage: "Combwork couldn't move {project}'s model settings to its agents: {error}. Start it again.", description: "Starting an agent is refused (HI-1770): moving its project's own model, effort and context settings onto the project's agents (connections now hold the defaults) failed. {project} is the project's name, {error} why (often in English). It is tried again at the next start." }),
  independentNoTask: msg({ id: 'session.start.independentTask', defaultMessage: '{agent} is Independent: Combwork gives it no tasks. Start it and work with it in its pane.', description: "Starting an agent on a task is refused (HI-2670): the agent's role is Independent (its own, or its connection launches it without Combwork's tools), so Combwork never types a task into it. {agent} is the agent's name." }),
  plainNoTask: msg({ id: 'session.start.plainTask', defaultMessage: "{agent}'s connection launches it without Combwork typing into it, so it can't be given a task as it starts.", description: "Starting an agent on a task is refused (HI-2670): its connection's launch settings have \"Combwork types into the agent\" off. {agent} is the agent's name." }),
  stoppedBeforeStart: msg({ id: 'session.error.stoppedBeforeStart', defaultMessage: 'The agent was stopped before it had started.', description: "Starting an agent failed: it was stopped (or its workspace closed) while it was starting." }),
  stoppedBeforePrompt: msg({ id: 'session.error.stoppedBeforePrompt', defaultMessage: 'The agent stopped before the prompt was sent.', description: 'Typing a prompt into an agent failed: it stopped or restarted meanwhile.' }),
  typingBusy: msg({ id: 'session.error.typingBusy', defaultMessage: 'Combwork is already typing a prompt into this agent; it is busy.', description: 'An action on an agent is refused: Combwork is typing a prompt into it now.' }),
  inUseElsewhere: msg({ id: 'session.error.inUseElsewhere', defaultMessage: 'Another program has its transcript open. Close it, then try again.', description: "Archiving or deleting a session is refused: another program holds its transcript file open." }),
  stopFirst: msg({ id: 'session.error.stopFirst', defaultMessage: '{action, select, archive {Stop the session before you archive it.} unarchive {Stop the session before you unarchive it.} other {Stop the session before you delete it.}}', description: 'Archiving, unarchiving or deleting a session is refused while it runs. {action} says which.' }),
  sessionRunning: msg({ id: 'session.error.running', defaultMessage: 'The session is running.', description: "Clean Up… is refused for a session: it is running." }),
  handOverNotNow: msg({ id: 'session.handOver.notNow', defaultMessage: "{agent} is working, merging or on a card loop's card, so its conversation isn't ended now. Hand it over to a new conversation when it has finished.", description: 'Handing an agent over to itself (a new conversation) is refused: it is working, holds the merge slot or works on a card of a running card loop. {agent} is its name.' }),
  handOverMomentLost: msg({ id: 'session.handOver.momentLost', defaultMessage: '{agent} took the merge slot, started other work or changed while it wrote its handover, so its conversation wasn\'t ended. The handover "{handover}" is kept.', description: 'Handing an agent over to itself stopped before ending its conversation: while it wrote its handover it began merging (the merge slot), began other work (a task, a card loop\'s card) or restarted. {agent} is its name, {handover} the handover\'s path in the shared notes.' }),
  handOverBusy: msg({ id: 'session.handOver.busy', defaultMessage: '{agent} is busy. Hand over once it has finished.', description: "Hand Over to… is refused: the agent named is working. {agent} is the agent's name." }),
  switchEnded: msg({ id: 'session.mode.ended', defaultMessage: 'The session ended before Combwork could switch it to {mode}.', description: "Switching a running agent's permission mode failed: its session ended. {mode} is the mode's name." }),
  needsInput: msg({ id: 'session.notice.needsInput', defaultMessage: '{agent} needs your input', description: "A notification's title: an agent waits for the user. {agent} is the agent (\"demo · B1\", or the project when it has one agent)." }),
  finished: msg({ id: 'session.notice.finished', defaultMessage: '{agent} finished', description: "A notification's title: an agent's turn has ended. {agent} is the agent (\"demo · B1\", or the project when it has one agent)." }),
  longConversation: msg({ id: 'session.notice.longConversation', defaultMessage: '{agent}: long conversation', description: "A notice's title: an agent's transcript has grown past the size set in Settings → Sessions. {agent} is the agent." })
}

/**
 * Sets an agent's status message (#845): Combwork's own as text (its English in `statusMessage`, which agents read and Combwork
 * compares, and `statusText`, which the window shows in its language), the CLI's words as they came, or null to clear it.
 */
function setStatus(st: LiveSessionState, text: TextPart | null): void {
  // agent-stored: agentField says it for each agent where the status is sent (servers.ts statusMessageOf)
  st.statusMessage = text === null ? undefined : englishText(text)
  st.statusText = text === null || typeof text === 'string' || typeof text === 'number' ? undefined : text
}

/** An agent's place at the merge slot as the window shows it (LiveSessionState.mergeSlotText); `mergeSlot` is its English (shared/mergeSlot.ts). */
function slotNoteText(note: SlotNote, named: (n: number) => string): Text {
  if ('holding' in note) return withValues(msg({ id: 'session.mergeSlot.holding', defaultMessage: 'Merging into {branch} (merge slot)', description: "An agent's status while it holds the project's merge slot. {branch} is the branch it merges into." }), { branch: note.holding })
  const h = note.waitingFor
  if (!h) return msg({ id: 'session.mergeSlot.waiting', defaultMessage: 'Waiting for the merge slot', description: "An agent's status while it waits for the project's merge slot." })
  if (h.kind === 'user') return msg({ id: 'session.mergeSlot.waitingForYou', defaultMessage: 'Waiting for the merge slot (you are merging)', description: "An agent's status while it waits for the merge slot the user holds (merging from Combwork's Merge dialog)." })
  const cards = h.cards.map(named).join(', ')
  if (h.taken)
    return cards
      ? withValues(msg({ id: 'session.mergeSlot.waitingMergingCards', defaultMessage: 'Waiting for the merge slot ({agent} is merging {cards})', description: "An agent's status while it waits for the merge slot another agent holds. {agent} is that agent's name, {cards} the cards it merges (\"#305, #306\")." }), { agent: h.name, cards })
      : withValues(msg({ id: 'session.mergeSlot.waitingMerging', defaultMessage: 'Waiting for the merge slot ({agent} is merging)', description: "An agent's status while it waits for the merge slot another agent holds. {agent} is that agent's name." }), { agent: h.name })
  return cards
    ? withValues(msg({ id: 'session.mergeSlot.waitingNextCards', defaultMessage: 'Waiting for the merge slot ({agent} is next to merge {cards})', description: "An agent's status while it waits for the merge slot, which another agent is next to take. {agent} is that agent's name, {cards} the cards it merges (\"#305, #306\")." }), { agent: h.name, cards })
    : withValues(msg({ id: 'session.mergeSlot.waitingNext', defaultMessage: 'Waiting for the merge slot ({agent} is next to merge)', description: "An agent's status while it waits for the merge slot, which another agent is next to take. {agent} is that agent's name." }), { agent: h.name })
}

/** A handover in the shared notes: its path there, when it changed, and the session that wrote it (from its header). */
export interface HandoverRef {
  relPath: string
  modified: string
  session: string | null
}

export interface CombworkMcpProvider {
  /** The combwork MCP server for a project's sessions; with agentId, that agent's (its tools then say who is calling). */
  (projectPath: string, agentId?: string): McpServerDef | null
}

/** Minimum time between transcript backups while a turn is running. */
const BACKUP_INTERVAL_MS = 60_000
/** Settings → Sessions → Keep transcript backups now (#1110): days, or null when they're kept always. */
const retentionDays = (): number | null => {
  const setting = config.settings.sessions.backupRetention
  return setting === 'off' ? null : Number(setting) || null
}
/** Minimum time between cost estimates while a turn is running (each parses the whole transcript). */
const COST_INTERVAL_MS = 30_000
/** How many of a launch's latest hooks are kept for the log (LiveSession.recentHooks). */
const RECENT_HOOKS = 8

/** A lock block of a launch (HI-982: LiveSession.hookBlock): its tool call, the file (its lock's key) and the holder's launch. */
interface HookBlock {
  runId: string
  toolUseId: string | null
  key: string
  file: string
  holderLiveId: string
  holderRunId: string
  kind: 'blocked' | 'asked'
  at: number
}

/**
 * A hook Combwork is handling (HI-982), as it observes it: made when it arrives (observeHook) for its launch, filled in by
 * its lock decision and the turn ledger, recorded in the launch's history once it is handled (hookHandled).
 */
export interface HookObservation {
  l: LiveSession
  fired: HookFired
  started: number
}
/** How long after an ask its CLI's screen may take to show it is a safeguard prompt (LiveSession.guardAsk, #606). */
const GUARD_ASK_MS = 10_000
/** An agent at its prompt, between turns: where its CLI's question by itself shows (HI-1959). */
const AT_PROMPT: ReadonlySet<SessionStatus> = new Set<SessionStatus>(['ready', 'finished', 'background', 'watching'])
/** What a CLI's hooks say that shows it took input or moved by itself (HI-2191): a blocked input is free again. Not its idle notice. */
const MOVES_INPUT: ReadonlySet<HookEvent['kind']> = new Set<HookEvent['kind']>(['start', 'prompt', 'toolStart', 'toolEnd', 'ask', 'stop', 'interrupt', 'compactStart', 'compactEnd', 'signIn', 'retry'])
/** How many stops seen only on screen a session's record keeps (SessionRecord.screenStops). */
const MAX_SCREEN_STOPS = 200
/**
 * How long a turn may run with nothing heard of it (no hook, no transcript growth, no tool call under way) before Combwork
 * looks for its end on the CLI's screen, and failing that says its state is unknown (#648). Never an end in itself.
 * Unpackaged test builds can shorten it (CW_TEST_SILENT_MS).
 */
const silentMs = (): number => (!app.isPackaged && Number(process.env.CW_TEST_SILENT_MS) > 0 ? Number(process.env.CW_TEST_SILENT_MS) : 5 * 60_000)
/** HI-1972: a running turn with no hook this long has its CLI's records looked at for a retry wait (an adapter may say otherwise)… */
const DEFAULT_RETRY_LOOK_AFTER_MS = 20_000
/** …then again at most this often while it stays quiet. */
const RETRY_LOOK_EVERY_MS = 15_000
/** How many times silentMs a running turn with a tool call open may be silent before its state is unknown (a long test run). */
const OPEN_CALL_SILENCE = 12
/** How many of the CLI's Stop answers (LiveDetails.stopsAnswered) a launch keeps: a turn has few. */
const STOPS_KEPT = 64
/** "40 s", "23 min": a silence, for the log. */
const howLong = (ms: number): string => (ms < 120_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`)
/** How long after a CLI starts or is ready its size refresh comes (refreshSize). */
const SIZE_REFRESH_DELAY_MS = 500
/** How many running agents "Switch Now" switches at once (applyModeSettings): the rest wait for one to end. */
const MODE_SWITCHES_AT_ONCE = 6

/** After a kill, how long a CLI's console takes to be gone (its processes listed and ended, then its exit). */
const KILL_EXIT_MS = 1000

/** The most a start waits for its agent's ended runs' slot writers to be released (HI-1867): a bound for a hung one. */
const WRITER_SETTLE_MS = 15_000

/**
 * How long stopping sessions waits for them to end: its own timeout, or longer where a CLI is given time to exit by
 * itself before it is killed (an adapter's exitKeys graceMs: Copilot's 10 s, #716), so its kill and exit still come
 * within the wait. Sessions that end sooner end the wait sooner.
 */
export function stopWaitMs(timeoutMs: number, graces: (number | undefined)[]): number {
  return Math.max(timeoutMs, ...graces.map((g) => (g === undefined ? 0 : g + KILL_EXIT_MS)))
}

interface LiveSession {
  state: LiveSessionState
  adapter: ProviderAdapter
  /**
   * The conversations this run marked as on a server connection (HI-1772, HI-1829): read without their CLI's cost
   * reports while the run is live (/clear or /new: each one it moved through). Let go with the run.
   */
  serverSids?: Set<string>
  /** Those whose record was saved with `serverRan`: its record decides once the run is over. */
  serverSaved?: Set<string>
  /** Those the CLI started (recordSession wrote, or tried to write, their record): a record to keep once it is over. */
  serverRecorded?: Set<string>
  /** Its conversation ran only on servers on this PC (HI-1772), as its record says: free. */
  costFree?: boolean
  /** The terminal as rendered, for an adapter that reads it (its footer's mode, or a menu to pick from: #396). */
  screen?: TerminalScreen | null
  /** The size refreshes given so far, for a CLI that needs them (capabilities.startupSizeRefresh, #486). */
  sizeRefreshed?: 'started' | 'ready'
  /** The transcript's modified time and size at the last look ("mtime:size"). */
  transcriptMtime: string
  /** Where the provider writes this session's transcript, once known (from a hook, or found by id). */
  transcriptPath?: string
  backupTimer?: NodeJS.Timeout
  /** When the transcript was last copied to .combwork/sessions (see BACKUP_INTERVAL_MS). */
  lastBackupAt?: number
  /** The transcript's modified time and size when it was last backed up. */
  backupMtime?: string
  /** Launched without a model choice, so its transcript shows the CLI's default model. */
  defaultModel: boolean
  /**
   * Launched without an effort choice: the effort it first reports is the CLI's default for its model (the launch's
   * model, else the one it reports), learned for the footer (#125). Cleared once learned.
   */
  defaultEffort?: { model: string | null }
  /** How the CLI compacts by itself for a model it runs as (#242), read again when the session reports another model. */
  autoCompactFor?: (running?: string) => AutoCompactSetting
  /** Set while a compaction Combwork asked for runs. */
  compacting?: Compaction
  /** The user stopped it (e.g. during its worktree setup), so an early exit isn't reported as a failure. */
  stopRequested?: boolean
  /** Who asked it to stop, as its caller knew it (HI-1881: its pane says why); unset when the caller didn't say. */
  stopCause?: StopCause
  /** Its CLI is being ended with its exit keys (endProcess): a second stop kills it at once. */
  ending?: boolean
  /** Terminal output tail, to see the CLI ready or asking something at the start. */
  modeTail: string
  /** What Combwork recognised on its screen this launch, whatever its status (the developer console's contract markers, #638). */
  recognition: ScreenRecognition
  /** The mode it was launched in. */
  launchMode: PermissionMode | null
  /**
   * The mode the settings asked for when it launched, or when the user last applied a settings change to it; undefined
   * until its launch has read the settings (#1234: a refresh meanwhile, as when an agent restarts in a new conversation,
   * has nothing to compare the setting with, so offers no switch).
   */
  configuredMode: PermissionMode | null | undefined
  /** A settings change already offered to it, so the offer isn't repeated on every refresh. */
  offeredMode?: PermissionMode | null
  /** Launch in this mode instead of the configured one (Restart in mode). */
  modeOverride?: PermissionMode
  /** The session's display name, for recording it once the provider reports the session id. */
  name: string
  /** Bytes of the transcript already read for live details (providers with transcriptDetails). */
  detailsOffset?: number
  /** What the adapter keeps between those reads (a refusal whose turn's end comes later). */
  detailsMemo?: Record<string, unknown>
  /** The last interrupt read from the transcript and acted on (LiveDetails.interruptedAt), so each counts once. */
  interruptedAt?: string
  /**
   * A failed turn the transcript recorded (#1632, Codex, whose Stop says nothing of it) and not settled yet: the turn it
   * names (or when, for records that name none) and the CLI's words. It belongs to that turn only (failureTurn): marked
   * once that turn is over, ended failed by that turn's Stop, dropped once a newer turn has begun, kept while its turn
   * is unknown. `failureDone`: the last record settled (applied or dropped), so a record read again isn't a new one.
   */
  failure?: { key: string; turn: string | null; at: number; words: string }
  failureDone?: string
  /** The last compaction end read from the transcript (LiveDetails.compactedAt, #454), so each counts once. */
  compactedAt?: string
  /**
   * The launch's hooks that have arrived, counted as each comes (before its turn in the queue): an interrupt read from
   * the transcript is dropped if one came after the read began, as that hook says something newer (#475).
   */
  hooksSeen?: number
  /** What its status line says that no hook tells (statusLineState.ts, HI-2545): derived in hook order from its valid reports. */
  statusState?: StatusState
  /** What its CLI's adapter keeps for this launch while preparing its hooks (prepareHook's memo, HI-2545): dropped with it. */
  hookMemo?: Record<string, unknown>
  /**
   * A status line said idle while its turn ran (HI-2545: agy sends no hook when its permission prompt is cancelled): the
   * turn is taken as interrupted once idleGraceMs passes with nothing else heard. Bound to the launch's run, session and
   * turn as it began; anything heard of the launch meanwhile cancels it.
   */
  idleGrace?: { timer: ReturnType<typeof setTimeout>; runId: string; sessionId: string; turn: string }
  /** Whether its hooks are reaching Combwork (#1336, hooksHealth.ts): what the check reads of the launch. */
  hooksWatch?: HooksWatch
  /**
   * Reading its transcript's turns (#1371, readTurns): which conversation and file, how far (a line's end), its first
   * bytes as they were (a file replaced under the same name has others), and the adapter's memo.
   */
  turnsRead?: TurnsReading
  /** Its transcript's turns were read for this launch already: a later file or conversation is read from its end. */
  turnsBegun?: boolean
  /** For the check's why: where its CLI's settings turn hooks off now, and whether it is newer than Combwork was tested with. */
  hooksOffIn?: () => string | null
  /** What on the PC would keep its hooks away (HI-2777: the adapter's hookCause, read at launch), once read. */
  hookCause?: HookCause | null
  /** The hook events heard from this launch (HI-2777: SessionStart alone tells a snippet naming another port). */
  heard?: Set<string>
  newerThanTested?: boolean
  /** When the cost estimate was last worked out (providers that don't report cost, or the user's prices: #436). */
  costAt?: number
  /** The cost the CLI last reported for this launch, kept while the user's prices are shown instead (#436). */
  reportedCost?: number
  /** Terminal output while a mode switch waits for the CLI's confirmation. */
  switchTail?: string
  /** The first task, for the launch's command line (cleared once launched). */
  initialPrompt?: string
  /** This launch was given its first task on its command line: until its CLI takes it, it is pending (#712). */
  launchTask?: true
  /** When such a launch first became ready (or watching), in ms: its task is pending at most PENDING_MS from then (#721). */
  launchReadyAt?: number
  /**
   * This launch was given Combwork's tools (the combwork MCP server, #865): `connecting` until its server says the CLI has
   * connected (POST /v1/launch/connected), and no line of Combwork's is typed meanwhile, at most cw.mcp.connectSeconds
   * from when it first became ready (readyAt), for a CLI that never connects it.
   */
  combworkTools?: 'connecting' | 'connected'
  /**
   * What of Combwork's this launch got (HI-2670: its connection's launch policy as it launched), which its hooks and
   * deliveries keep to until it restarts. Missing (before it is prepared): everything.
   */
  policy?: LaunchPolicy
  /** This launch's side of the workflow, as its metrics count it (HI-2049): taken once, as it launched. */
  workflow?: LaunchWorkflow
  /** The side its Combwork tools were offered for (HI-2664, its CW_SIDE): null without Combwork's tools. */
  side?: string | null
  /** A restart for its new side or workflow tools is on its way (restartForTools): asked again, it isn't queued twice. */
  sideRestart?: boolean
  /**
   * What of Combwork's this launch had (HI-2731, launchKeyOf): its launch policy and whether it got the combwork server, so
   * a role change to or from Independent, which changes them and not its side, restarts it too.
   */
  launchKey?: string
  /** The tools its project's workflow left out of its launch (HI-2694, its CW_WORKFLOW_HIDDEN): [] for none. */
  workflowHidden?: string[]
  /** When this launch first became ready (or watching, or finished), in ms (#865). */
  readyAt?: number
  /**
   * The session its next conversation was handed over from (#782): recorded with that conversation once its id is known
   * (Codex's comes with its first prompt, which may be minutes away behind a question at start), then let go.
   */
  handedOverFrom?: string
  /** The slot lease it started under (#1434): its session is bound to it once recorded. */
  lease?: string
  /** Its slot's environment (CW_SLOT, CW_SLOT_PORT_BASE) while it runs in one. */
  slotEnv?: Record<string, string>
  /** The folders its launch was granted outside its own (#1439: its project's review copies). */
  extraDirs?: string[]
  /**
   * The CLI's version as this run was launched (HI-1327): what a version gate goes by while it runs, not the CLI
   * installed now (updated or switched since, it isn't this process). Null: not known.
   */
  cliVersion?: string | null
  /** Throws if whoever asked for this launch may no longer have it (the Assistant's authority), checked just before spawning. */
  startAllowed?: () => void
  /** The CLI asked something before it started (e.g. whether to trust the folder): shown as waiting for the user. */
  askedAtStart?: boolean
  /** That question was answered: its screen no longer says anything about the start (startupScreen). */
  startupDone?: boolean
  /** For a CLI whose terminal title says when a person must act (ProviderAdapter.titleAttention): its test, for this launch. */
  titleAttention?: (title: string) => boolean
  /** The title says a person must act now (as the status has it: applied in order with the hooks). */
  titleAsks?: boolean
  /** What the title said when last read, maybe not applied yet. */
  titleRead?: boolean
  /** The unfinished title sequence the last output ended with. */
  titleCarry?: string
  /** For a CLI that writes its turn's state to the terminal (ProviderAdapter.terminalTurn, HI-2802): its pattern, now. */
  terminalTurnOf?: () => RegExp | null
  /** What it last wrote of its turn, this launch, and the unfinished OSC sequence the last output ended with. */
  terminalSaid?: TerminalTurn
  terminalCarry?: string
  /** Asks its hooks reported that are still open, and the one it waits on (HookStatusInput). */
  open?: Ask[]
  waitingOn?: Ask | null
  /**
   * Background tasks started in this launch that haven't ended: id → when it started, when it expires, what it is and
   * its CLI's description (a subagent's, #1584: user text).
   */
  tasks?: Map<string, { at: number; expiresAt?: number; type?: BackgroundTaskType; description?: string }>
  /** Tasks seen to end, so a start read late doesn't count one again. */
  tasksEnded?: Set<string>
  /** Bytes of the transcript already read for background tasks. */
  tasksOffset?: number
  /** What the adapter keeps between those reads (a call whose output comes later). */
  tasksMemo?: Record<string, unknown>
  /** Bytes of the transcript already read for safeguard stops (#606), and what the adapter keeps between reads (its model, its last tool calls). */
  guardOffset?: number
  guardMemo?: Record<string, unknown>
  /** HI-2754: when its latest prompt came (ms), the user's or one Combwork typed: a stop before it hit an older turn. */
  promptAt?: number
  /** A blocking ask naming no tool, from a CLI that tells a safeguard prompt by its screen, until the screen says whether it is one (#606). `applied`: the status rules took it (else the turn ledger found it stale). */
  guardAsk?: { ask: Ask; at: number; applied: boolean }
  /** When it began waiting on a safeguard prompt (#606): typed into since, or the prompt gone from its screen, it may be answered. */
  guardPromptAt?: number
  /**
   * This launch's safeguard stops per turn (SafeguardEvent.turn) from its prompts on screen and from the CLI's records of
   * stops it asked about (SafeguardEvent.asked): in a turn, one of each is the same stop, whichever comes first, so the
   * agent's note counts it once (Performance matches them the same way from the session's record: withScreenStops).
   */
  guardTurns?: GuardTurns
  /** Looks at its transcript under way (backup), until each ends: what reads it after the session is gone. */
  looks?: Set<Promise<void>>
  /** The safeguard read under way (readSafeguards: one at a time). */
  guardReading?: Promise<void>
  /** A screen check for the safeguard prompt is queued (one at a time, however much the CLI draws meanwhile). */
  guardChecking?: boolean
  /** The conversation already warned about for its transcript's size (once each). */
  sizeWarned?: string
  /** When its latest turns began (as Combwork saw each start), newest last: what a hand-over to itself checks (#1057). */
  turnStarts?: number[]
  /** The ledger's turn last seen, to tell a new one. */
  turnSeen?: object
  /** This launch resumes a conversation (a failed start's Retry resumes it again). */
  resumed?: boolean
  /** A resumed launch's transcript size just before its spawn (HI-2816; -1 none found): only growth past it says the CLI is up. */
  resumedBytes?: number
  /** The Combwork Assistant's mode (its id) its conversation was last given, started in or told: recorded with it. */
  mode?: string
  /** This launch gave its conversation instructions of Combwork's own (SessionRecord.promptAdded): recorded with it. */
  promptAdded?: true
  /** Prompts the CLI has reported submitted in this launch (UserPromptSubmit), for sendPrompt's confirm and a wake's (#376). */
  prompts?: number
  /**
   * Combwork's latest typed prompt (sendPrompt): when (`at`, its Enter; `from`, when its typing reserved the composer), and the
   * prompts taken then. Until the CLI takes it, it is pending (#416).
   */
  typed?: { at: number; prompts: number; from: number }
  /**
   * When Combwork last pressed Enter for a line of its own (HI-2218), at the key press: a prompt its CLI takes after it, the
   * user's Enter before it, is Combwork's, even while sendPrompt still waits for it to be taken (`typed` is recorded after).
   */
  combworkEnterAt?: number
  /**
   * A line of Combwork's the user typed into before its CLI took it (#652 round 1 finding 2): the prompt is their draft now, so
   * nothing more is typed into the agent until a prompt is submitted (the CLI's count passes this).
   */
  draftOver?: { prompts: number }
  /** The start of its latest reply, as its last turn's end reported it (an agent watch's line, #416). */
  lastReply?: string
  /** Its latest hooks (what they were, when, and the status they left), for the log when the CLI turns out idle (#612). */
  recentHooks?: { kind: HookEvent['kind']; at: number; status: SessionStatus }[]
  /** Its hooks for its Hooks dialog (HI-982): what its launch has (adapter.launchHooks), and what Combwork received, newest last. */
  hooks?: LaunchHooks
  hookHistory?: HookFired[]
  /**
   * Its edit Combwork's file lock blocked (or asked the user about) and whose decision stands (HI-982, Activity): the latest
   * one only, by the tool call, the file and the holder's launch; dropped by what ends that decision (hookBlockNow).
   */
  hookBlock?: HookBlock
  /** Its CLI's turns as Combwork knows them (#648): which runs and which are over, by the CLI's ids, and when it was last heard. */
  ledger?: TurnLedger
  /** The CLI's own latest record of a turn's end read from its transcript (LiveDetails.turnEnded). */
  turnRecord?: { turn: string; at: string } | null
  /** When the CLI answered its Stops this launch, as it recorded them (LiveDetails.stopsAnswered, ms; the latest STOPS_KEPT). */
  stopsAnswered?: number[]
  /** Its screen's reading of the CLI's turn (idle, working, not sure), for this launch's CLI version (ProviderAdapter.turnScreen). */
  turnScreen?: (screen: string) => 'idle' | 'working' | null
  /** The environment it was launched with: where its CLI keeps its records (HI-1972, ProviderAdapter.retryWait). */
  launchEnv?: NodeJS.ProcessEnv
  /**
   * The dialect chain it speaks (dialects, HI-2443), pinned at its launch: what agent text says to it (the resolver
   * below), and in cw-mcp.js and cw-progress.js through CW_DIALECT_FILE. `input`: what it was resolved from (its
   * CLI, the real model ID it launched with, its pick), so the refresh can tell when its files would give another
   * (`key`) and show "restart to apply".
   */
  dialect?: PinnedDialect
  /** When its latest hook reached Combwork (ms, as it arrived). */
  lastHookAt?: number
  /** Its CLI's retry wait (HI-1972, checkRetry): a look under way, when it last looked, and the turn the wait shown is of. */
  retryLooking?: boolean
  retryLookedAt?: number
  retryTurn?: object
  /** The turn whose retry wait the Assistant was told of (HI-1973): once a turn. */
  retryTold?: object
  /** Its transcript says its background task ended, which starts a turn of the CLI's own (backgroundWakes), not begun yet in the ledger. */
  woke?: boolean
  /**
   * A typed wake being confirmed (#430: watches' confirmTaken, from its typing until it is taken, marked not taken, or the
   * launch ends): nothing more is typed into it meanwhile, however long that takes. A token, so only its own release
   * clears it.
   */
  confirming?: symbol
  /**
   * The deliveries the line marked not taken (`state.untakenLine`) rang for (#1514 round 1 finding): only one of them read
   * shows that line was taken; another's read (an older line's, taken long ago) leaves the mark. Empty: a line that rang
   * for none Combwork knows.
   */
  untakenFor?: readonly string[]
  /** The line marked not taken, whole (`state.untakenLine` keeps 160 characters): told to the user if it is lost (HI-1959). */
  untakenText?: string
  /** Prompts its CLI had taken when the line was marked not taken: one taken since is a sign it was taken (HI-1959). */
  untakenPrompts?: number
  /** Its CLI's own question while idle, on its screen (HI-1959): the ask the agent waits on while it shows. */
  idleAsk?: Ask
  /** Clears refused in a row because a key wasn't answered while its input box read empty (HI-2191); a clear that empties it resets. */
  unanswered?: number
  /**
   * Its input box taking no keys (HI-2191): INPUT_BLOCKED_AFTER clears in a row refused so, something else on its screen
   * takes them (a dialog Combwork doesn't know). The agent waits for the user with `ask`, and Combwork presses no key there until
   * it is seen to take keys again (inputBlockedDrawn, a hook, Try again), in this run (`runId`). `box`: its box as read
   * then; `since`: when (ms); `retrying` while Try again's clear runs.
   */
  inputBlocked?: { runId: string; ask: Ask; box: string | null; since: number; retrying?: boolean }
  /** A look at its screen for that question and a lost line is queued (one at a time, however much the CLI draws). */
  idleChecking?: boolean
  /** The user was told this launch runs another model than it was given (HI-2609): once a launch. */
  modelSwitchTold?: boolean
  /** The held line first seen lost (HI-1959): a second look after cw.lostLine.steadySeconds decides. */
  lostSeen?: { since: string; timer: ReturnType<typeof setTimeout> }
}

/** Whose sign-in an agent depends on (HI-1755): its provider's, or its provider's and the connection it launched on. */
export const authScope = (s: Pick<LiveSessionState, 'provider' | 'launchedConnection'>): string => (s.launchedConnection ? `${s.provider}:${s.launchedConnection.id}` : s.provider)

export interface EffectiveSettings {
  provider: ProviderId
  skills: LaunchSkill[]
  skillHashes: Record<string, string>
  /** Combwork skills nobody gets because their header can't be read (name → why): in the launch's problems. */
  skillProblems: Record<string, string>
  mcpServers: Record<string, McpServerDef>
  model: string | null
  effort: EffortLevel | null
  permissionMode: PermissionMode | null
  extraArgs: string[]
  use200kContext: boolean
  chime: boolean
  /** The connection it would launch on (HI-1755), `!<why>` when none can be used; null for a provider without connections. */
  connection: string | null
  /** That connection's name, for messages (HI-2140); not part of the signature (a rename asks for no restart). */
  connectionName?: string
  /** The connection itself (HI-2397: `connection` is its account), for what the window names; not part of the signature either. */
  connectionId?: string
  /** What of Combwork's it launches with (HI-2670: its connection's launch policy; the Assistant keeps its own). */
  launch: LaunchPolicy
}

/** Files read once for a whole session list (instead of once per session). */
/** An agent start in progress, before (or while) its process spawns. */
interface PendingStart {
  projectPath: string
  /** The session being resumed, if any. */
  resumeId?: string
  /** Set by a stop, workspace close or quit: the start gives up at its next check. */
  cancelled: boolean
  /** Its launch's run id, from the start (#1434: the slot's writer is reserved for it before its process exists). */
  runId: string
  /** Settles when the start has finished or given up. */
  done: Promise<unknown>
  /** The start itself: its state, or why it failed or gave up (HI-1746: what a start that joins it reports). */
  outcome: Promise<LiveSessionState>
}

export interface ListContext {
  records: SessionRecord[]
  cfg: ProjectConfig
  /** The host's sessions in the usage history (#1106), read once for a list. */
  stored?: Map<string, StoredUsage>
}

/** A claim an agent holds on a file it edited, so another agent in the same folder doesn't edit it at the same time. */
interface FileLock {
  liveId: string
  at: number
  /** When it was claimed, in claim order (lockSeq): a turn's end releases only what was claimed before it. */
  seq: number
  path: string
  /**
   * The claim's id (HI-2386): the same while one holder keeps the file, a new one when another holder claims it. "Ask
   * me" questions and the user's Allows are about one claim, and end with it (claimsEnded).
   */
  claim: number
}

/**
 * A file's identity for locks: its real path where it exists (a junction or link to it is the same file),
 * else its folder's real path and its name; lower case, as Windows paths are.
 */
function lockKey(abs: string): string {
  try {
    return realpathSync.native(abs).toLowerCase()
  } catch {
    try {
      return join(realpathSync.native(dirname(abs)), basename(abs)).toLowerCase()
    } catch {
      return abs.toLowerCase()
    }
  }
}

/** What Combwork types to tell an agent it may make the locked edits the user allowed. */
/** A go-ahead waiting for an agent's turn to end: the user's Allow, or the claim it waited on having ended (HI-2386). */
interface GoAhead {
  path: string
  /** The user's Allow, for this claim (FileLock.claim); without it, the claim ended and the agent may try again. */
  allowed?: number
}

function goAheadPrompt(cwd: string, goAheads: GoAhead[]): string {
  const said: string[] = []
  for (const allowed of [true, false]) {
    const paths = goAheads.filter((g) => (g.allowed !== undefined) === allowed).map((g) => g.path)
    if (!paths.length) continue
    const files = paths.map((p) => placeRelative(cwd, p) || basename(p)).join(', ')
    said.push(say(allowed ? SESSION.lock.goAhead : SESSION.lock.claimEnded, { files, count: paths.length }))
  }
  return said.join(' ')
}

/** A lock is released when its agent's turn ends; this covers an agent that stalls without ending it. */
const LOCK_TTL_MS = 15 * 60_000

/**
 * The latest usage main had from the usage worker for each transcript (#1147: the worker reads them, never main), by
 * path, with the size and modified time it was read at: asked for again while the file is unchanged, it is answered
 * here, priced once, without asking the worker.
 */
interface UsageSeen {
  sessionId: string
  provider: ProviderId
  size: number
  mtime: number
  /** The worker's result, before costs, which follow the prices in the settings. */
  raw: SessionUsage
  /** A session on more than one model (HI-2675): its rows by day and model, priced a model at a time. */
  rows?: LedgerRow[]
  /** Read without its CLI's cost reports, priced as free (HI-1772): a read asking otherwise isn't this one. */
  reportsIgnored: boolean
  costFree: boolean
  /** Worked out from raw (with costs); null until asked for again after a price change. */
  usage: SessionUsage | null
}
const usageSeen = new Map<string, UsageSeen>()
/**
 * Sessions on a server connection (HI-1772) are read without their CLI's cost reports: while a live run marked them
 * (its `serverSids`), then by their record (`serverRan`). One whose record couldn't be saved is kept here, bounded and
 * failing closed past its bound (HI-1829, serverMarks.ts).
 */
const serverMarks = new ServerMarks((line, host) => log.warn(host ? `${line}: ${userText(host)}` : line))
/** For tests (HI-1829): the unsaved markers' state. */
export const serverMarksForTests = (): ServerMarks => serverMarks
/** Transcripts main keeps the latest usage of (the worker keeps more: Settings → Sessions → Usage cache size). */
const MAX_USAGE_SEEN = 200
/** A session listing this slow is logged with where its time went (#1646). */
const SLOW_LIST_MS = 1000
/** How many of Combwork's sessions a listing looks at at once (#1649): enough to overlap their file checks, not to flood the disk's threads. */
const LIST_AT_ONCE = 8
/** Folders (each CLI's) whose other sessions a listing reads at once (HI-1681). */
const OTHER_FOLDERS_AT_ONCE = 4

/** One session of a bulk action: no reason when it was done, else why it was left alone. */
type BulkOutcome = { id: string; reason?: SessionSkipReason; message?: string }
/** How many sessions a bulk action works on at once (#1659). */
const BULK_AT_ONCE = 4
/** A bulk action's progress is sent to the windows at most this often, and when it ends (#1659). */
const BULK_PROGRESS_MS = 250

/** The bulk actions running on each host's sessions, by host path lower-cased, each by its id (#1659). Removed as they end. */
const bulkRuns = new Map<string, Map<number, SessionBulkProgress>>()
let bulkRunIds = 0

/**
 * Tells the windows how far a bulk action on a host's sessions has got (#1659): at the start, as it goes, and once it
 * ends. Each event lists every run on the host, so one that ends leaves the others shown.
 */
function bulkProgress(projectPath: string, action: SessionBulkAction, total: number): { step: () => void; end: () => void } {
  const key = projectPath.toLowerCase()
  const runs = bulkRuns.get(key) ?? new Map<number, SessionBulkProgress>()
  bulkRuns.set(key, runs)
  const run: SessionBulkProgress = { id: ++bulkRunIds, action, done: 0, total }
  runs.set(run.id, run)
  let sent = Date.now()
  const send = (): void => emit({ type: 'session-bulk', projectPath, runs: [...runs.values()].map((r) => ({ ...r })) })
  send()
  return {
    step() {
      run.done++
      if (Date.now() - sent < BULK_PROGRESS_MS && run.done < total) return
      sent = Date.now()
      send()
    },
    end() {
      runs.delete(run.id)
      if (!runs.size) bulkRuns.delete(key)
      send()
    }
  }
}

/**
 * A live transcript's bytes from start up to size (its size at a stat just before), as text; null when it went since
 * that stat (removed or moved: nothing to read, as when the stat finds none, #1034). A file removed while the CLI
 * still holds it open is pending deletion on Windows, and its open is refused (EPERM) rather than not found: gone
 * too, once nothing is at the path (#1064). Other errors are the caller's.
 */
async function readSpan(path: string, start: number, size: number): Promise<string | null> {
  const gone = (e: NodeJS.ErrnoException): boolean => e.code === 'ENOENT' || ((e.code === 'EPERM' || e.code === 'EACCES') && !existsSync(path))
  const fh = await open(path, 'r').catch((e: NodeJS.ErrnoException) => (gone(e) ? null : Promise.reject(e)))
  if (!fh) return null
  try {
    const buf = Buffer.alloc(size - start)
    const { bytesRead } = await fh.read(buf, 0, buf.length, start)
    return buf.toString('utf8', 0, bytesRead)
  } finally {
    await fh.close()
  }
}

/**
 * usage-cache.json in the profile, which kept each transcript's result between runs until the usage history replaced
 * it (#1106): no longer read or written, and removed once a workspace's history has its sessions (retireUsageCacheFile).
 */
const usageCacheFile = (): string => join(app.getPath('userData'), 'usage-cache.json')


/** Writes text to a session in small pieces, the way keystrokes arrive, rather than as one burst. */
async function typeInto(key: string, text: string, still: () => boolean = () => true): Promise<void> {
  const CHUNK = 8
  for (let i = 0; i < text.length; i += CHUNK) {
    // The agent stopped or restarted meanwhile: the rest mustn't reach the new process.
    if (!still()) throw combworkError(M.stoppedBeforePrompt)
    writePty(key, text.slice(i, i + CHUNK))
    if (i + CHUNK < text.length) await new Promise((r) => setTimeout(r, 10))
  }
}

/** A typed prompt's pieces (HI-1327): its text, and the keys Combwork presses for its line breaks. */
export type TypedSegment = { text: string } | { key: string }

/**
 * A prompt typed as written into a CLI whose input box takes a key as a new line (HI-1327): its line breaks (CRLF, CR
 * or LF) as that key, `newline` (a fixed sequence of Combwork's, TYPED_NEWLINE_KEYS), and each line as promptInput types it
 * (a tab a space, the other control characters, escapes included, left out). The key is its own piece, written whole,
 * so nothing in the text can be taken for one, and no chunk can split it.
 */
export function typedPrompt(line: string, newline: string): TypedSegment[] {
  const out: TypedSegment[] = []
  line.split(/\r\n?|\n/).forEach((part, i) => {
    if (i > 0) out.push({ key: newline })
    const text = promptInput(part, false, true)
    if (text) out.push({ text })
  })
  return out
}

/**
 * Types a prompt's pieces (typedPrompt): its text in chunks, each key in one write; `still` checked before each write.
 * `typed` says what reached the CLI as it goes, the characters written on each line (a key starts the next), so a stop
 * part-way can take back exactly that (rollbackKeys).
 */
async function typeSegments(key: string, segments: readonly TypedSegment[], still: () => boolean, typed: number[]): Promise<void> {
  for (const s of segments) {
    if ('text' in s) {
      const CHUNK = 8
      for (let i = 0; i < s.text.length; i += CHUNK) {
        if (!still()) throw combworkError(M.stoppedBeforePrompt)
        const part = s.text.slice(i, i + CHUNK)
        writePty(key, part)
        typed[typed.length - 1] += part.length
        if (i + CHUNK < s.text.length) await new Promise((r) => setTimeout(r, 10))
      }
    } else {
      if (!still()) throw combworkError(M.stoppedBeforePrompt)
      writePty(key, s.key)
      typed.push(0)
      await new Promise((r) => setTimeout(r, 10))
    }
  }
}

/**
 * How many Ctrl+U take back what typeSegments typed (`typed`: the characters on each of its lines, the cursor after
 * the last), in an input box where Ctrl+U deletes to the line's start, or the line break before it at a line's start
 * (Codex 0.164's kill_line_start: HR6's round 1 of HI-1327): one for each line with text, and one for each line break.
 * Never more, so nothing before Combwork's own text is touched.
 */
export function rollbackKeys(typed: readonly number[]): number {
  return typed.reduce((n, chars, i) => n + (chars > 0 ? 1 : 0) + (i > 0 ? 1 : 0), 0)
}

/**
 * How many Backspaces take back a prompt Combwork stopped part-way in an input box whose Ctrl+U deletes only the row the
 * cursor is on (capabilities.ctrlUClearsRow, HI-1974: Claude Code 2.1.312 kept a stopped wake's first rows, and the
 * next wake was sent after them): one for each code point Combwork wrote (`written`: the one-line prompt, or what
 * typeSegments recorded, each line's UTF-16 units and a key between lines). A Backspace deletes characters, however
 * wide they are drawn or wherever its rows wrapped (tried on 2.1.312 with CJK text, an emoji sequence and long words).
 * It never stops short; a character made of several code points can make it press a few more, which delete only a
 * draft clearing the input was to remove (Settings → Advanced), and nothing in an empty input.
 */
export function backspaceKeys(written: string | readonly number[]): number {
  return typeof written === 'string' ? [...written].length : written.reduce((n, chars, i) => n + chars + (i > 0 ? 1 : 0), 0)
}

/**
 * For the wakeputoff suite (unpackaged builds only, HI-1974): a line Combwork has typed waits before its Enter while
 * CW_TEST_HOLD_TYPED's file exists, checked as it waits, so what stops a line part-way can stop it there.
 */
async function heldTyped(label: string, check: () => void): Promise<void> {
  const file = app.isPackaged ? undefined : process.env.CW_TEST_HOLD_TYPED
  if (!file || !existsSync(file)) return
  log.info(`${userText(label)}: the line Combwork typed is held before its Enter (a test's)`)
  while (existsSync(file)) {
    await new Promise((r) => setTimeout(r, 50))
    check()
  }
}

/**
 * What Combwork writes for a prompt's line (sendPrompt), without control characters, pasted (bracketed) or typed, so
 * nothing in it can end the paste or press a key (HI-1920: typed, a Ctrl+C in it reached Codex as Ctrl+C). Kept as
 * written (`asTyped`, #1286), its line breaks go into a paste as the Enter a terminal pastes them with, and typed, each
 * line break or tab becomes a space (typed, a line break would send the prompt early and a tab complete a word); its
 * other control characters are left out either way.
 */
export function promptInput(line: string, paste: boolean, asTyped: boolean): string {
  line = withoutInvisible(line)
  if (!asTyped) return line.replace(/[\x00-\x1f\x7f-\x9f]/g, '')
  const kept = paste ? line.replace(/\r\n?|\n/g, '\r') : line.replace(/\r\n?|[\n\t]/g, ' ')
  return kept.replace(paste ? /[\x00-\x08\x0a-\x0c\x0e-\x1f\x7f-\x9f]/g : /[\x00-\x1f\x7f-\x9f]/g, '')
}

const INVISIBLE = /[\p{Cf}\u{fe00}-\u{fe0f}\u{e0100}-\u{e01ef}]/u
const PICTOGRAPH = /\p{Extended_Pictographic}/u
const MODIFIER = /\p{Emoji_Modifier}/u
const SELECTOR = /[\u{fe0e}\u{fe0f}]/u
const TAG = /[\u{e0020}-\u{e007f}]/u

/**
 * A line without its invisible characters (#1547): Unicode's format characters (zero-width spaces and joiners, soft
 * hyphens, direction marks, a byte order mark) and variation selectors, but for those an emoji is made of (a joiner
 * between two pictographs, a selector after one or in a keycap, a flag's tags). Claude Code 2.1.309 takes such a
 * character out of a prompt and leaves the prompt unsent ("Removed 1 invisible character · review and press Enter to
 * send"), the same characters inside an emoji sent as they are (tried with each: #1547's comment).
 */
export function withoutInvisible(line: string): string {
  if (!INVISIBLE.test(line)) return line
  const cs = [...line]
  let out = ''
  // The last character kept: what an emoji's joiner, selector or tag follows.
  let prev = ''
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i]
    const next = cs[i + 1] ?? ''
    const keep =
      !INVISIBLE.test(c) ||
      (c === '‍' && (PICTOGRAPH.test(prev) || MODIFIER.test(prev) || SELECTOR.test(prev)) && PICTOGRAPH.test(next)) ||
      (SELECTOR.test(c) && (PICTOGRAPH.test(prev) || (/^[0-9#*]$/.test(prev) && next === '⃣'))) ||
      (TAG.test(c) && (prev === '\u{1f3f4}' || TAG.test(prev)))
    if (!keep) continue
    out += c
    prev = c
  }
  return out
}

/**
 * Whether a line Combwork is typing has been drawn on an agent's screen (#600): its end (spaces left out, as a CLI wraps
 * it) shows more often than when this was called, before it was typed (a doorbell's end is in its earlier ones too).
 */
export function drawnLine(screen: Pick<TerminalScreen, 'text'>, line: string): () => boolean {
  const end = line.replace(/\s+/g, '').slice(-40)
  const count = (): number => (end ? screen.text().replace(/\s+/g, '').split(end).length - 1 : 0)
  const before = count()
  return () => count() > before
}

/**
 * Runs a worktree's setup command in the agent's terminal (Windows: cmd.exe, elsewhere: sh). On Windows as one command
 * line, `/d /s /c "<command>"`, passed as written (#1454): as arguments, node-pty would quote the command and turn each
 * `"` in it into `\"`, which cmd doesn't read, so a quoted path reached the program with its quotes in it. With /s, cmd
 * takes off the outer quotes and runs the command as typed.
 */
export function shellCommand(command: string, platform: NodeJS.Platform = process.platform): { file: string; args: string[] | string } {
  return platform === 'win32' ? { file: process.env.ComSpec || 'cmd.exe', args: `/d /s /c "${command}"` } : { file: '/bin/sh', args: ['-c', command] }
}

/** A notice's link to an agent's pane (HI-2320: every entry links to what it is about); the Assistant's opens its panel. */
function agentTarget(projectPath: string, agentId: string, name: string): ToastTarget {
  const assistant = workspace.isAssistantHome(projectPath)
  return { kind: 'agent', projectPath, agentId, name: assistant ? ASSISTANT_NAME : name, project: assistant ? ASSISTANT_NAME : basename(projectPath) }
}

/** A session's notice kinds as the one notification system's (HI-2320). */
const NOTIFY_KIND = { finished: 'finished', waiting: 'needsYou', notice: 'work' } as const

/** A new session's automatic name: "<project> · <date>", with the agent's name when the project has several. */
function autoName(projectPath: string, agent: Pick<AgentDef, 'name'>, count: number): string {
  return `${basename(projectPath)}${count > 1 ? ` · ${agent.name}` : ''} · ${formatDateTime(new Date())}`
}

/** How long a background task counts as running at most (Settings → Agents), in minutes. */
const taskMinutes = (): number => backgroundTaskMinutes(config.settings.agents.backgroundTaskMinutes)

const liveId = (projectPath: string, agentId: string): string => `${projectPath.toLowerCase()}#${agentId}`

/** Its retry wait over (HI-1972), kept in the launch's tally of them (HI-1996: retryWaited) before it is cleared. */
function endRetryWait(st: LiveSessionState, now = Date.now()): void {
  if (!st.retryWait) return
  st.retryWaited = addRetryWaited(st.retryWaited, st.retryWait, now)
  st.retryWait = undefined
}

/** What a start asks for. */
export interface StartOptions {
  resumeId?: string
  name?: string
  agentId?: string
  skipSetup?: boolean
  permissionMode?: PermissionMode
  prompt?: string
  allowed?: () => void
  handedOverFrom?: string
  /**
   * HI-2197: a new conversation that carries on the agent's own work (its handover to itself) keeps the watch it had. Any
   * other start that resumes nothing ends that watch first: it was the old conversation's.
   */
  keepWatch?: boolean
  /** A new conversation's purpose (#1434): where the agent works for it (agentFolders.ts); its role's own when absent. */
  purpose?: FolderPurpose
  /** Resume All and startup's resume (#1434): a conversation resumes only where it may now, never taking a free slot. */
  auto?: boolean
  /**
   * HI-2540: the user was asked before this resume whether to start a new conversation instead of one that can't
   * continue (SessionListItem.fresh), and said yes: no notice afterwards. Starts no one asked about (a restart's) get it.
   */
  freshAsked?: boolean
}

/** Where a start runs: its folder, the slot lease it runs under, and whether it is another agent's 0.9 worktree. */
interface Place {
  cwd: string
  lease: string | null
  slot: FolderSlot | null
  foreign: boolean
}

/** A session's dialect chain as pinned at its launch (HI-2443): the chain, what it was resolved from, and its key (chainKey). */
interface PinnedDialect {
  chain: ResolvedChain & { slot: ModelSlot }
  input: SessionDialect
  key: string
}

/** A pinned chain as its launch record shows it (LiveSessionState.launched.dialect). */
/**
 * What of Combwork's a launch has, in short (HI-2731): its launch policy (its connection's switches, or the terminal preset
 * of an Independent agent's) and whether it gets the combwork server. Two launches with the same key differ in nothing a
 * role change to or from Independent changes.
 */
export const launchKeyOf = (eff: Pick<EffectiveSettings, 'launch' | 'mcpServers'>): string => JSON.stringify({ launch: eff.launch, tools: !!eff.mcpServers[TOOLS_SERVER] })

function launchDialectOf(d: PinnedDialect, guidance: string): LaunchDialect {
  const { chain, input } = d
  return {
    layers: chain.layers.map((x) => ({ layer: x.layer === 'model' || x.layer === 'cli' ? x.layer : 'workspace', file: x.file })),
    hash: chain.hash,
    guidance,
    ...(input.modelId ? { model: input.modelId } : {}),
    ...(chain.modelUnknown ? { modelUnknown: true as const } : {}),
    ...(input.pick && input.pick !== 'auto' ? { pick: input.pick.file } : {}),
    ...(chain.slot.pickMissing ? { pickMissing: true as const } : {})
  }
}

/**
 * The workspace's skills (their list and each one's revision), MCP servers and dialect files (HI-2443), read once for
 * the agents whose launch settings are worked out together (#1002): a refresh worked out every running agent's, reading
 * them all again for each one. The first read is made in the caller's workspace; one set of reads is never used for another workspace.
 */
export class LaunchReads {
  private skillList: Promise<SkillInfo[]> | null = null
  private serverList: Promise<McpServerInfo[]> | null = null
  private revisions = new Map<string, Promise<string>>()
  private dialectSets = new Map<string, Promise<DialectSet | null>>()

  /** A workspace's dialect files, checked against the schema (dialects, HI-2443); null when they can't be read. */
  dialects(combworkDir: string): Promise<DialectSet | null> {
    const key = combworkDir.toLowerCase()
    let d = this.dialectSets.get(key)
    if (!d) this.dialectSets.set(key, (d = loadDialects(dialectsDir(combworkDir), agentTextSchema()).catch(() => null)))
    return d
  }

  skills(): Promise<SkillInfo[]> {
    return (this.skillList ??= combworkSkills())
  }

  servers(): Promise<McpServerInfo[]> {
    return (this.serverList ??= listMcp())
  }

  revision(path: string): Promise<string> {
    let r = this.revisions.get(path)
    if (!r) this.revisions.set(path, (r = revisionOf(path).catch(() => '')))
    return r
  }
}

/** Each refresh's reads, by the scope it passes (#1002): gone with the refresh. */
const refreshReads = new WeakMap<object, LaunchReads>()

function launchReadsOf(scope: object): LaunchReads {
  let r = refreshReads.get(scope)
  if (!r) refreshReads.set(scope, (r = new LaunchReads()))
  return r
}

/** The provider a session record belongs to (records from before providers are Claude Code's). */
/** A CLI transcript changed this recently is still being written (a Codex guardian review, say): not archived or deleted yet. */
const SESSION_WRITING_MS = 5000

/** A session left alone by archive or delete, and why (SessionBulkResult's reasons). */
export class SessionInUse extends CombworkError {
  constructor(
    readonly reason: SessionSkipReason,
    text: Text,
    kind?: CombworkErrorKind
  ) {
    super(text, kind ? { kind } : undefined)
  }
}


/** Runs a move of Combwork's copies; a copy another program holds fails it as SessionInUse. */
async function inUseOnFail(fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (e) {
    if (isInUse(e)) throw new SessionInUse('in-use', M.inUseElsewhere)
    throw e
  }
}


/**
 * Renames done in order, undone in reverse when a later step fails (`undo`); `discardAside`, once all is done, removes
 * what was only set aside (names ending .previous or .archived: copies the new ones supersede).
 */
class Moves {
  private done: [string, string][] = []

  async move(from: string, to: string): Promise<void> {
    await rm(to, { force: true }).catch(() => undefined)
    await inUseOnFail(() => rename(from, to))
    this.done.push([from, to])
  }

  async undo(): Promise<void> {
    for (const [from, to] of this.done.reverse()) await rename(to, from).catch((e) => log.warn(`Couldn't move ${userText(to)} back`, e))
    this.done = []
  }

  async discardAside(): Promise<void> {
    for (const [, to] of this.done) if (/\.(previous|archived)$/.test(to)) await rm(to, { force: true }).catch(() => undefined)
    this.done = []
  }
}

export const recordProvider = (rec: Pick<SessionRecord, 'agent'> | undefined): ProviderId => rec?.agent || 'claude-code'

/** A usage with the safeguard stops seen only on screen added (#606: kept on its record; the transcript's count doesn't have them). */
function withScreenStopsIn(usage: SessionUsage, screen: SessionRecord['screenStops']): SessionUsage {
  const safeguards = withScreenStops(usage.safeguards, screen, usage.safeguardsAsked)
  return safeguards === usage.safeguards ? usage : { ...usage, safeguards }
}
/**
 * The agent as its running or resumed conversation sees it (#506): a conversation runs the provider that recorded it,
 * whatever the agent's provider is now (a default resolving otherwise, or the agent switched since). The agent's own
 * model, effort, mode and context are its current provider's, so a conversation of another provider takes the
 * project's settings for its own instead.
 */
const pinProvider = (agent: AgentDef, provider: ProviderId | '' | undefined): AgentDef => {
  if (!provider || agent.provider === provider) return agent
  if (!agent.provider) return { ...agent, provider }
  return { ...agent, provider, model: undefined, effort: undefined, permissionMode: undefined, use200kContext: undefined }
}

/**
 * The delivered skills' sizes, for metrics, measured on each copy its CLI reads: its catalog entry (its SKILL.md's name
 * and description, from the header Combwork reads anyway) and its bytes on disk (the bounded stat walk, no file read). A
 * copy that can't be measured (gone, unreadable, no header) is counted as unmeasured and left out of both sums, never
 * guessed as zero. Measuring never fails a launch.
 */
export async function deliveredSkillSizes(adapter: ProviderAdapter, ctx: LaunchContext, delivered: Record<string, SkillDelivery>): Promise<{ catalog: number; bytes: number; unmeasured: number }> {
  let catalog = 0
  let bytes = 0
  let unmeasured = 0
  for (const [name, d] of Object.entries(delivered)) {
    if (!d.revision) continue
    try {
      const copy = adapter.skillCopyPath(ctx, name)
      const head = await headerOf(join(copy, 'SKILL.md'), parseSkillFrontmatter)
      const size = await treeSignature(copy)
      // No header, or one that couldn't be read as a skill's (invalid YAML, a key twice, an unknown audience): unknown.
      if (!head || head.problem) throw new Error('no readable SKILL.md header') // i18n-ignore: caught just below (counted as unmeasured), never shown
      catalog += utf8Bytes(head.name ?? name) + utf8Bytes(head.description ?? '')
      bytes += size.bytes
    } catch {
      unmeasured++
    }
  }
  return { catalog, bytes, unmeasured }
}

/** How soon after the user's Enter in an agent's pane its CLI must take a prompt for it to count as theirs (#418). */
const USER_REPLY_MS = 15_000

/** How long a prompt Combwork typed counts as pending (the agent just given a task) while its CLI hasn't taken it (#416). */
const PENDING_MS = 30_000

/** Settings → Advanced: how long a Ctrl+U clearing Claude Code's input has to be answered on its screen (HI-1979). */
const CLEAR_KEY_WAIT = 'claude-code.prompt.clearKeySeconds'
/**
 * The most Ctrl+U clearing an input may press (HI-1979): one deletes a row of a draft, so this is a draft of as many
 * rows; more ends the try, unseen empty.
 */
const CLEAR_KEYS_MOST = 200
/**
 * The letter Combwork types into an input it reads as empty, and takes back (HI-1979, HR6's round 1): shown alone, the input
 * was empty when it came. A plain letter: in an empty Claude Code input `/`, `?`, `!`, `#` and `@` each open something.
 */
const CLEAR_PROBE = 'x'
/**
 * Clears refused in a row, each because a key wasn't answered while its input box read empty, after which the input
 * counts as blocked (HI-2191): one delivery's tries. A clear answered late but answered resets the count.
 */
const INPUT_BLOCKED_AFTER = 3

/**
 * A launch's task on its CLI's command line not taken yet (#712): the CLI is ready at its SessionStart and takes the task
 * only after, so it is pending until its first prompt, at most PENDING_MS after it became ready. Ready shows as watching
 * when a watch of the agent's outlived its last launch (#721 round 1 finding 1), and as finished once that watch ends:
 * pending too, timed from when it first became ready (launchReadyAt), which a watch's coming or going doesn't move.
 */
function launchPending(l: LiveSession): boolean {
  const st = l.state
  if (!l.launchTask || (l.prompts ?? 0) > 0) return false
  if (st.status === 'starting') return true
  if (st.status !== 'ready' && st.status !== 'watching' && st.status !== 'finished') return false
  return Date.now() - (l.launchReadyAt ?? Date.parse(st.statusSince ?? '')) < PENDING_MS
}

/** Agents whose sign-in is refused at about the same time are told in one notice, this long after the first. */
const SIGNED_OUT_GATHER_MS = 3000
/** How often a CLI's sign-in is checked again while its agents wait for it (its own check, e.g. claude auth status). */
const SIGN_IN_RECHECK_MS = 60_000
/** The status message of an agent stopped by a refused sign-in once its CLI is signed in again (#309). */
const SIGNED_IN_AGAIN = msg({ id: 'session.status.signedInAgain', defaultMessage: 'Stopped while signed out', description: "An agent's status once its CLI is signed in again: its turn stopped while the CLI's sign-in had expired, and Resume carries it on." })
/** What Resume (n) types into such an agent. */
/** Combwork's own deliveries come from it (#649). */
// agent-protocol: the app's name, as a delivery's sender
const CW_SENDER = { kind: 'combwork', name: 'Combwork' } as const // i18n-ignore: the sender's name in deliveries, which agents read
const CARRY_ON_PROMPT = SESSION.carryOn

/** A notice drafted for a hook's reply (inboxNotices.ts): `commit` counts what it tells as told, once a reply carries it. */
export type NoticeDraft = { text: string; commit: () => void }

class SessionManager {
  private live = new Map<string, LiveSession>()
  /** Server markers of runs that have ended, held until their record says so or they are kept (HI-1829: serverRunEnding). */
  private readonly serverEnding = new Map<string, number>()
  /**
   * CLIs whose sign-in was refused, until signed in again (#309): the user is told once per CLI and expiry (agents
   * stopping later only show it), and the CLI's own check runs again meanwhile, to notice the sign-in.
   */
  /**
   * Sign-ins refused, by auth scope (authScope: the provider, or the provider and the connection its agents launched on,
   * HI-1755): one connection signed out never stops, relabels or clears another's agents.
   */
  private signedOut = new Map<string, { gather?: ReturnType<typeof setTimeout>; recheck?: ReturnType<typeof setInterval> }>()
  /** runId → liveId: hooks name their launch, so they reach the right agent even before the session id is known. */
  private runs = new Map<string, string>()
  /** The status each state was last sent with, so statusSince moves only when the status changes. */
  private statusSent = new WeakMap<LiveSessionState, SessionStatus>()
  private locks = new Map<string, FileLock>()
  /** "Ask me" locks for CLIs without an approval reply: `<liveId>|<path>` the user allowed, or was asked about. */
  /** Counts lock claims, approvals and questions, so they can be told apart from a turn's end in order. */
  private lockSeq = 0
  /** "Allow" given for an agent and file (`<liveId>|<lock key>`), and questions already asked, with their lockSeq. */
  private lockAllowed = new Map<string, number>()
  private lockAsked = new Map<string, number>()
  /**
   * The claim (FileLock.claim) each open question asked about, and each Allow was given against (HI-2386): neither
   * applies to any other claim of the file.
   */
  private lockAskClaim = new Map<string, number>()
  private lockAllowedClaim = new Map<string, number>()
  /** Gives each claim its id (FileLock.claim). */
  private claimSeq = 0
  /**
   * The go-ahead an agent gets when its turn has ended (`<liveId>|<lock key>`): the file's path, and the claim the user
   * allowed it against (`allowed`), or none when the claim it waited on ended unanswered and it may try again (HI-2386).
   */
  private lockGoAhead = new Map<string, GoAhead>()
  /**
   * The delivery service (#649, deliveries.ts sets it as it loads): the lines sessions give agents of their own (a lock's
   * go-ahead, the carry-on after a sign-in, a handover's steps) are deliveries it offers, as every way into an agent is.
   */
  deliveries: {
    give: (host: string, nd: NewDelivery, hooks?: DeliveryHooks) => Promise<unknown>
    now: (host: string, nd: NewDelivery, holds?: () => boolean) => Promise<unknown>
    /** A delivery its agent's launch carries, as the launch's task (launchWith): `start` launches it with the line. */
    launch: (host: string, nd: NewDelivery, start: (line: string) => Promise<{ runId: string }>) => Promise<unknown>
    cancel: (host: string, source: string, ref: string | null, why: string) => Promise<number>
    /** HI-2463: what waits for a conversation, for the agent's next one instead (carryConversation). */
    carry: (host: string, agentId: string, from: string) => Promise<number>
  } | null = null
  private delivery(): NonNullable<SessionManager['deliveries']> {
    if (!this.deliveries) throw combworkError(msg({ id: 'session.error.noDeliveries', defaultMessage: "Combwork's delivery service isn't running.", description: "Giving an agent a message failed: the part of Combwork that delivers them hasn't started (or has stopped)." }), undefined, { kind: 'conflict' })
    return this.deliveries
  }
  hookUrl = ''
  /** The fixed hook URL on the Agent API's port while it listens (HI-2777: Claude Code's hooks and the admin snippet's), else null. */
  fixedHookUrl: () => string | null = () => null
  apiEnv: (projectPath: string, agentId: string) => Record<string, string> = () => ({})
  /** Combwork's bin folder (cw-progress), first on each session's PATH; null until written, or when it couldn't be. */
  binDir: string | null = null
  /** Agents' signer (HI-2867, index.ts): cw-sign.exe and what it runs; null without a built launcher. */
  signer: Omit<SessionSigner, 'timeoutMs'> | null = null
  combworkMcp: CombworkMcpProvider = () => null
  /** Combwork's guidance for agents (the combwork MCP server's instructions), for providers that need it at launch. */
  combworkGuidance: (projectPath: string) => Promise<string> = async () => ''
  /** Before each Combwork Assistant launch (its workspace gets a new Agent API token). */
  onAssistantLaunch: (projectPath: string) => Promise<void> = async () => undefined
  /** The user sent the Combwork Assistant a message (a new turn). */
  onAssistantPrompt: (projectPath: string) => void = () => undefined
  /** The Combwork Assistant's process ended (its token is revoked, its questions withdrawn). */
  onAssistantExit: (projectPath: string) => void = () => undefined
  /** When the user last typed in each terminal (by pty key), so nothing else types over them. */
  private userInput = new Map<string, { at: number; enter: boolean }>()
  /** The Combwork Assistant's instructions for a launch (who it is, and its mode's), and the mode's name and id. */
  assistantInstructions: (projectPath: string, agent: AgentDef) => Promise<{ text: string; mode: string; modeId: string; modeText: string }> = async () => ({ text: '', mode: '', modeId: '', modeText: '' })
  /**
   * A Combwork Assistant conversation was resumed in the mode `modeId`: main/assistantMode.ts tells it that mode
   * once it is idle, if the conversation was last given another (#334).
   */
  onAssistantResumed: (projectPath: string, runId: string, sessionId: string, modeId: string) => void = () => undefined
  /** An agent's wake-on-change watch, if it has one (main/watches.ts sets this). */
  watchFor: (projectPath: string, agentId: string) => TaskWatchInfo | null = () => null
  /** HI-2197: an agent's watch from before ended, as it starts a new conversation (main/watches.ts sets this). */
  conversationEnds: (projectPath: string, agentId: string) => Promise<void> = async () => undefined

  /** The prompts an agent's CLI has taken in this launch, and the launch (#376: was a typed line taken?). Null when not running. */
  promptsTaken(projectPath: string, agentId: string): { runId: string; count: number } | null {
    const l = this.live.get(liveId(projectPath, agentId))
    return l?.state.runId ? { runId: l.state.runId, count: l.prompts ?? 0 } : null
  }

  /**
   * A running agent as an agent watch reads it (#416), or null when it isn't running. A prompt Combwork typed within the last
   * PENDING_MS that its CLI hasn't taken yet is pending: the agent was just given a task, and counts as working. So is a
   * launch's task on its command line (#712): the CLI is ready at its SessionStart and takes the task only after, so it
   * is pending until its first prompt, at most PENDING_MS after it became ready.
   */
  agentNow(projectPath: string, agentId: string): { status: SessionStatus; runId: string; prompts: number; pending: boolean; statusMessage: string | null; backgroundTasks: number; reply: string | null } | null {
    const l = this.live.get(liveId(projectPath, agentId))
    if (!l) return null
    const prompts = l.prompts ?? 0
    const typed = !!l.typed && prompts <= l.typed.prompts && Date.now() - l.typed.at < PENDING_MS
    const pending = typed || launchPending(l)
    return { status: l.state.status, runId: l.state.runId, prompts, pending, statusMessage: l.state.statusMessage ?? null, backgroundTasks: l.state.backgroundTasks ?? 0, reply: l.lastReply ?? null }
  }

  /**
   * Whether an agent's CLI hasn't taken its launch's task yet (#712), as agentNow counts it (#721): nothing of Combwork's is
   * typed into it meanwhile, or its CLI's first prompt, the task's, would be taken for that line's and the line would go
   * first.
   */
  launchTaskWaiting(projectPath: string, agentId: string): boolean {
    const l = this.live.get(liveId(projectPath, agentId))
    return !!l && launchPending(l)
  }

  /**
   * Whether an agent's launch was given Combwork's tools and its CLI hasn't connected them yet (#865): a resumed Claude Code
   * is ready at its SessionStart before its combwork server has connected, and a doorbell typed then is a turn that can't
   * call cw_inbox. At most cw.mcp.connectSeconds from when it first became ready, for a CLI that never connects it
   * (its server failed to start, or MCP is off in it).
   */
  combworkToolsWaiting(projectPath: string, agentId: string): boolean {
    const l = this.live.get(liveId(projectPath, agentId))
    if (l?.combworkTools !== 'connecting') return false
    return l.readyAt === undefined || Date.now() - l.readyAt < advanced.number('cw.mcp.connectSeconds') * 1000
  }

  /**
   * The combwork server of an agent's launch `runId` says its CLI has connected (#865): Combwork's lines may go to it now, and
   * what waited is offered at once (its status is sent again, which deliveries follow). Whether it was that launch's.
   */
  /** Who waits for a launch's Combwork tools (combworkToolsSettled), by agent: each looks at the gate again when told. */
  private toolsWaiters = new Map<string, Set<() => void>>()
  /** The waits look again when Settings → Advanced changes (the bound applies at once), once one has waited. */
  private toolsSettingsHook: (() => void) | null = null

  /** The waits for an agent's Combwork tools look at the gate again (it connected, its launch changed or ended). */
  private recheckTools(key: string): void {
    for (const look of [...(this.toolsWaiters.get(key) ?? [])]) look()
  }

  /**
   * Resolves once an agent's Combwork tools no longer hold its lines (#865 rounds 3 and 4): once combworkToolsWaiting, the gate
   * itself, is false. It is looked at again when the tools connect, the launch's state changes or it ends, the bound is
   * changed in Settings → Advanced, and when what is left of the bound from its ready runs out; never a frozen deadline.
   */
  combworkToolsSettled(projectPath: string, agentId: string): Promise<void> {
    if (!this.combworkToolsWaiting(projectPath, agentId)) return Promise.resolve()
    const key = liveId(projectPath, agentId)
    this.toolsSettingsHook ??= advanced.onChange(() => {
      for (const k of [...this.toolsWaiters.keys()]) this.recheckTools(k)
    })
    return new Promise((settle) => {
      const waiters = this.toolsWaiters.get(key) ?? new Set<() => void>()
      this.toolsWaiters.set(key, waiters)
      let timer: NodeJS.Timeout | undefined
      const look = (): void => {
        clearTimeout(timer)
        if (this.combworkToolsWaiting(projectPath, agentId)) {
          const l = this.live.get(key)!
          const bound = advanced.number('cw.mcp.connectSeconds') * 1000
          timer = setTimeout(look, (l.readyAt === undefined ? bound : Math.max(0, bound - (Date.now() - l.readyAt))) + 50)
          return
        }
        waiters.delete(look)
        if (!waiters.size && this.toolsWaiters.get(key) === waiters) this.toolsWaiters.delete(key)
        settle()
      }
      waiters.add(look)
      look()
    })
  }

  combworkToolsConnected(projectPath: string, agentId: string, runId?: string): boolean {
    const l = this.live.get(liveId(projectPath, agentId))
    if (!l || (runId !== undefined && l.state.runId !== runId)) return false
    if (l.combworkTools !== 'connecting') return true
    l.combworkTools = 'connected'
    this.recheckTools(liveId(projectPath, agentId))
    log.info(`${userText(agentId)}'s Combwork tools connected${l.readyAt === undefined ? '' : ` ${Date.now() - l.readyAt} ms after it became ready`}`)
    this.emitState(l.state)
    return true
  }

  /**
   * Presses Enter again in an agent whose typed line wasn't taken (#376: a CLI dropped the Enter, and the line stayed in
   * its prompt). Only in the same launch, while it is idle (watching too: a watch lasts until its wake is received, #649),
   * and not while the user types there or Combwork types into it.
   */
  submitAgain(projectPath: string, agentId: string, runId: string): boolean {
    const l = this.live.get(liveId(projectPath, agentId))
    const key = this.key(projectPath, agentId)
    // Nor while its folder is being changed (#646 round 1: the Enter would start a turn under a Git switch or pull).
    if (!l || l.state.runId !== runId || !readyFor(l.state) || this.userMayBeTyping(projectPath, agentId) || this.delivering.has(key) || folderChanging(l.state.cwd)) return false
    // The prompt is the user's draft once they have typed in it (#652 round 1 finding 2): never sent by Combwork's Enter.
    if (this.userTypedOverLine(projectPath, agentId)) return false
    // Nor while its CLI's own question shows (HI-1959): Enter would answer it (HB4's wake answered Claude Code's offer).
    if (this.cliAsks(projectPath, agentId)) return false
    // Nor while something on its screen takes its keys (HI-2191).
    if (this.inputBlocked(projectPath, agentId)) return false
    l.combworkEnterAt = Date.now()
    writePty(key, '\r')
    return true
  }

  /**
   * Whether the user has typed in an agent's terminal since Combwork's line still waiting there began to be typed (#530, #652
   * round 1 finding 2): the prompt holds their input too, whatever the typing pause says (0 included), and is theirs, not
   * Combwork's to submit. False when no line of Combwork's waits.
   */
  userTypedOverLine(projectPath: string, agentId: string): boolean {
    const l = this.live.get(liveId(projectPath, agentId))
    return !!l?.typed && (l.prompts ?? 0) <= l.typed.prompts && this.userTypedAt(projectPath, agentId) >= l.typed.from
  }

  /**
   * Leaves Combwork's untaken line to the user, who typed into it (#652 round 1 finding 2): never submitted or cleared by Combwork,
   * and nothing more typed into the agent until a prompt is submitted there (its CLI's count goes up). Only for this launch.
   */
  leaveToUser(projectPath: string, agentId: string, runId: string): void {
    const l = this.live.get(liveId(projectPath, agentId))
    if (!l || l.state.runId !== runId) return
    l.draftOver = { prompts: l.prompts ?? 0 }
    this.noteComposer(l, this.key(projectPath, agentId))
  }

  /** Marks (or clears) the cards an agent in a card loop left with no watch (#376): they show as stalled. */
  setNotWatching(projectPath: string, agentId: string, cards: number[] | null): void {
    const l = this.live.get(liveId(projectPath, agentId))
    if (!l) return
    const next = cards?.length ? cards : undefined
    if (JSON.stringify(l.state.notWatching) === JSON.stringify(next)) return
    l.state.notWatching = next
    this.emitState(l.state)
  }

  /** Shows (or clears) an agent's deliveries not received yet and those overdue (#647, deliveries.ts); nothing sent when unchanged. */
  setInbox(projectPath: string, agentId: string, inbox: InboxSummary | undefined): void {
    const l = this.live.get(liveId(projectPath, agentId))
    if (!l || JSON.stringify(l.state.inbox) === JSON.stringify(inbox)) return
    l.state.inbox = inbox ? { unread: inbox.unread.map((m) => ({ ...m })), overdue: inbox.overdue } : undefined
    this.emitState(l.state)
  }

  /** Tells the user once that an agent in a card loop is waiting with no watch (#376). */
  notifyNotWatching(projectPath: string, agentId: string, cards: number[]): void {
    const st = this.live.get(liveId(projectPath, agentId))?.state
    if (!st) return
    const label = this.label(st)
    const which = cards.map(cardNamesOf(workspaceOf(projectPath), scopeOfHost(projectPath))).join(', ')
    this.notify(
      projectPath,
      withValues(msg({ id: 'session.notice.notWatching', defaultMessage: "{agent} isn't watching {cards}", description: "A notification's title: an agent working through cards in a loop ended its turn without watching them. {agent} is the agent; {cards} the cards (\"#12, #13\")." }), { agent: label, cards: which }),
      withValues(msg({ id: 'session.notice.notWatchingBody', defaultMessage: '{n, plural, one {Its turn ended without a card watch, so nothing wakes it when the card changes. Show it and ask it to carry on.} other {Its turn ended without a card watch, so nothing wakes it when they change. Show it and ask it to carry on.}}', description: "The notification that an agent in a card loop isn't watching its cards. {n} is how many cards." }), { n: cards.length }),
      'waiting',
      st.agentName,
      agentId
    )
  }

  /** A watch began or ended: the agent's status follows (watching, or finished again). */
  watchChanged(projectPath: string, agentId: string): void {
    const l = this.live.get(liveId(projectPath, agentId))
    if (l) this.emitState(l.state)
  }

  /** Called when an agent's launch ends (its exit, or a start given up): the merge slot releases its hold (#350). */
  readonly onLaunchEnded = new Set<(projectPath: string, agentId: string, runId: string) => void>()

  /**
   * The agent's place at the merge slot, shown with its status (only for this launch: a newer one has its own): holding it
   * to merge into a branch, or waiting behind its holder. `mergeSlot` is its English (agents read it), `mergeSlotText` the
   * window's (#845).
   */
  setMergeSlotNote(projectPath: string, agentId: string, runId: string, text: string | null, about?: SlotNote): void {
    const l = this.live.get(liveId(projectPath, agentId))
    if (!l || l.state.runId !== runId || (l.state.mergeSlot ?? null) === text) return
    l.state.mergeSlot = text ?? undefined
    l.state.mergeSlotText = text !== null && about ? slotNoteText(about, cardNamesOf(workspaceOf(projectPath), scopeOfHost(projectPath))) : undefined
    this.emitState(l.state)
  }

  private launchEnded(projectPath: string, agentId: string, runId: string): void {
    for (const f of this.onLaunchEnded) {
      try {
        f(projectPath, agentId, runId)
      } catch (e) {
        log.warn('after an agent stopped', e)
      }
    }
  }
  /** The project's newest handovers in the shared notes, newest first (at most `count`). */
  recentHandovers: (projectPath: string, count: number) => Promise<HandoverRef[]> = async () => []

  /** The project's newest handover, or null. */
  async latestHandover(projectPath: string): Promise<HandoverRef | null> {
    return (await this.recentHandovers(projectPath, 1))[0] ?? null
  }
  private exitWaiters = new Map<string, () => void>()
  /**
   * Agents being started (by liveId), so two starts at once can't both get through, and so stopping the
   * agent, closing its workspace or quitting can cancel a start that hasn't spawned its process yet.
   */
  private starting = new Map<string, PendingStart>()
  /**
   * Each run holding a slot's writer (#1434), from its claim until its release is handed on: whether it has spawned a
   * process (setup or its CLI), and its claim's tracked work, ended once it has (or once its start is given up).
   */
  private writers = new Map<string, { projectPath: string; agentId: string; spawned: boolean; done: () => void }>()
  /** Combwork is quitting: no new agent starts. */
  private shuttingDown = false
  /** The window showing a project (several windows each show one workspace). */
  private getWindow: (projectPath?: string) => BrowserWindow | null = () => null

  setWindowProvider(fn: (projectPath?: string) => BrowserWindow | null): void {
    this.getWindow = fn
  }

  key(projectPath: string, agentId: string): string {
    return agentPtyKey(projectPath, agentId)
  }

  /** The agent a call that names none means: the project's only agent. */
  async soleAgent(projectPath: string): Promise<string> {
    const agents = projectAgents(await workspace.projectConfig(projectPath))
    if (agents.length === 1) return agents[0].id
    if (agents.length) throw combworkError(msg({ id: 'session.error.severalAgents', defaultMessage: 'This project has several agents: choose which one.', description: "An action that names no agent is refused: the project has more than one." }), undefined, { kind: 'invalid' })
    throw combworkError(msg({ id: 'session.error.noAgents', defaultMessage: 'This project has no agents yet. Add one first.', description: 'An action on an agent is refused: the project has none.' }), undefined, { kind: 'conflict' })
  }

  liveCount(provider?: ProviderId): number {
    return provider ? [...this.live.values()].filter((l) => l.state.provider === provider).length : this.live.size
  }

  liveStates(): LiveSessionState[] {
    return [...this.live.values()].map((l) => l.state)
  }

  /** The background tasks running in a project's agents' launches (#1254, the Activity tab), as their CLIs described them. */
  backgroundTasks(projectPath: string): ActivityTask[] {
    return this.projectStates(projectPath).flatMap((state) => {
      const l = this.live.get(`${projectPath.toLowerCase()}#${state.agentId}`)
      return [...(l?.tasks ?? new Map()).entries()].map(([id, t]) => ({ agentId: state.agentId, sessionId: state.sessionId, id, ...(t.type ? { type: t.type } : {}), ...(t.description ? { description: maskText(t.description) } : {}), at: t.at }))
    })
  }

  /**
   * A project's sessions for the Activity tab (#1254): from its records and the usage history's titles alone, those
   * running or active within `hours`; no transcript is looked for or stat'ed (a session's turns are read when it opens),
   * so it answers in milliseconds where the full listing (list()) takes most of a second with hundreds.
   */
  async activitySessions(projectPath: string, hours: number): Promise<SessionListItem[]> {
    projectPath = workspace.assertSessionHost(projectPath)
    const file = await workspace.sessionsFile(projectPath)
    const stored = await usageHistory.storedUsage(projectPath).catch(() => new Map<string, StoredUsage>())
    const live = new Set(this.projectStates(projectPath).map((s) => s.sessionId))
    const since = Date.now() - hours * 3600_000
    const out: SessionListItem[] = []
    for (const rec of file.sessions) {
      const kept = stored.get(rec.id)
      const usage = kept ? this.titled(kept.usage) : null
      const last = usage?.lastActivity ?? rec.lastActiveAt
      if (!live.has(rec.id) && (rec.archived || !(Date.parse(last) >= since))) continue
      const { keptUsage: _kept, ...fields } = rec
      out.push({ ...fields, provider: recordProvider(rec), source: 'combwork', title: usage?.title ?? null, lastActivity: last, hasTranscript: true, hasBackup: false, usage: null, recache: null })
    }
    return out
  }

  /** Whether a session of Combwork's runs, or is starting, in a folder (#1431: its skill copies stay while one does). */
  runningIn(folder: string): boolean {
    return [...this.live.values()].some((l) => samePath(l.state.cwd, folder))
  }

  /** runningIn, leaving out one session (by liveId): the launch asking whether another session reads the folder. */
  othersIn(folder: string, except: string): boolean {
    return [...this.live].some(([id, l]) => id !== except && samePath(l.state.cwd, folder))
  }

  /** How many agents of a workspace (its projects', its worktrees', its Assistant's) run or are starting. */
  agentsIn(workspacePath: string): number {
    const mine = (p: string): boolean => workspaceFor(p)?.path?.toLowerCase() === workspacePath.toLowerCase()
    return [...this.live.values()].filter((l) => mine(l.state.projectPath)).length + [...this.starting.values()].filter((p) => mine(p.projectPath)).length
  }

  /** One agent's session; without agentId, the project's first running agent's. */
  liveFor(projectPath: string, agentId?: string): LiveSessionState | null {
    if (agentId) return this.live.get(liveId(projectPath, agentId))?.state ?? null
    return this.projectStates(projectPath)[0] ?? null
  }

  /** When the agent's turn under way began (its ledger's), or null when it is in none (HI-2167: cw_lane start's safety net). */
  turnBegan(projectPath: string, agentId: string): number | null {
    const a = this.live.get(liveId(projectPath, agentId))?.ledger?.active
    return a && a.state === 'running' ? a.startedAt : null
  }

  /** The folders a running agent's launch was granted outside its own (#1439: its project's review copies); none if not running. */
  grantedDirs(projectPath: string, agentId: string): readonly string[] {
    return this.live.get(liveId(projectPath, agentId))?.extraDirs ?? []
  }

  projectStates(projectPath: string): LiveSessionState[] {
    const prefix = `${projectPath.toLowerCase()}#`
    return [...this.live.entries()].filter(([k]) => k.startsWith(prefix)).map(([, l]) => l.state)
  }

  private async agentDef(projectPath: string, agentId: string): Promise<{ agent: AgentDef; cfg: ProjectConfig; count: number }> {
    const cfg = await workspace.projectConfig(projectPath)
    const agents = projectAgents(cfg)
    const agent = agents.find((a) => a.id === agentId)
    if (!agent) throw combworkError(msg({ id: 'session.error.agentGone', defaultMessage: 'That agent no longer exists.', description: 'An action on an agent is refused: it was removed meanwhile.' }), undefined, { kind: 'notFound' })
    return { agent, cfg, count: agents.length }
  }

  /**
   * Resolves global + project settings (and the agent's own overrides) into what a session launches with. `reads`: the
   * workspace's skills and servers as read once for several agents (#1002), and `pc` the project's config as read for
   * them; without, they are read now.
   */
  async effective(projectPath: string, agent?: AgentDef, reads?: LaunchReads, pc?: ProjectConfig): Promise<EffectiveSettings> {
    return inWorkspace(workspaceOf(projectPath), () => this.effectiveHere(projectPath, agent, reads ?? new LaunchReads(), pc))
  }

  private async effectiveHere(projectPath: string, agent: AgentDef | undefined, reads: LaunchReads, readPc?: ProjectConfig): Promise<EffectiveSettings> {
    // A workspace still opening moves its MCP settings first (HI-1472): never a launch without what that gives it.
    await workspace.mcpSettled()
    const s = config.settings
    let pc = readPc ?? (await workspace.projectConfig(projectPath))
    const assistant = workspace.isAssistantHome(projectPath)
    // The accounts migration first (HI-2106: once, under the project's lock), so nothing launches with its agents' old
    // settings unread and not yet their connections'.
    if (migrationDue(pc, workspace)) {
      try {
        await ensureMigrated(projectPath)
      } catch (e) {
        throw combworkError(M.moveFailed, { project: basename(projectPath), error: errorText(e) })
      }
      pc = await workspace.projectConfig(projectPath)
    }
    // The agent as saved now, whoever migrated it (a start may hold one read before): only its provider as given is kept
    // (a run's own, pinProvider).
    const was = agent
    const fresh = was && projectAgents(pc).find((a) => a.id === was.id)
    if (was && fresh) agent = { ...fresh, provider: was.provider ?? fresh.provider }
    // Every Combwork skill for its audience (SKILL.md's metadata.audience) reaches the session: project agents get those for
    // agents, unless the workspace or the project switched one off (#1431, Skills → Delivered to agents); the Assistant
    // gets those for it.
    // A skill whose header is broken or whose audience is unknown reaches nobody: the launch says why (its problems).
    const skills: LaunchSkill[] = []
    const skillHashes: Record<string, string> = {}
    const skillProblems: Record<string, string> = {}
    const skillsOff: string[] = []
    for (const sk of await reads.skills()) {
      if (sk.problem) {
        skillProblems[sk.name] = sk.problem
        skillHashes[sk.name] = ''
      } else if (!assistant && skillFor(sk.audience, 'agent') && skillOff(sk.name, workspace.config, pc)) {
        skillsOff.push(sk.name)
      } else if (skillFor(sk.audience, assistant ? 'assistant' : 'agent')) {
        skillHashes[sk.name] = await reads.revision(sk.path)
        skills.push({ name: sk.name, sourcePath: sk.path, ...(skillHashes[sk.name] ? { revision: skillHashes[sk.name] } : {}) })
      }
    }
    // The workspace's servers on in the project (#713); the agent's own choice narrows them (#537): all of them unless
    // it names some. Never one named as Combwork's own (a hand-made .combwork/mcp/combwork.json): the CLIs pre-approve that one's tools.
    const forAgent = agent ?? projectAgents(pc)[0]
    // The Assistant gets the workspace's servers added for it (HI-1472, HI-2059: its view's MCP Servers, as a project's
    // MCP tab); never a project's.
    const mcpServers: Record<string, McpServerDef> = {}
    for (const m of await reads.servers()) {
      // Added there (HI-2059), as mcpAdded reads it: a list not yet converted keeps its old meaning.
      const on = assistant ? !!m.def && assistantMcpAdded(workspace.config.mcp).includes(m.name) : serverOnIn(m, pc.mcp, workspace.config.mcp.enabled)
      if (on && m.def && agentGetsMcp(forAgent, m.name) && !isReservedServerName(m.name)) mcpServers[m.name] = toLaunchDef(m.def, workspace.mcpDir)
    }
    const combwork = this.combworkMcp(projectPath, agent?.id)
    // Its instructions name only the skills the session gets (#1431).
    if (combwork) mcpServers[TOOLS_SERVER] = skillsOff.length ? { ...combwork, env: { ...combwork.env, CW_SKILLS_OFF: skillsOff.sort().join(',') } } : combwork
    // A project agent's side of the workflow (HI-2664): its tools follow its saved role, never its lanes (HR3's round 1).
    // Part of the signature, so a role change asks for a restart (restartForTools restarts it).
    if (mcpServers[TOOLS_SERVER] && !assistant && forAgent) {
      const side = toolSideOf(agentWorkflowRole(forAgent))
      // And the tools its project's workflow makes unusable (HI-2694), those its side doesn't already leave out: also in
      // the signature, so a workflow change that changes its list asks for a restart (restartForTools restarts it).
      const hidden = this.workflowToolsHidden(projectPath, side, pc)
      mcpServers[TOOLS_SERVER] = { ...mcpServers[TOOLS_SERVER], env: { ...mcpServers[TOOLS_SERVER].env, CW_SIDE: side, ...(hidden.length ? { CW_WORKFLOW_HIDDEN: hidden.join(',') } : {}) } }
    }
    // A jj project's agents (HI-2800): its instructions add the jj rule (platformRule). Part of the signature, so a
    // switch to jj or back is told to a running agent at its next start.
    if (mcpServers[TOOLS_SERVER] && !assistant && pc.platform === 'jj') mcpServers[TOOLS_SERVER] = { ...mcpServers[TOOLS_SERVER], env: { ...mcpServers[TOOLS_SERVER].env, CW_PLATFORM: 'jj' } }

    // Its connection (HI-2106; the Assistant's too): what it launches with, and the account it launches on, its own or
    // (decision H) its CLI's first usable here. A change of account asks for a restart; `connection` is null for an
    // account on the CLI's own home (Copilot's sign-in, a test home).
    // An Assistant that names no CLI yet (a new workspace's, HI-2108): the first usable account's, as a new agent's
    // (decision A); Settings' old choice only where none is usable.
    const cli = assistant && !forAgent?.provider && !forAgent?.connection ? (firstUsableAccount(workspace.config)?.provider ?? agentProvider(forAgent, s)) : agentProvider(forAgent, s)
    const choice = resolveAgentConnection(workspace.config, cli, forAgent?.connection, allAccounts(), allConnections())
    const connection = choice.ok ? (choice.account.home ? null : choice.account.id) : `!${choice.why}`
    const l = agentLaunchSettings(cli, choice.ok ? choice.connection : null, s, choice.ok && choice.account.kind === 'server')
    const extraArgs = l.extraArgs.flatMap((a) => splitArgs(a))
    const chime = pc.chime === 'inherit' ? s.notifications.chimeEnabled : pc.chime === 'on'
    // Never the CLI's own setting for the Assistant (#1284: Control relies on knowing its mode), whatever its connection says.
    const permissionMode = assistant && isCliOwnMode(l.permissionMode) ? providerDescriptor(cli).assistantMode : l.permissionMode
    // Its connection's launch policy (HI-2670): without Combwork's tools, no combwork server and none of Combwork's or the
    // workspace's skills; with its MCP isolation off too, none of the workspace's servers either (the CLI's own config
    // decides, as in a terminal). Part of the signature, so a change of it asks running agents for a restart.
    // An agent whose role is Independent launches as if its connection's switches were all off (HI-2731, Darren's 7 Nov
    // 22:15 decision: "Independent behaves as if connection level switches are off"): the "Launch as from a terminal"
    // preset, whatever its connection says. Its role is in the signature too, so a role change restarts it. Its own saved
    // role: an agent a tools-off connection makes Independent launches as that connection says (its other switches).
    const independent = !assistant && forAgent?.workflowRole === 'independent'
    const launch = launchPolicy(independent ? { launch: terminalPreset(l.provider) } : choice.ok ? choice.connection : null, l.provider, { assistant })
    const delivered = launch.tools ? skills : []
    if (!launch.tools) {
      delete mcpServers[TOOLS_SERVER]
      if (!launch.overrides[overrideId(l.provider, MCP_ISOLATION)]) for (const k of Object.keys(mcpServers)) delete mcpServers[k]
    } else if (mcpServers[TOOLS_SERVER] && !launch.guidance) {
      // Its tools without Combwork's guidance as their instructions (#1285).
      mcpServers[TOOLS_SERVER] = { ...mcpServers[TOOLS_SERVER], env: { ...mcpServers[TOOLS_SERVER].env, CW_GUIDANCE: '0' } }
    }
    return { provider: l.provider, skills: delivered, skillHashes: launch.tools ? skillHashes : {}, skillProblems, mcpServers, model: l.model, effort: l.effort, permissionMode, extraArgs, use200kContext: l.use200kContext, chime, connection, launch, ...(choice.ok ? { connectionName: choice.connection.name, connectionId: choice.connection.id } : {}) }
  }

  signature(e: EffectiveSettings): string {
    // The permission mode can be switched live (setPermissionMode), so it doesn't ask for a restart.
    const { chime: _c, skills: _s, permissionMode: _p, connectionName: _n, connectionId: _i, ...rest } = e
    return hashText(JSON.stringify(rest))
  }

  /**
   * Every agent of a project with its running session, for ProjectInfo. `scope`: the refresh it is for (#1002), whose
   * projects' running agents share one read of the workspace's skills and servers; without, this call's agents do.
   */
  async liveInfo(projectPath: string, cfg: ProjectConfig, scope?: object): Promise<{ live: LiveSessionState | null; restartNeeded: boolean; agents: AgentInfo[]; folders: NamedFolder[] }> {
    const reads = scope ? launchReadsOf(scope) : new LaunchReads()
    // Its sessions, and its slots and leases (#1434: an agent's conversations in its slots, and whether each may resume
    // now), read at once (HI-1705).
    const [file, facts, moves] = await whenAll([workspace.sessionsFile(projectPath), folderFacts(projectPath).catch(() => null), this.folderMoves(projectPath)])
    const records = file.sessions
    this.checkSubsOnce(projectPath, records)
    const openIds = new Set(this.projectStates(projectPath).map((s) => s.sessionId).filter(Boolean))
    const ids = new Set(projectAgents(cfg).map((a) => a.id))
    const slotFolders = facts?.slots.map((s) => s.folder) ?? []
    // Unreadable: no slots or homes, a 0.9 worktree still its agent's (as the contract reads a project not migrated).
    const shownFacts: FolderFacts = facts ?? { projectPath, migrated: false, migratedAgents: [], homes: [], slots: [] }
    // Slots held by an agent's run that is over, its processes not known ended (#1506): its ⋯ offers Release Slot….
    const held = facts?.slots.some((s) => s.writer) ? await heldSlots(projectPath).catch(() => new Map<string, string>()) : new Map<string, string>()
    // Every agent at once (HI-1705: one after another, each one's place waited behind other windows' file work), in order.
    const agents: AgentInfo[] = await whenAll(projectAgents(cfg).map(async (a): Promise<AgentInfo> => {
        const l = this.live.get(liveId(projectPath, a.id))
        let restartNeeded = false
        if (l && !l.state.settingUp) {
          try {
            const eff = await this.effective(projectPath, pinProvider(a, l.state.provider), reads, cfg)
            restartNeeded = this.signature(eff) !== l.state.launchSignature || (await this.dialectMoved(projectPath, a, l, reads))
            this.noticeModeSetting(l, eff.permissionMode)
          } catch {
            // Settings can't be read right now; don't nag.
          }
        }
        const provider = agentProvider(a, config.settings)
        // The Assistant's sessions ran in the workspace folder, not its home.
        const folder = workspace.isAssistantHome(projectPath) ? (workspaceOf(projectPath).path ?? projectPath) : projectPath
        const r = l ? null : resumeRecord(folder, a, records.filter((x) => recordProvider(x) === provider), openIds, ids, slotFolders)
        const hold = r && facts ? resumeHold(facts, folderAgent(a), r) : null
        // A resume of it starts a new conversation (HI-2540): its Resume says so before it is pressed.
        const fresh = r ? freshReasonOf(r, moves) : null
        // Its last conversation resumes in a retired home (#1441), though a new one starts elsewhere: its pane says so (#1552).
        const home = r && facts ? resumeHome(facts, r) : null
        // Its adopted worktree's slot (#1441), while it holds it carried.
        const carried = facts?.slots.find((s) => s.open?.kind === 'carried' && s.open.agent === a.id)?.name
        // Where it works now, as the window shows it (#1442).
        const at = await agentPlace(projectPath, a, l ? { cwd: l.state.cwd } : null, shownFacts).catch(() => null)
        const legacy = legacyWorktree(a)
        const shown = at ? shownPlace(shownFacts, folderAgent(a), at.now, at.branch, at.target) : { folder: projectPath, is: 'project' as const, name: null, branch: null }
        // Its 0.9 worktree's base, also for the slot it was carried into while that slot has no target (#1569).
        const place = (shown.is === 'legacy' || (shown.is === 'carried' && !shown.base)) && legacy?.base ? { ...shown, base: legacy.base } : shown
        return { ...a, ...agentLaunchView(a, cfg), live: l?.state ?? null, restartNeeded, resume: r && { id: r.id, name: r.name, lastActiveAt: r.lastActiveAt, createdAt: r.createdAt, titleAtRename: r.titleAtRename, ...(hold ? { hold } : {}), ...(fresh ? { fresh } : {}), ...(home ? { home } : {}) },...(carried ? { carriedSlot: carried } : {}), ...(held.has(a.id) ? { heldSlot: held.get(a.id) } : {}), place }
    }))
    const primary = agents.find((a) => a.live)
    return { live: primary?.live ?? null, restartNeeded: primary?.restartNeeded ?? false, agents, folders: namedFolders(shownFacts) }
  }

  private backupPath(projectPath: string, sessionId: string, archived = false): string {
    return join(this.backupDir(projectPath, archived), `${assertSessionId(sessionId)}.jsonl`)
  }

  private backupDir(projectPath: string, archived = false): string {
    return join(projectPath, CW_DIR, archived ? 'archive' : 'sessions')
  }

  /** Works out usage again (e.g. after price changes, so estimates are recomputed); what was read is kept. */
  clearUsageCache(): void {
    for (const c of usageSeen.values()) c.usage = null
  }

  /**
   * Forgets the transcripts' usage read in this run (Settings → Sessions → Clear): each is read again when needed. The
   * usage history keeps what sessions used: it isn't cleared.
   */
  async forgetUsageCache(): Promise<void> {
    usageSeen.clear()
    await usageHistory.forgetReads()
    await this.retireUsageCacheFile()
    log.info('usage cache cleared')
  }

  /** Removes usage-cache.json, which the usage history replaced (#1106), if a Combwork from before it left one. */
  async retireUsageCacheFile(): Promise<void> {
    if (!existsSync(usageCacheFile())) return
    await removePath(usageCacheFile())
    log.info('usage-cache.json removed: the usage history replaced it')
  }

  /**
   * A result with costs from the current prices: the provider's report, else (or on top) Combwork's estimate, and each day's
   * share. Without its timeline (usageTimeline has it): it stays in the cache, never in the usage passed on.
   */
  private priced(raw: SessionUsage, costFree = false, rows?: LedgerRow[]): SessionUsage {
    const { timeline: _timeline, ...usage } = raw
    // Free (HI-1772): a known $0, whatever prices the user set; its tokens as read.
    if (costFree) return withCostFree(usage)
    // On more than one model (HI-2675): priced a model at a time from its rows, as the history prices it, so a model with
    // no price leaves the cost a part (costUnpriced), never its tokens at $0 or at another model's price.
    if (rows?.length) return usageFromRows(summaryOf(usage), rows, config.settings)
    return priceUsage(usage, config.settings)
  }

  /**
   * Where a session's transcript is: the provider knows (by folder, or by the path it reported), and a
   * worktree agent's sessions ran in its worktree. The session's own record comes first.
   */
  async providerTranscript(projectPath: string, sessionId: string, ctx?: ListContext): Promise<{ path: string; provider: ProviderId } | null> {
    // Its own record by its key (HI-1887: a turn's end asks, and read every record each time).
    const rec = ctx ? ctx.records.find((s) => s.id === sessionId) : await workspace.sessionRecord(projectPath, sessionId)
    const live = this.projectStates(projectPath).find((s) => s.sessionId === sessionId)
    const ids = rec ? [recordProvider(rec)] : live ? [live.provider] : allProviders().map((p) => p.id)
    // Its own folder first, then every folder the host's sessions run in (sessionFolders, where list() finds them: a
    // sub-session started in a removed agent's worktree, or the Assistant's workspace folder): those, and the host's
    // records and settings they come from, read only when its own folder hasn't it.
    const own = rec?.cwd ? [rec.cwd] : []
    // The path the CLI reported, as recorded; if it was inside a folder that moved to .combwork (HI-2462: a CLI's home
    // kept there) and isn't there now, where the move put it. Recorded folders (`cwd`) stay as they were: the CLI files
    // its transcripts by them.
    const ws = workspaceFor(projectPath)?.path
    const recorded = rec?.transcriptPath && ws && !(await stat(rec.transcriptPath).then(() => true, () => false)) ? ((await movedPath(ws, rec.transcriptPath)) ?? rec.transcriptPath) : rec?.transcriptPath
    let others: string[] | undefined
    const othersOf = async (): Promise<string[]> => {
      if (others) return others
      const records = ctx?.records ?? (await workspace.sessionsFile(projectPath)).sessions
      const cfg = ctx?.cfg ?? (await workspace.projectConfig(projectPath))
      const seen = new Set(own.map((f) => resolve(f).toLowerCase()))
      others = [...new Map(this.sessionFolders(projectPath, records, cfg).map((f) => [resolve(f).toLowerCase(), f])).entries()].filter(([k]) => !seen.has(k)).map(([, f]) => f)
      return others
    }
    for (const id of ids) {
      let adapter: ProviderAdapter
      try {
        adapter = providerAdapter(id)
      } catch {
        continue
      }
      for (const f of own) {
        const t = await adapter.transcriptPath(f, sessionId, recorded)
        if (t) return { path: t, provider: id }
      }
      for (const f of await othersOf()) {
        const t = await adapter.transcriptPath(f, sessionId, recorded)
        if (t) return { path: t, provider: id }
      }
    }
    return null
  }

  async start(projectPath: string, opts: StartOptions): Promise<StartedSession> {
    this.assertStartsAllowed(projectPath)
    projectPath = workspace.assertSessionHost(projectPath)
    // A start of the user's (not a switch's own resume) replaces a switch of connection waiting for that agent (HI-1755).
    if (opts.agentId && !this.switchResuming.has(liveId(projectPath, opts.agentId))) this.switches.get(liveId(projectPath, opts.agentId))?.cancel('started by hand') // i18n-ignore: for the log
    if (opts.resumeId !== undefined) assertSessionId(opts.resumeId)
    const agentId = opts.agentId || (await this.soleAgent(projectPath))
    // HI-2463: a conversation Combwork launched before what agents see was renamed remembers the tools' old names and
    // the old progress reporter, so it isn't resumed: a new one starts instead, as Start Fresh does, and the old one stays in Sessions
    // to read. The first prompt this start was given (a restart's note: its card, round and lane) goes to the new one.
    // Every resume comes here (a restart's, Resume All, a manual one, a lane's or a card's placement, the Assistant's).
    // HI-2462: so is one whose folder was inside a pre-1.1 data folder that moved to `.combwork`: Claude Code files its transcript by
    // that folder, and Combwork neither starts it in a folder that is gone nor copies the CLI's files; the transcript
    // stays readable where it was recorded.
    const freshWhy = opts.resumeId ? await this.freshReason(projectPath, opts.resumeId) : null
    const freshFrom = freshWhy ? opts.resumeId! : null
    // It carries on the agent's own work, as a handover to itself does: its watch stays, and what waits for the old
    // conversation (its wakes, messages, tasks) is for the new one.
    if (freshFrom) opts = { ...opts, resumeId: undefined, keepWatch: true }
    // Again after the await, with nothing awaited before the start is reserved: a fence raised meanwhile holds.
    this.assertStartsAllowed(projectPath)
    const id = liveId(projectPath, agentId)
    // Checked and reserved before anything is awaited: a double click, or the UI and the Agent API at
    // once, must not start the agent twice (the second start would orphan the first process).
    if (this.live.has(id) || this.starting.has(id)) throw combworkError(msg({ id: 'session.start.alreadyRunning', defaultMessage: 'This agent is already running or starting. Stop it first.', description: 'Starting an agent is refused: it runs, or is starting, already.' }), undefined, { kind: 'conflict' })
    // Two terminals on one conversation would both append to its transcript.
    if (opts.resumeId && [...this.starting.values()].some((p) => p.resumeId === opts.resumeId)) throw combworkError(msg({ id: 'session.start.beingOpened', defaultMessage: 'This conversation is already being opened in another agent.', description: 'Resuming a conversation is refused: another agent is starting on it now.' }), undefined, { kind: 'conflict' })
    if (opts.resumeId && this.cleaning.has(`${projectPath.toLowerCase()}|${opts.resumeId.toLowerCase()}`)) throw combworkError(msg({ id: 'session.start.cleaning', defaultMessage: "Combwork is archiving, deleting or cleaning up this session's files. Try again in a moment.", description: "Resuming a conversation is refused for a moment: Combwork is moving or removing its files." }), undefined, { kind: 'conflict' })
    const pending: PendingStart = { projectPath, resumeId: opts.resumeId, cancelled: false, done: Promise.resolve(), outcome: Promise.resolve(null as never), runId: randomBytes(12).toString('hex') }
    this.starting.set(id, pending)
    // Started again (the user, a lane update, a Retry, a switch's resume): someone's earlier Stop no longer holds it (HI-2815).
    this.stoppedOnPurpose.delete(id)
    // A new start: an earlier one's failure is over (HI-1976). Cleared here, before it runs, never once it settles: its
    // CLI may exit meanwhile, and that failure (onExit's) must stand (HR6's round 1).
    startBegins(projectPath, agentId)
    // A start that takes over a second says where the time went (#1177: a resume waited ~45 s after an upgrade).
    const times = new StepTimes()
    // A new conversation (HI-2197): the agent's watch from before ended first, its wake cancelled, before anything launches.
    const before = freshFrom ? (this.deliveries?.carry(projectPath, agentId, freshFrom) ?? Promise.resolve(0)).then(() => undefined) : opts.resumeId || opts.keepWatch ? Promise.resolve() : this.conversationEnds(projectPath, agentId)
    const run = before.then(() => this.startReserved(projectPath, agentId, id, opts, times))
    pending.done = run.catch(() => undefined)
    pending.outcome = run
    try {
      const started = await run
      if (!freshFrom) return started
      this.renamedFresh(projectPath, agentId, freshFrom, freshWhy!, !opts.freshAsked)
      // Its caller says so (HI-2540: the Agent API's reply): a resume asked for, a new conversation started.
      return { ...started, startedFresh: freshWhy! }
    } catch (e) {
      // Given up before any process of it ran: its slot's writer released now (#1434). One that ran is its exit's.
      if (!this.writers.get(pending.runId)?.spawned) this.settleWriterOf(pending.runId)
      throw e
    } finally {
      this.starting.delete(id)
      endAdmission(id)
      const slow = times.slowLine()
      if (slow) log.info(`${opts.resumeId ? 'Resume' : 'Start'} of ${userText(agentId)} in ${userText(basename(projectPath))} ${slow}`)
    }
  }

  /**
   * Why a conversation starts fresh rather than resume, or null when it resumes (freshReasonOf: the rule the window's
   * lists read too, HI-2540). A record that can't be read resumes as before.
   */
  private async freshReason(projectPath: string, sessionId: string): Promise<FreshReason | null> {
    const rec = await workspace.sessionRecord(projectPath, sessionId).catch(() => undefined)
    return rec ? freshReasonOf(rec, await this.folderMoves(projectPath)) : null
  }

  /** The folders that moved in a project's workspace (HI-2462), for freshReasonOf; none when it has no workspace or can't be read. */
  private async folderMoves(projectPath: string): Promise<FolderMove[]> {
    const ws = workspaceFor(projectPath)?.path
    return ws ? movedFolders(ws).catch(() => []) : []
  }

  /** Fresh conversations started for ones from before HI-2463 or HI-2462's move, per workspace and reason, for one notice each. */
  private renamedFreshCount = new Map<string, { n: number; timer: ReturnType<typeof setTimeout> | null }>()

  /**
   * A conversation from before HI-2463 started fresh (it ran): logged, and counted for the workspace's notice, which
   * says how many once starts have been quiet for a moment (a restart resumes several at once), counting only those that
   * started.
   */
  private renamedFresh(projectPath: string, agentId: string, oldSession: string, why: FreshReason, withNotice: boolean): void {
    log.info(`${userText(agentId)} in ${userText(basename(projectPath))} started a new conversation${withNotice ? '' : ', as the user chose'}: ${oldSession.slice(0, 8)} ${why === 'renamed' ? "was launched before the agents' names changed (HI-2463)" : 'ran in a folder that moved to .combwork (HI-2462)'}, and stays in Sessions`)
    // HI-2540: the user was asked first, so nothing to tell them afterwards.
    if (!withNotice) return
    const path = workspaceFor(projectPath)?.path
    if (!path) return
    const ws = `${path}|${why}`
    const notice = why === 'renamed' ? RENAMED_FRESH : MOVED_FRESH
    const had = this.renamedFreshCount.get(ws) ?? { n: 0, timer: null }
    had.n++
    if (had.timer) clearTimeout(had.timer)
    had.timer = setTimeout(() => {
      this.renamedFreshCount.delete(ws)
      toast(
        'info',
        tr(notice.title),
        tr(notice.body, { n: had.n })
      )
    }, RENAMED_NOTICE_QUIET_MS)
    had.timer.unref?.()
    this.renamedFreshCount.set(ws, had)
  }

  /**
   * Refuses a start while Combwork quits, while the project's workspace is closing or switching, or while a fence holds the
   * project (it is being removed, or a template is replacing its agents), while its workspace's move is being repaired,
   * or while its workspace's upgrade to 1.0 waits.
   */
  private assertStartsAllowed(projectPath: string): void {
    if (this.shuttingDown || workspaceFor(projectPath)?.closing) throw combworkError(msg({ id: 'session.start.closing', defaultMessage: "Combwork is stopping this workspace's agents, so none can start now.", description: 'Starting an agent is refused: Combwork is quitting, or its workspace is closing.' }), undefined, { kind: 'conflict' })
    // Its workspace's upgrade to 1.0 waits (#1207): combwork.db takes no writes, so the session couldn't be recorded.
    const ws = workspaceFor(projectPath)?.path
    if (ws) assertUpgraded(ws)
    if (workspaceFor(projectPath)?.openGate?.held) throw combworkError(msg({ id: 'session.start.openCommands', defaultMessage: "This workspace's open commands are still running: agents start once they're done or you move on.", description: "Starting an agent is refused while the commands the user set to run as the workspace opens are running (Settings → Workspace → When this workspace opens, run), shown in a dialog with Don't wait." }), undefined, { kind: 'conflict' })
    if (workspaceFor(projectPath)?.repairingMove) throw combworkError(msg({ id: 'session.start.repairing', defaultMessage: 'Combwork is repairing this moved workspace: start the agent when Repair has finished.', description: "Starting an agent is refused while Repair… fixes a moved workspace's paths." }), undefined, { kind: 'conflict' })
    const why = this.fenced.get(resolve(projectPath).toLowerCase())?.at(-1)
    if (why) throw combworkError(msg({ id: 'session.start.fenced', defaultMessage: "{why}, so its agents can't start now.", description: "Starting an agent is refused while something changes its project. {why} says what, as a sentence without its full stop (\"This project is being removed\")." }), { why }, { kind: 'conflict' })
  }

  /** Projects (lower-cased paths) whose agents may not start, and why (one entry for each fence on it). */
  private fenced = new Map<string, TextPart[]>()

  /**
   * Keeps the project's agents from starting until the function returned is called: nothing may run in it while it is
   * being removed, or while a template replaces its agents (#126). Fences can overlap; each lifts its own.
   */
  fenceStarts(projectPath: string, why: TextPart = msg({ id: 'session.start.removing', defaultMessage: 'This project is being removed', description: "Why an agent can't start (followed by \", so its agents can't start now.\")." })): () => void {
    const key = resolve(projectPath).toLowerCase()
    this.fenced.set(key, [...(this.fenced.get(key) ?? []), why])
    let lifted = false
    return () => {
      if (lifted) return
      lifted = true
      const rest = [...(this.fenced.get(key) ?? [])]
      rest.splice(rest.indexOf(why), 1)
      if (rest.length) this.fenced.set(key, rest)
      else this.fenced.delete(key)
    }
  }

  /** Whether this agent has a start in progress (not yet in liveStates). */
  startingFor(projectPath: string, agentId: string): boolean {
    return this.starting.has(liveId(resolve(projectPath), agentId))
  }

  /** Projects with an agent starting (not yet in liveStates). */
  pendingStarts(): string[] {
    return [...this.starting.values()].map((p) => p.projectPath)
  }

  /**
   * Where a start runs (#1434, agentFolders.ts). A new conversation: where its purpose has the agent work (a reviewer
   * never in a slot), under that slot's lease. A conversation: where it was made, only while its slot's lease is the
   * agent's (one writer per slot) and it may resume now; a refused one says why. The user's own Resume of one whose slot
   * is free (or the agent's own under a later lease) takes the slot for the agent and binds it, in one write; Resume All
   * and startup's (`auto`) never do. Outside the slots, the project folder and a retired home are any agent's, and a 0.9
   * worktree only its agent's (`foreign` otherwise).
   */
  private async placeFor(projectPath: string, agent: AgentDef, existing: SessionRecord | undefined, opts: StartOptions, run: string): Promise<Place> {
    const fa = folderAgent(agent)
    // The agent's own runs that have ended, their writers' releases still being written: its slot is theirs until then.
    await this.earlierWritersSettled(projectPath, agent.id, WRITER_SETTLE_MS)
    try {
      const c = await claimPlace(projectPath, fa, existing ?? null, { purpose: fa.role === 'reviewer' ? 'review' : (opts.purpose ?? defaultPurpose(fa.role)), auto: !!opts.auto, run })
      // Its slot's writer is this run's from now: released once its processes are known to have ended, or its start is
      // given up before any ran.
      if (c.lease && c.slot) this.writers.set(run, { projectPath, agentId: agent.id, spawned: false, done: c.done })
      else c.done()
      return c
    } catch (e) {
      if (!(e instanceof ClaimRefused)) throw e
      const w = e.why
      if (w.is === 'hold') throw new CombworkError(holdText(w.hold, agent.name), { kind: 'conflict' })
      if (w.is === 'closing') throw combworkError(M.stoppedBeforeStart)
      if (w.is === 'setup') throw combworkError(msg({ id: 'session.start.slotSetup', defaultMessage: '{slot} is still being set up. {agent} can start there once it is ready.', description: "Starting or resuming an agent in a slot (a worktree Combwork lends to a card) is refused (#1434): Combwork is still setting the slot up (its setup or install command runs), or a command of it hasn't ended yet. {slot} is the slot's name (\"slot-b\"), {agent} the agent's." }), { slot: w.slot, agent: agent.name }, { kind: 'conflict' })
      // Its slot named (HI-2304): a connection switch's resume waits for that slot to be freed.
      if (w.is === 'busy') throw Object.assign(combworkError(msg({ id: 'session.start.slotBusy', defaultMessage: '{slot} still has another session in it, or processes one left running there. {agent} can start there once they have ended.', description: "Starting or resuming an agent in a slot (a worktree Combwork lends to a card) is refused (#1434): another session (of a card that has ended, or of another Combwork) still runs in it, or processes a session left running there aren't known to have ended. {slot} is the slot's name (\"slot-b\"), {agent} the agent's." }), { slot: w.slot, agent: agent.name }, { kind: 'conflict' }), { busySlot: w.slot })
      throw combworkError(msg({ id: 'session.start.slotChanged', defaultMessage: "{slot} isn't {agent}'s any more: its card or lane ended, or another agent's work has it. Start or resume {agent} again.", description: "Starting or resuming an agent in a slot (a worktree Combwork lends to a card) is refused (#1434): the slot's lease ended or changed hands while the start was getting ready. {slot} is the slot's name (\"slot-b\"), {agent} the agent's." }), { slot: w.slot, agent: agent.name }, { kind: 'conflict' })
    }
  }

  /**
   * A run's slot writer handed on, once (#1434): its claim's tracked work ends; with no process of it ever spawned it is
   * released now, else once its launch's job shows its processes ended (settleWriter), held otherwise.
   */
  private settleWriterOf(run: string): void {
    const w = this.writers.get(run)
    if (!w) return
    this.writers.delete(run)
    // Its claim's tracked work (which a closing pool awaits) ends once its release is written, when nothing of it ran.
    const settled = w.spawned ? settleWriter(w.projectPath, run) : releaseWriter(w.projectPath, run).finally(() => w.done())
    // Kept until written: a quit waits for them before its workspaces close (HI-1801).
    this.writersSettling.add(settled)
    const entry = { projectPath: w.projectPath, agentId: w.agentId, settled }
    this.writerSettlingOf.set(run, entry)
    void settled.finally(() => {
      this.writersSettling.delete(settled)
      if (this.writerSettlingOf.get(run) === entry) this.writerSettlingOf.delete(run)
    })
  }

  /** Writer releases under way (settleWriterOf): each its write of the release, once its run's outcome is known. */
  private readonly writersSettling = new Set<Promise<void>>()
  /** The same, by run, with whose run it was: the agent's next start waits for them (earlierWritersSettled). */
  private readonly writerSettlingOf = new Map<string, { projectPath: string; agentId: string; settled: Promise<void> }>()

  /**
   * Once the agent's runs that have ended have their slot writers released (or found held), at most `timeoutMs`
   * (HI-1867): a lane's start of its builder just after its last run ended (stopped by the start, or exited by itself
   * moments before) found the slot still written by that run, its release waiting for its processes to be known to have
   * ended, and was refused. None under way: at once. Another agent's or Combwork's writer, or one held (its processes kept
   * running, or not known to have ended), isn't waited for: the claim refuses it as before.
   */
  private async earlierWritersSettled(projectPath: string, agentId: string, timeoutMs: number): Promise<void> {
    const key = projectPath.toLowerCase()
    const mine = [...this.writerSettlingOf.values()].filter((e) => e.agentId === agentId && e.projectPath.toLowerCase() === key).map((e) => e.settled.catch(() => undefined))
    if (!mine.length) return
    let timer: NodeJS.Timeout | undefined
    await Promise.race([Promise.all(mine), new Promise<void>((r) => (timer = setTimeout(r, timeoutMs)))])
    clearTimeout(timer)
  }

  /**
   * Once the slot writers of the runs that have ended are released (or found held), at most `timeoutMs` (HI-1801: Combwork
   * quitting closed the workspace before a stopped run's release was written, its outcome known only after the
   * leftovers' look, so the next start found the slot held by a Combwork that had gone). Combwork's quit, after the leftovers;
   * a window's workspace closing, for its own projects' (`which`, HI-2299: closed first, its releases failed).
   */
  async writersSettled(timeoutMs: number, which?: (projectPath: string) => boolean): Promise<void> {
    const pending = (): Promise<void>[] => (which ? [...this.writerSettlingOf.values()].filter((e) => which(e.projectPath)).map((e) => e.settled) : [...this.writersSettling])
    const all = (async () => {
      for (let p = pending(); p.length; p = pending()) await Promise.allSettled(p)
    })()
    let timer: NodeJS.Timeout | undefined
    await Promise.race([all, new Promise<void>((r) => (timer = setTimeout(r, timeoutMs)))])
    clearTimeout(timer)
  }

  /** A process of a run holding a slot's writer has spawned (#1434): its exit settles it, and its claim's tracked work ends. */
  private writerSpawned(run: string): void {
    const w = this.writers.get(run)
    if (!w) return
    w.spawned = true
    w.done()
  }

  /** The agent's run now (#1434): its live session's, else its start's while being prepared. */
  runNow(projectPath: string, agentId: string): { run: string; starting: boolean } | null {
    const l = this.live.get(liveId(projectPath, agentId))
    if (l) return { run: l.state.runId, starting: false }
    const p = this.starting.get(liveId(projectPath, agentId))
    return p ? { run: p.runId, starting: true } : null
  }

  /**
   * Whether an agent's conversation may resume now where it was made (#1434, agentFolders.ts): null when it may, else its
   * hold (startup's resume of the last run leaves and lists one). A conversation not recorded, or an agent gone: null
   * (its start says why).
   */
  async resumeHoldFor(projectPath: string, agentId: string, sessionId: string): Promise<ResumeHold | null> {
    if (workspace.isAssistantHome(projectPath)) return null
    const cfg = await workspace.projectConfig(projectPath)
    const agent = projectAgents(cfg).find((a) => a.id === agentId)
    const rec = agent ? await workspace.sessionRecord(projectPath, sessionId) : undefined
    return agent && rec ? resumeHold(await folderFacts(projectPath), folderAgent(agent), rec) : null
  }

  /** A start of the agent under way (HI-1746): the conversation it resumes (null: a new one) and its outcome. */
  pendingStart(projectPath: string, agentId: string): { resumeId: string | null; outcome: Promise<LiveSessionState> } | null {
    const p = this.starting.get(liveId(projectPath, agentId))
    return p ? { resumeId: p.resumeId ?? null, outcome: p.outcome } : null
  }

  /**
   * A resume of `sessionId` refused because the agent is running or starting (HI-1746: Resume All while Combwork resumes
   * that same conversation for a card): 'running' when the agent runs that conversation now, or once a start of it
   * under way has finished (its failure or cancellation thrown); 'other' when it runs or starts anything else, or nothing.
   */
  async joinResume(projectPath: string, agentId: string, sessionId: string): Promise<'running' | 'other'> {
    projectPath = workspace.assertSessionHost(projectPath)
    // A start under way first (HR4's round 1): its live state is there before its launch has run, so it is joined by its
    // outcome, never by that state; then the run it started, still the agent's, in that conversation.
    const p = this.pendingStart(projectPath, agentId)
    if (p) {
      if (p.resumeId !== sessionId) return 'other'
      const started = await p.outcome
      const now = this.live.get(liveId(projectPath, agentId))?.state
      return now?.runId === started.runId && now.sessionId === sessionId ? 'running' : 'other'
    }
    return this.live.get(liveId(projectPath, agentId))?.state.sessionId === sessionId ? 'running' : 'other'
  }

  /**
   * The conversation a card's placement resumes for its stopped builder (HI-1746): the agent's newest record of its
   * provider bound to the card's lease, chosen first; then whether it can resume: `held` (resumeHold's, never passed
   * over for an older one or a new conversation), or `none` only when there is no such record or its transcript is gone.
   * A read that fails throws (unknown: the placement tries again).
   */
  async leaseConversation(projectPath: string, agentId: string, lease: string): Promise<{ is: 'none' } | { is: 'resume'; id: string; name: string } | { is: 'held'; hold: ResumeHold }> {
    const cfg = await workspace.projectConfig(projectPath)
    const agent = projectAgents(cfg).find((a) => a.id === agentId)
    if (!agent) return { is: 'none' }
    const provider = agentProvider(agent, config.settings)
    // The agent's records alone, newest first (HI-1236: by its index, not every record of the project).
    const rec = (await workspace.sessionsOfAgent(projectPath, agentId)).find((r) => r.agentId === agentId && r.lease === lease && !r.archived && !r.sub && recordProvider(r) === provider)
    if (!rec) return { is: 'none' }
    // A provider this version doesn't know: nothing it could resume. A lookup that fails throws (unknown: tried again).
    const adapter = allProviders().find((p) => p.id === provider)
    if (!adapter) return { is: 'none' }
    const transcript = await adapter.transcriptPath(rec.cwd ?? projectPath, rec.id, rec.transcriptPath)
    if (!transcript) return { is: 'none' }
    const hold = resumeHold(await folderFacts(projectPath), folderAgent(agent), rec)
    return hold ? { is: 'held', hold } : { is: 'resume', id: rec.id, name: rec.name }
  }

  /** Throws if the start was cancelled while it awaited something (the agent stopped, its workspace closed). */
  private assertStarting(id: string): void {
    if (this.starting.get(id)?.cancelled) throw combworkError(M.stoppedBeforeStart)
  }

  private async startReserved(projectPath: string, agentId: string, id: string, opts: StartOptions, times: StepTimes): Promise<LiveSessionState> {
    const { agent, cfg, count } = await this.agentDef(projectPath, agentId)
    times.mark('agentDef')
    this.assertStarting(id)
    if (this.live.has(id))
      throw count > 1
        ? combworkError(msg({ id: 'session.start.agentRunning', defaultMessage: '{agent} is already running. Stop it first.', description: "Starting an agent is refused: it runs already. {agent} is the agent's name." }), { agent: agent.name }, { kind: 'conflict' })
        : combworkError(msg({ id: 'session.start.projectRunning', defaultMessage: 'A session is already running for this project. Stop it first.', description: "Starting a project's only agent is refused: it runs already." }), undefined, { kind: 'conflict' })
    const holder = opts.resumeId ? this.projectStates(projectPath).find((s) => s.sessionId === opts.resumeId) : undefined
    if (holder) throw combworkError(msg({ id: 'session.start.openIn', defaultMessage: 'This conversation is already open in {agent}. An agent can only resume a session no other agent is running.', description: "Resuming a conversation is refused: another agent is running it. {agent} is that agent's name." }), { agent: holder.agentName ?? msg({ id: 'session.start.anotherAgent', defaultMessage: 'another agent', description: "Stands for an agent whose name isn't known, in the middle of a sentence (\"This conversation is already open in another agent.\")." }) }, { kind: 'conflict' })
    const assistant = workspace.isAssistantHome(projectPath)
    // A task given as it starts is Combwork typing into it (HI-2670): refused for an Independent agent, and on a
    // connection that launches without Combwork's typing, rather than dropped.
    if (opts.prompt?.trim() && !assistant) {
      if (!inWorkflow(agentWorkflowRole(agent))) throw combworkError(M.independentNoTask, { agent: agent.name }, { kind: 'conflict' })
      if (!launchPolicy(getConnection(agent.connection), agentProvider(agent, config.settings)).typing) throw combworkError(M.plainNoTask, { agent: agent.name }, { kind: 'conflict' })
    }
    const existing = opts.resumeId ? (await workspace.sessionsFile(projectPath)).sessions.find((s) => s.id === opts.resumeId) : undefined
    times.mark('sessionsFile')
    this.assertStarting(id)
    // A resume runs the provider its conversation ran in (#506), whatever the agent's provider is now: neither a default
    // nor a change of the agent's own re-points one. A new conversation of an agent with no CLI of its own (a new
    // workspace's Assistant) follows Automatic: it waits until Combwork knows what is installed.
    const recorded = opts.resumeId ? await this.resumeProvider(projectPath, opts.resumeId, existing) : null
    times.mark('resumeProvider')
    this.assertStarting(id)
    if (!recorded && !agent.provider && autoProviderPending(config.settings)) await providerService.settle()
    this.assertStarting(id)
    const providerId = recorded ?? agentProvider(agent, config.settings)
    // At start, Combwork may still be looking for that CLI.
    await providerService.settle(providerId)
    times.mark('providerSettle')
    // The PATH a new process gets now, with what was installed since Combwork started (#821).
    await refreshPathBeforeStart()
    times.mark('refreshPath')
    this.assertStarting(id)
    const adapter = providerAdapter(providerId)
    const name = adapter.descriptor.name
    const resuming = opts.resumeId ? 'yes' : 'no'
    if (!isProviderEnabled(config.settings, providerId)) throw combworkError(msg({ id: 'session.start.providerOff', defaultMessage: '{provider} is turned off. {resuming, select, yes {Turn it on in Settings → Providers to resume this conversation.} other {Turn it on in Settings → Providers to run {agent}.}}', description: "Starting an agent is refused: its coding agent is turned off in Settings → Providers. {provider} is the coding agent's name (Claude Code), {agent} the agent's; {resuming} says whether it resumes a conversation." }), { provider: name, resuming, agent: agent.name }, { kind: 'conflict' })
    const info = providerService.info(providerId)
    if (!info.found || !info.path) throw combworkError(msg({ id: 'session.start.providerMissing', defaultMessage: '{resuming, select, yes {{provider} is required to resume this conversation. Install it from Help → Provider Setup.} other {{provider} is required to run {agent}. Install it from Help → Provider Setup.}}', description: "Starting an agent is refused: its coding agent's CLI isn't installed. {provider} is the coding agent's name (Claude Code), {agent} the agent's; {resuming} says whether it resumes a conversation. Help → Provider Setup is a menu command." }), { provider: name, resuming, agent: agent.name }, { kind: 'conflict' })
    await workspace.ensureProject(projectPath)
    times.mark('ensureProject')
    // Where it runs (#1434, agentFolders.ts): the Assistant in the workspace folder, where it can read every project; a
    // conversation where it was made; a new one where its purpose has the agent work, under that slot's lease.
    const run = this.starting.get(id)!.runId
    const place: Place = assistant ? { cwd: workspaceOf(projectPath).path!, lease: null, slot: null, foreign: false } : await this.placeFor(projectPath, agent, existing, opts, run)
    times.mark('folder')
    this.assertStarting(id)
    const cwd = place.cwd
    // HI-2887: admitted in its folder now its folder is known, before anything is launched or prepared there: a folder
    // held against launches (jj's control's making) makes it wait; its admission lasts until the start ends.
    await admitLaunch(id, cwd, () => !!this.starting.get(id)?.cancelled)
    this.assertStarting(id)
    if (!existsSync(cwd)) throw combworkError(msg({ id: 'session.start.worktreeMissing', defaultMessage: "{agent}'s worktree folder is missing: {folder}. Start {agent} from its pane to recreate the worktree on its branch (Repair… if the workspace moved), or remove the agent.", description: "Starting an agent is refused: its git worktree's folder is gone. {agent} is the agent's name, {folder} the folder's path. Repair… is a command." }), { agent: agent.name, folder: cwd }, { kind: 'conflict' })

    if (existing?.archived) throw combworkError(msg({ id: 'session.start.archived', defaultMessage: 'This session is archived. Unarchive it before resuming.', description: 'Resuming an archived session is refused (Sessions tab: Unarchive).' }), undefined, { kind: 'conflict' })
    // A sub-session (a Codex guardian review, say) is not a conversation: never resumed (#239).
    const sub = opts.resumeId ? (existing ? await this.recordSub(projectPath, existing) : (await adapter.listSessions(cwd).catch(() => [])).find((e) => e.id === opts.resumeId)?.sub) : undefined
    times.mark('recordSub')
    if (sub) throw combworkError(msg({ id: 'session.start.subSession', defaultMessage: "That session is a {kind} {provider} ran for another session, not a conversation: it can't be resumed.", description: "Resuming a session is refused: the coding agent ran it for another session (a guardian review). {kind} is the coding agent's name for it, as it came; {provider} the coding agent's name (Codex)." }), { kind: sub.kind, provider: name }, { kind: 'conflict' })
    this.assertStarting(id)
    // By real paths (#455): the worktree's stored path may have changed form (an 8.3 short name, a junction) since.
    if (opts.resumeId && existing && place.foreign) {
      throw combworkError(msg({ id: 'session.start.otherFolder', defaultMessage: 'This session ran in {folder}. Resume it with the agent that works in that folder.', description: "Resuming a session is refused: it ran in another folder (another agent's worktree). {folder} is that folder's path." }), { folder: existing.cwd ?? projectPath }, { kind: 'conflict' })
    }
    // Providers that choose their own session id report it once started (see the start hook).
    const sessionId = opts.resumeId ?? (adapter.descriptor.capabilities.fixedSessionId ? (adapter.newSessionId?.() ?? randomUUID()) : '')

    const mode = assistant ? (await this.assistantInstructions(projectPath, agent).catch(() => null))?.mode : undefined
    times.mark('assistantInstructions')
    // A /rename in the CLI since the session was last named in Combwork is the newer name: Combwork takes it, and so passes
    // it back with --name rather than its own.
    let adopted: string | null = null
    // The CLI's title not known now (HI-2839 review round 1): no --name, so the CLI keeps its own title, whatever it is.
    let titleUnknown = false
    if (opts.resumeId && existing && (!opts.name?.trim() || opts.name.trim() === existing.name)) {
      // As its transcript has it now (HI-2839): a /rename just before Stop is in no history yet, and missing it here passes
      // the older name with --name, which Claude Code keeps as the title over the user's.
      const read = await this.resumeUsage(projectPath, opts.resumeId).catch(() => null)
      times.mark('usage')
      titleUnknown = !read?.known
      if (titleUnknown) log.info(`Session ${existing.id} is resumed without --name: its CLI's title couldn't be read in time`)
      else adopted = cliRename({ ...existing, usage: read!.usage }, assistant ? ASSISTANT_NAME : basename(projectPath))
      if (adopted) {
        await workspace.upsertSession(projectPath, { id: existing.id, name: adopted, titleAtRename: adopted })
        log.info(`Session ${existing.id} takes the name ${userText(adopted)} it was given in the CLI`)
      }
    }
    const sessionName = adopted || opts.name?.trim() || existing?.name || (assistant ? `${ASSISTANT_NAME}${mode ? ` · ${mode}` : ''} · ${formatDateTime(new Date())}` : autoName(projectPath, agent, count))
    // What the launch passes as --name: none while the CLI's title isn't known (above).
    const launchName = titleUnknown ? '' : sessionName
    const key = this.key(projectPath, agentId)
    const runId = run
    const state: LiveSessionState = {
      provider: providerId,
      runId,
      projectPath,
      agentId,
      agentName: agent.name,
      cwd,
      sessionId,
      sessionName,
      titleAtRename: adopted ?? (existing ? existing.titleAtRename : opts.name?.trim() ? null : undefined),
      status: 'starting',
      runtime: { lifecycle: 'starting', maintenance: null, attention: null, composer: 'free' },
      startedAt: new Date().toISOString(),
      sessionCreatedAt: existing?.createdAt,
      ...(place.lease && place.slot ? { slot: place.slot.name } : {}),
      launchSignature: '',
      unseen: false
    }
    this.live.set(id, { state, adapter, transcriptMtime: '', defaultModel: false, modeTail: '', recognition: new ScreenRecognition(adapter), launchMode: null, configuredMode: undefined, modeOverride: opts.permissionMode, name: sessionName, transcriptPath: existing?.transcriptPath, initialPrompt: opts.prompt?.trim() || undefined, ...(opts.prompt?.trim() ? { launchTask: true as const } : {}), ...(opts.handedOverFrom ? { handedOverFrom: opts.handedOverFrom } : {}), startAllowed: opts.allowed, resumed: !!opts.resumeId, ...(place.lease ? { lease: place.lease } : {}), ...(place.lease && place.slot ? { slotEnv: slotEnv(place.slot) } : {}) })
    this.runs.set(runId, id)

    const setup = cfg.worktreeSetup.trim()
    // The agent's own worktree's first setup (also adopted as its carried slot, #1441), never a slot the pool set up.
    const ownTree = legacyWorktree(agent)
    if (ownTree && legacySetupPending(agent) && setup && !opts.skipSetup && (!place.slot || samePlace(place.slot.folder, ownTree.path))) {
      // The worktree's setup command runs in the agent's terminal first, then the agent starts there.
      state.settingUp = true
      setStatus(state, withValues(msg({ id: 'session.status.settingUp', defaultMessage: 'Setting up the worktree: {command}', description: "An agent's status while the project's worktree setup command runs in its terminal. {command} is that command, as written." }), { command: setup }))
      const sh = shellCommand(setup)
      try {
        const tracked = await this.trackingReady()
        // The same last check as before an agent's own launch.
        if (this.starting.get(id)?.cancelled || this.shuttingDown || workspaceFor(projectPath)?.closing) throw combworkError(M.stoppedBeforeStart)
        opts.allowed?.()
        spawnPty(key, {
          file: sh.file,
          args: sh.args,
          cwd,
          env: childEnv(),
          quietExit: true,
          // What the setup command starts is the launch's too (an `npm install` left running).
          ...(tracked ? { track: (pid: number, cancelled: AbortSignal) => trackLaunch({ runId, projectPath, agentId, agentName: agent.name, gated: true }, pid, cancelled).then((r) => this.launchWord(r)) } : {}),
          onExit: (code) => void this.afterSetup(projectPath, agentId, code, { sessionId, name: launchName, resume: !!opts.resumeId })
        })
        // Its setup's process runs now (spawnPty returned, not thrown): its slot's writer is the run's processes' to settle.
        this.writerSpawned(runId)
      } catch (e) {
        this.forget(id)
        throw e
      }
      this.emitState(state)
      workspaceOf(projectPath).scheduleRefresh()
      return state
    }
    try {
      await this.launch(projectPath, agent, { sessionId, name: launchName, resume: !!opts.resumeId }, times)
    } catch (e) {
      this.forget(id)
      emit({ type: 'session-status', state: { ...state, status: 'stopped', runtime: { ...state.runtime!, lifecycle: 'stopped' } } })
      throw e
    }
    return state
  }

  private forget(id: string): void {
    const l = this.live.get(id)
    if (l) {
      this.runs.delete(l.state.runId)
      endHookToken(l.state.runId)
    }
    // An Assistant that didn't start: the token made for this launch stops working too.
    if (l && basename(l.state.projectPath) === ASSISTANT_DIR) this.onAssistantExit(l.state.projectPath)
    else if (l) endAgentToken(l.state.projectPath, l.state.agentId, l.state.runId)
    if (l) this.launchEnded(l.state.projectPath, l.state.agentId, l.state.runId)
    // Its slot's writer (#1434): released now if no process of it ran, else once they are known to have ended.
    if (l) this.settleWriterOf(l.state.runId)
    if (l?.state.hooksMissing) noteHooksMissing(l.state.projectPath, l.state.agentId, false)
    if (l) this.cancelIdleGrace(l)
    this.live.delete(id)
    this.recheckTools(id)
    // A start given up before its process spawned has no exit to wait for.
    this.exitWaiters.get(id)?.()
    this.exitWaiters.delete(id)
  }

  private async afterSetup(projectPath: string, agentId: string, code: number, launch: { sessionId: string; name: string; resume: boolean }): Promise<void> {
    const id = liveId(projectPath, agentId)
    const l = this.live.get(id)
    if (!l) return
    let agent: AgentDef | undefined
    try {
      agent = (await this.agentDef(projectPath, agentId)).agent
    } catch {
      // Removed while setting up.
    }
    if (code !== 0 || !agent || l.stopRequested) {
      void this.afterLaunch(l.state.runId, this.label(l.state))
      this.forget(id)
      emit({ type: 'session-status', state: { ...l.state, status: 'stopped', settingUp: false, runtime: { ...l.state.runtime!, lifecycle: 'stopped' } } })
      if (agent && !l.stopRequested)
        toast(
          'error',
          tr(msg({ id: 'session.setup.failedTitle', defaultMessage: '{project} · {agent}: setup failed', description: "A notice's title: the worktree setup command failed for an agent. {project} is the project, {agent} the agent." }), { project: basename(projectPath), agent: agent.name }),
          tr(msg({ id: 'session.setup.failed', defaultMessage: "The setup command exited with code {code}. Its output is in the agent's terminal. Fix it and start the agent again, or start it without setup.", description: "The notice that a worktree setup command failed. {code} is its exit code." }), { code: String(code) }),
          undefined,
          projectPath,
          agentTarget(projectPath, agent.id, agent.name)
        )
      workspaceOf(projectPath).scheduleRefresh()
      return
    }
    await workspace.updateLegacyAgent(projectPath, agentId, { needsSetup: false }).catch(() => undefined)
    l.state.settingUp = false
    setStatus(l.state, null)
    try {
      await this.launch(projectPath, ({ ...agent, needsSetup: false } as StoredAgent), launch)
    } catch (e) {
      void this.afterLaunch(l.state.runId, this.label(l.state))
      this.forget(id)
      emit({ type: 'session-status', state: { ...l.state, status: 'stopped', runtime: { ...l.state.runtime!, lifecycle: 'stopped' } } })
      toast('error', tr(msg({ id: 'session.start.couldNot', defaultMessage: 'Could not start {agent}', description: "A notice's title: an agent failed to start after its worktree setup. {agent} is the agent's name; the error follows." }), { agent: agent.name }), shownError(e), undefined, projectPath, agentTarget(projectPath, agent.id, agent.name))
    }
  }

  /** Starts the agent's CLI for an agent whose live entry already exists. */
  /**
   * Launches on the connection it gets (HI-1755, connectionForLaunch: refused, saying why, when there is none to use), held
   * until the launch has ended either way: by then its live state keeps the connection from being removed.
   */
  private async launch(projectPath: string, agent: AgentDef, opts: { sessionId: string; name: string; resume: boolean }, times?: StepTimes): Promise<void> {
    const l = this.live.get(liveId(projectPath, agent.id))!
    this.followConnections()
    const ws = workspaceOf(projectPath)
    // On its choice as saved now (not as it was when its start began), looked at again as launchOn's last await.
    await launchOnChosen({ provider: l.adapter.id, workspaceConfig: ws.path ? ws.config : null, agentName: agent.name, chosen: () => this.chosenConnection(projectPath, agent) }, async (conn, lastLook) => {
      times?.mark('connection')
      await this.launchOn(projectPath, agent, opts, times, conn, lastLook)
    })
  }

  /**
   * Why an agent's turn isn't over yet (HI-1706's laneEndHeldNow: slotsApp.ts sets it as it loads, as deliveries.ts sets
   * `deliveries`, so sessions.ts doesn't import it): a connection switch waits on it. Until set, nothing holds it.
   */
  safePointHeld: (projectPath: string, agentId: string, runId: string) => string | null = () => null

  /** Calls fn with a project's folder each time a slot of it may have come free (HI-2304: slotsApp.ts sets it as it loads). */
  slotFreedWatch: (fn: (projectPath: string) => void) => () => void = () => () => undefined

  /** What holds a slot of the project now, in English (HI-2304, slotHeldWords), or null once nothing of this Combwork's does. */
  private async slotHeldWhy(projectPath: string, slot: string): Promise<string | null> {
    const cfg = await workspaceOf(projectPath).projectConfig(projectPath).catch(() => null)
    const agents = cfg ? projectAgents(cfg) : []
    return slotHeldWords(projectPath, slot, (a) => agents.find((x) => x.id === a)?.name ?? a).catch(() => null)
  }

  /** Switches of connection waiting for their agent's safe point (HI-1755), by liveId: at most one per agent. */
  private switches = new Map<string, SwitchOp>()
  /** When each agent was last stopped at someone's request and not started since (HI-2815, stoppedOnPurposeAt), by liveId. */
  private stoppedOnPurpose = new Map<string, number>()
  /** Agents whose switch is resuming them now: that start is the switch's, not the user's. */
  private switchResuming = new Set<string>()
  /**
   * What each waiting switch is for (HI-2195, by liveId): `base`, HI-1755's own (a manual or fallback switch), and/or a
   * usage move, committed at the safe point. A usage move dropped leaves a base switch to go on; one alone ends it.
   */
  private switchIntents = new Map<string, SwitchIntents>()

  /**
   * Switches an agent to the connection it would launch on now, at its next safe point (HI-1755, connectionSwitch.ts):
   * once its turn is over its CLI is ended with its own exit, and once that run has exited its last session is resumed,
   * once. 'waiting': one already waits (it resumes on the choice as it is then); 'notRunning': nothing to switch.
   * `usage` (HI-2195): a usage move, whose commit writes the agent's connection at the safe point; without, the switch is
   * HI-1755's own. Either joins a switch already waiting (one quit), each kept apart (dropUsageMove).
   */
  /**
   * A running agent whose tool list changed since it launched, restarted to load the new one, resuming its conversation,
   * as a connection switch does: its role changed its side of the workflow (HI-2664, Darren's decision), or its project's
   * workflow settings changed the tools they make unusable (HI-2694, the same decision: either way, added or removed). Every
   * role change runs it (projectAgents.updateAgent: Agent Settings, the Agent API, the Assistant's cw_update_agent), and
   * every workflow settings change (workflowTools.ts, at any level, and the rules' switch):
   * - `ifIdle`: an idle agent at once; a busy one is `busy` (the window asks first; the Agent API's reply says so);
   * - `atSafePoint`: when its turn is over (the user chose Restart When Its Turn Is Over).
   * Until it has restarted (Later, a busy agent, a restart that failed), it keeps its old tools and is given no work that
   * needs the new ones (`sideAllows`). 'same': its list is as it launched (or it has no Combwork tools); 'notRunning':
   * nothing to restart.
   */
  async restartForTools(projectPath: string, agentId: string, o: { when: 'ifIdle' | 'atSafePoint' }): Promise<'restarting' | 'busy' | 'same' | 'notRunning'> {
    projectPath = workspace.assertSessionHost(projectPath)
    if (workspace.isAssistantHome(projectPath)) return 'same'
    const l = this.live.get(liveId(projectPath, agentId))
    if (!l || l.state.status === 'stopped') return 'notRunning'
    const { agent, cfg: pc } = await this.agentDef(projectPath, agentId)
    // What of Combwork's it would launch with now (HI-2731): a role change to or from Independent changes that (the
    // terminal preset, its connection's switches), not its side, and from a launch with no combwork server too.
    let keyNow: string | undefined
    try {
      keyNow = launchKeyOf(await this.effective(projectPath, agent, undefined, pc))
    } catch (e) {
      log.warn(`${userText(this.label(l.state))}: what it would launch with now, not read: its side alone decides`, e)
    }
    const launchChanged = keyNow !== undefined && l.launchKey !== undefined && keyNow !== l.launchKey
    if (!l.side && !launchChanged) return 'same'
    const now = toolSideOf(agentWorkflowRole(agent))
    const hidden = l.side ? this.workflowToolsHidden(projectPath, now, pc) : []
    const was = l.workflowHidden ?? []
    const sameHidden = hidden.length === was.length && hidden.every((t, i) => t === was[i])
    if (now === l.side && sameHidden && !launchChanged) return 'same'
    // Asked again (the window's question after the change's own): one restart, already on its way.
    if (l.sideRestart) return 'restarting'
    const busy = l.state.status === 'working' || l.state.turn?.state === 'running'
    if (o.when === 'ifIdle' && busy) return 'busy'
    const why = launchChanged ? 'what of Combwork\'s it launches with changed (its role to or from Independent)' : now !== l.side ? `its side of the workflow changed (${l.side} → ${now})` : `its project's workflow changed the tools it can use (left out: ${was.join(', ') || 'none'} → ${hidden.join(', ') || 'none'})` // i18n-ignore: a log line
    log.info(`${userText(this.label(l.state))}: ${why}, restarting it ${busy ? 'once its turn is over' : 'now'}`)
    const r = this.switchAtSafePoint(projectPath, agentId)
    if (r === 'notRunning') return 'notRunning'
    l.sideRestart = true
    return 'restarting'
  }

  /**
   * Whether a running agent's session has the tools of a part of the workflow (HI-2664, HR3's round 1): false while its
   * role has changed and it hasn't restarted to load them. Not running: true (it launches with its role's).
   */
  sideAllows(projectPath: string, agentId: string, part: 'builder' | 'reviewer'): boolean {
    const l = this.live.get(liveId(projectPath, agentId))
    if (!l || l.state.status === 'stopped') return true
    // Launched without Combwork's tools (Independent then, HI-2731, or its connection's off): no part's work until it has
    // relaunched with them, whatever its role says now.
    if (l.launchKey !== undefined && !l.side) return false
    if (!sideAllows(l.side, part)) return false
    // Nor while its launch lacks a tool of the part its project's workflow makes usable now (HI-2694, HR1's s11 point 2):
    // its own launch's list, so Later, a restart waiting or one that failed all hold until it has really relaunched. What
    // its project makes usable is read now; unreadable, every tool counts as usable (so a launch lacking one waits).
    const launched = l.workflowHidden ?? []
    if (!l.side || !launched.length) return true
    let now: string[] | null
    try {
      now = this.workflowHiddenOf(projectPath)
    } catch {
      now = null
    }
    return workflowAllows(launched, now, part)
  }

  /**
   * The tools its project's workflow left out of an agent's running launch (HI-2694): null when it isn't running or was
   * launched without Combwork's tools.
   */
  launchedWorkflowHidden(projectPath: string, agentId: string): string[] | null {
    const l = this.live.get(liveId(projectPath, agentId))
    return !l || l.state.status === 'stopped' || !l.side ? null : (l.workflowHidden ?? [])
  }

  /**
   * The tools its project's workflow makes unusable (HI-2694), for a project agent's launch on `side`: those its side
   * doesn't already leave out, sorted. Read through workflowHiddenOf (workflowTools.ts sets it at startup); unreadable, none.
   */
  private workflowToolsHidden(projectPath: string, side: string, pc: ProjectConfig): string[] {
    const bySide = hiddenForSide(side)
    try {
      return this.workflowHiddenOf(projectPath, pc).filter((t) => !bySide.includes(t))
    } catch (e) {
      log.warn('the tools a project\'s workflow hides, not read: none are', e)
      return []
    }
  }

  switchAtSafePoint(projectPath: string, agentId: string, usage?: UsageIntent): 'queued' | 'waiting' | 'notRunning' {
    projectPath = workspace.assertSessionHost(projectPath)
    const id = liveId(projectPath, agentId)
    const waiting = this.switchIntents.get(id)
    if (this.switches.has(id) && waiting) {
      if (waiting.join(usage) && usage) void this.switches.get(id)!.done.then((e) => usage.ended(e))
      return 'waiting'
    }
    if (this.switches.has(id)) return 'waiting'
    const l = this.live.get(id)
    if (!l || l.state.status === 'stopped') return 'notRunning'
    const intents = new SwitchIntents(usage)
    this.switchIntents.set(id, intents)
    const { runId, sessionId } = l.state
    const label = userText(this.label(l.state))
    const hostOpen = (): boolean => !this.shuttingDown && !!workspaceFor(projectPath) && !workspaceFor(projectPath)?.closing
    // Its run counts until it has left the live sessions (start refuses while it is there, whatever its status): its
    // session-exit, emitted once it has, is the change that resumes it.
    const running = (): boolean => this.live.get(id)?.state.runId === runId
    /** The slot its resume was refused for (HI-2304), while it waits for it. */
    let heldSlot: string | null = null
    const op = runSwitch({
      running,
      heldNow: () => this.safePointHeld(projectPath, agentId, runId),
      // A usage move's write, once (HR1: checked under the agent's lock then); rejected, it is dropped alone.
      commit: () => intents.commit(),
      quit: () => this.quit(projectPath, agentId, runId, { fenced: hostOpen, why: 'a switch of connection', ready: () => this.safePointHeld(projectPath, agentId, runId) }), // i18n-ignore: for the log
      resume: async () => {
        if (!hostOpen()) throw new Error('its workspace closed') // i18n-ignore: for the log
        // Its slot held when it last tried (HI-2304): looked at first, so a look while it still is starts nothing.
        if (heldSlot) {
          const why = await this.slotHeldWhy(projectPath, heldSlot)
          if (why) throw new SlotHeld(heldSlot, why)
        }
        this.switchResuming.add(id)
        try {
          await inWorkspace(workspaceOf(projectPath), () => this.start(projectPath, { agentId, ...(sessionId ? { resumeId: sessionId } : {}) }))
        } catch (e) {
          const slot = (e as { busySlot?: unknown }).busySlot
          if (typeof slot !== 'string' || !hostOpen()) throw e
          heldSlot = slot
          throw new SlotHeld(slot, (await this.slotHeldWhy(projectPath, slot)) ?? (e as Error).message)
        } finally {
          this.switchResuming.delete(id)
        }
      },
      waits: (e) => (e instanceof SlotHeld ? e.why : null),
      told: (why) => toast('warning', tr(msg({ id: 'session.switch.waitsTitle', defaultMessage: "{agent}'s switch of connection waits for {slot}", description: "A notice's title (HI-2304): an agent was stopped to switch it to another connection (account), and Combwork can't resume it yet because its slot (a worktree Combwork lends it, \"slot-a\") is still held. {agent} is the agent's name." }), { agent: l.state.agentName ?? this.label(l.state), slot: heldSlot ?? '' }), tr(msg({ id: 'session.switch.waits', defaultMessage: '{why}. Combwork resumes it once the slot is free.', description: "The notice that an agent's switch of connection waits (HI-2304): {why} says what holds its slot, in English (\"slot-a is held by WindowsSandboxServer, left running by MB1's last run\"), without its full stop." }), { why }), undefined, projectPath, agentTarget(projectPath, l.state.agentId, l.state.agentName ?? this.label(l.state))),
      // A slot of its project freed (HI-2304): what its resume waits for, when it does.
      watch: (look) => {
        const offEvents = onCombworkEvent((e) => {
          if ((e.type === 'session-status' && e.state.projectPath === projectPath && e.state.agentId === agentId) || (e.type === 'session-exit' && e.projectPath === projectPath && e.agentId === agentId)) look()
        })
        const offFreed = this.slotFreedWatch((p) => {
          if (heldSlot && samePlace(p, projectPath)) look()
        })
        return () => {
          offEvents()
          offFreed()
        }
      },
      log: (line) => log.info(`${label}: connection switch: ${line}`)
    })
    this.switches.set(id, op)
    l.state.switchPending = true
    this.emitState(l.state)
    if (usage) void op.done.then((e) => usage.ended(e))
    void op.done.then(() => {
      if (this.switches.get(id) === op) this.switches.delete(id)
      if (this.switchIntents.get(id) === intents) this.switchIntents.delete(id)
      const st = this.live.get(id)?.state
      if (st?.switchPending) {
        st.switchPending = undefined
        this.emitState(st)
      }
    })
    return 'queued'
  }

  /**
   * Drops an agent's usage move waiting for its safe point (HI-2195: the rule changed, the Advanced switch off, the user's
   * own choice), never one already committed: a base switch it joined goes on; one alone is cancelled, nothing typed.
   */
  dropUsageMove(projectPath: string, agentId: string, why: string): void {
    const id = liveId(projectPath, agentId)
    if (this.switchIntents.get(id)?.drop() === 'cancel') this.switches.get(id)?.cancel(why)
  }

  /**
   * An agent's switch under way (switchAtSafePoint: a connection switch, a usage move, a restart for its tools,
   * HI-2664/HI-2694), from its queueing until it has resumed or given up: `waiting` for its safe point (nothing typed yet),
   * `restarting` once its exit was typed (its run ending, or ended and about to resume), null for none. Either way not free
   * for a new conversation (HI-2739: a lane started meanwhile owes it one instead).
   */
  /**
   * When an agent was last stopped at someone's request (HI-2815: the user, the Assistant or an agent, through stop()),
   * in ms since the epoch; 0 if never, or once it has been started again since (start()). While it is set, nothing of
   * Combwork's own starts it: neither a lane's new conversation owed before it (HI-2034) nor its lane's next card.
   */
  stoppedOnPurposeAt(projectPath: string, agentId: string): number {
    return this.stoppedOnPurpose.get(liveId(projectPath, agentId)) ?? 0
  }

  switchUnderWay(projectPath: string, agentId: string): 'waiting' | 'restarting' | null {
    const op = this.switches.get(liveId(projectPath, agentId))
    return !op ? null : op.typed ? 'restarting' : 'waiting'
  }

  /** Whether an agent's usage move waits for its safe point (HI-2195). */
  usageMovePending(projectPath: string, agentId: string): boolean {
    return !!this.switchIntents.get(liveId(projectPath, agentId))?.usagePending
  }

  /**
   * The running agents (and Assistant) of a workspace whose connection isn't the one they would launch on now (HI-1755:
   * a connection turned off, the default changed, a choice changed), each switched at its next safe point. Returns them.
   */
  async switchAffected(workspacePath: string): Promise<{ projectPath: string; agentId: string; result: 'queued' | 'waiting' | 'notRunning' }[]> {
    const out: { projectPath: string; agentId: string; result: 'queued' | 'waiting' | 'notRunning' }[] = []
    for (const st of this.liveStates()) {
      if (!st.launchedConnection || st.status === 'stopped' || workspaceFor(st.projectPath)?.path?.toLowerCase() !== workspacePath.toLowerCase()) continue
      const host = workspaceOf(st.projectPath)
      const agent = (await host.projectConfig(st.projectPath).then((pc) => projectAgents(pc).find((a) => a.id === st.agentId)).catch(() => undefined)) ?? undefined
      const eff = await this.effective(st.projectPath, agent).catch(() => null)
      // By connection, not account (HI-2413): another connection on the same account is switched to too.
      if (!eff || !connectionSwitchDue(st.launchedConnection, eff)) continue
      out.push({ projectPath: st.projectPath, agentId: st.agentId, result: this.switchAtSafePoint(st.projectPath, st.agentId) })
    }
    return out
  }

  private connectionsFollowed = false
  /** Once: connections in use can't be removed, and a connection found signed in again ends its sign-out wait. */
  private followConnections(): void {
    if (this.connectionsFollowed) return
    this.connectionsFollowed = true
    setAccountSessions((id) => this.liveStates().some((s) => s.launchedConnection?.id === id))
    onConnectionSignedIn((id) => {
      const st = this.liveStates().find((s) => s.launchedConnection?.id === id)
      if (st) this.signedInAgain(authScope(st), true)
    })
  }

  /**
   * The connection an agent (or the Assistant) has chosen, as saved now (HI-1755; HI-2106: a connection's id), read under
   * the lock its changes take. Undefined: none (its CLI's first usable here).
   */
  private async chosenConnection(projectPath: string, agent: AgentDef): Promise<string | null | undefined> {
    return ((await workspaceOf(projectPath).savedAgent(projectPath, agent.id)) ?? agent).connection
  }

  /**
   * A launch says its text in the dialect of the session it starts (HI-2443), whoever asked for it (another agent's
   * request has its own scope): its guidance, notes and the files its CLI reads, once its chain is pinned (launchOnHere).
   */
  private launchOn(projectPath: string, agent: AgentDef, opts: { sessionId: string; name: string; resume: boolean }, times: StepTimes | undefined, conn: LaunchConnection | null, lastLook: () => Promise<void>): Promise<void> {
    return inDialectOf({ projectPath, agentId: agent.id }, () => this.launchOnHere(projectPath, agent, opts, times, conn, lastLook))
  }

  /** The session's dialect chain, resolved for a launch from its workspace's files (null: they can't be read). */
  private async launchDialect(projectPath: string, input: SessionDialect, reads = new LaunchReads()): Promise<PinnedDialect | null> {
    const set = await reads.dialects(workspaceOf(projectPath).combworkDir)
    if (!set) return null
    const chain = sessionChainOf(set, input)
    return { chain, input, key: chainKey(chain) }
  }

  /**
   * Whether a running session's dialect chain is no longer what a launch now would give it (HI-2443, Q6: "restart to
   * apply"): a file in its chain edited, switched off, added or gone, or its Dialect setting changed. Resolved from what
   * it launched with (its CLI and real model ID: a change of model asks for a restart by itself), so the refresh reads no
   * CLI's config. Files that can't be read now don't nag.
   */
  private async dialectMoved(projectPath: string, agent: AgentDef, l: LiveSession, reads: LaunchReads): Promise<boolean> {
    if (!l.dialect) return false
    const now = await this.launchDialect(projectPath, { ...l.dialect.input, pick: pickOf(agent.dialect) }, reads).catch(() => null)
    return !!now && now.key !== l.dialect.key
  }

  /**
   * Which files each running session of a workspace speaks, and whether its chain moved (HI-2444, the Dialects view;
   * never the Agent API): from the chains pinned at their launches, with one read of the dialect files for them all.
   * `moved` is the chain's own "restart to apply" (dialectMoved), apart from skills, settings or a connection.
   */
  async dialectUsage(workspacePath: string): Promise<DialectUsage[]> {
    const reads = new LaunchReads()
    const ws = workspacePath.toLowerCase()
    const running = [...this.live.values()].filter((l) => l.dialect && workspaceFor(l.state.projectPath)?.path?.toLowerCase() === ws)
    return whenAll(
      running.map(async (l) => {
        const st = l.state
        const d = l.dialect!
        const agent = await workspaceOf(st.projectPath).savedAgent(st.projectPath, st.agentId).catch(() => undefined)
        const moved = agent ? await this.dialectMoved(st.projectPath, agent, l, reads) : false
        return { projectPath: st.projectPath, agentId: st.agentId, agent: agent?.name ?? this.label(st), cli: d.input.cli, files: d.chain.layers.flatMap((x) => (x.file ? [x.file] : [])), moved }
      })
    )
  }

  /**
   * The model IDs Combwork has seen a CLI run, for a workspace's Dialects view (HI-2523): its own running sessions'
   * launch model IDs, then the CLI's connections' models (dialectModelSuggestions says which, in what order).
   */
  dialectModelsSeen(workspacePath: string | null | undefined, cli: ProviderId): string[] {
    const live = [...this.live.values()].flatMap((l) => (l.dialect ? [{ cli: l.dialect.input.cli, modelId: l.dialect.input.modelId, workspace: workspaceFor(l.state.projectPath)?.path }] : []))
    return dialectModelSuggestions(cli, workspacePath, live, allAccounts(), allConnections())
  }

  /** The chain a running session speaks (the resolver's session scope): null for the Default, or one not running. */
  pinnedChain(projectPath: string, agentId: string): ResolvedChain | null {
    const d = this.live.get(liveId(projectPath, agentId))?.dialect
    return d?.chain.hash ? d.chain : null
  }

  private async launchOnHere(projectPath: string, agent: AgentDef, opts: { sessionId: string; name: string; resume: boolean }, times: StepTimes | undefined, conn: LaunchConnection | null, lastLook: () => Promise<void>): Promise<void> {
    const id = liveId(projectPath, agent.id)
    const l = this.live.get(id)!
    const { state, adapter } = l
    const cwd = state.cwd
    // Performance metrics for this launch go to the workspace it started in (none, if that closes meanwhile).
    const metrics = metricsHandle(workspaceOf(projectPath))
    const { sessionId } = opts
    // The account it launches on (HI-2852): a sign-in account's own models and default, as its folder says; a server's
    // connection and a launch on the CLI's own home, the CLI's catalogue.
    const modelAccount = conn ? ({ id: conn.id, kind: conn.server ? 'server' : 'signIn' } as const) : null
    const info = accountInfo(providerService.info(adapter.id), modelAccount) ?? providerService.info(adapter.id)
    if (!info.path) throw combworkError(msg({ id: 'session.start.cliRequired', defaultMessage: '{provider} is required to run sessions.', description: "Starting an agent failed: its coding agent's CLI wasn't found. {provider} is the coding agent's name." }), { provider: adapter.descriptor.name }, { kind: 'conflict' })

    let resume = opts.resume
    if (resume) {
      const recorded = l.transcriptPath
      if (!(await adapter.transcriptPath(cwd, sessionId, recorded))) {
        // The provider has deleted it: put Combwork's backup back where the provider looks for it (a compressed one
        // decompressed, #1110: the only time it is).
        const backup = this.backupCopy(projectPath, sessionId)
        const dest = adapter.restorePath(cwd, sessionId, recorded)
        if (dest && backup) {
          await mkdir(dirname(dest), { recursive: true })
          if (isGz(backup)) await decompressTo(backup, dest)
          else await copyFile(backup, dest)
          log.info(`Restored transcript for ${sessionId} from Combwork's backup`)
        }
      }
      // A session restarted before anything was typed has no transcript: start it fresh under the same id
      // where the provider allows choosing it, else as a new session.
      resume = !!(await adapter.transcriptPath(cwd, sessionId, recorded))
      times?.mark('transcript')
      if (!resume) {
        log.info(`No transcript for ${sessionId}; starting it fresh instead of resuming`)
        if (!adapter.descriptor.capabilities.fixedSessionId) state.sessionId = ''
      }
    }

    // Its workspace's bundled skills and modes, brought up to date after its open (HI-1705), before they are read.
    await workspaceOf(projectPath).itemsUpToDate()
    times?.mark('skills up to date')
    const eff = await this.effective(projectPath, pinProvider(agent, state.provider))
    times?.mark('effective')
    // The model it runs as, the choice's (an alias resolved) or the CLI's default: for its dialect and its compaction.
    const chosenModel = eff.model || (conn ? adapter.configuredDefaultModel(conn.folder) : null) || info.defaultModel || ''
    // Its dialect chain, pinned for this launch (HI-2443): from its CLI, the real model ID it runs and its Dialect
    // setting as saved now, before any text of this launch is said. Files that can't be read: the Default.
    const pick = pickOf(((await workspaceOf(projectPath).savedAgent(projectPath, agent.id)) ?? agent).dialect)
    l.dialect = (await this.launchDialect(projectPath, { cli: adapter.id, modelId: dialectModelId(adapter.id, info, chosenModel), pick }).catch((e) => {
      log.warn(`${userText(this.label(state))}: its dialect couldn't be resolved, so it speaks the Default`, e)
      return null
    })) ?? undefined
    times?.mark('dialect')
    // Extra arguments saved before Settings refused a bare "--" (#523) stop the launch before anything changes.
    const argsProblem = capturedText((t) => extraArgsProblem(eff.extraArgs, t))
    if (argsProblem)
      throw combworkError(msg({ id: 'session.start.args', defaultMessage: '{problem} Fix it in its connection, {connection}, in Settings → Accounts & Connections.', description: "Starting an agent or the Assistant is refused: its connection's extra arguments are wrong (HI-2140). {problem} says why, as a sentence; {connection} is the connection's name, as in Settings → Accounts & Connections." }), { problem: argsProblem, connection: eff.connectionName ?? '' }, { kind: 'conflict' })
    l.configuredMode = eff.permissionMode
    let mode = eff.permissionMode
    if (l.modeOverride && modeAllowed(adapter.id, l.modeOverride, config.settings) && !(workspace.isAssistantHome(projectPath) && isCliOwnMode(l.modeOverride))) mode = l.modeOverride
    l.launchMode = mode
    state.permissionMode = mode ?? undefined
    // Given Combwork's tools, it takes no line of Combwork's until they have connected (#865).
    l.combworkTools = eff.mcpServers[TOOLS_SERVER] ? 'connecting' : undefined
    // What of Combwork's it launches with (HI-2670), frozen for this run: its hooks and deliveries read this, not a
    // connection changed since (they also read its role as it is now, so an agent made Independent gets nothing more).
    const policy = eff.launch
    l.policy = policy
    // Its own Agent API token for this launch, which confines its board calls to its project (the Assistant has its own).
    // None without Combwork's tools (HI-2670): nothing of Combwork's to call it with.
    if (!workspace.isAssistantHome(projectPath) && policy.tools) await newAgentToken({ workspace: workspaceOf(projectPath).path!, projectPath, agentId: agent.id }, state.runId)
    const assistantText = workspace.isAssistantHome(projectPath) ? await this.assistantInstructions(projectPath, agent).catch(() => null) : null
    // A new conversation starts in its mode; a resumed one is told it if it was last given another (below).
    l.mode = !resume ? assistantText?.modeId || undefined : undefined
    // This launch's own hook token (#345): in its environment for HTTP hooks, in a file outside the project for hook commands.
    const hookAuth = await newHookToken(state.runId)
    // Its chain's texts for cw-mcp.js and cw-progress.js (HI-2443), in the same private folder: a chain that
    // overrides nothing writes nothing, and they speak the Default as before.
    const pinned = l.dialect?.chain
    const dialectEnv: Record<string, string> = pinned?.hash && policy.tools
      ? ((await writeDialectFile(hookAuth.dir, pinned).catch((e) => {
          log.warn(`${userText(this.label(state))}: its dialect file couldn't be written, so its Combwork tools and cw-progress speak the Default`, e)
          return null
        }))?.env ?? {})
      : {}
    times?.mark('tokens')
    // Neither with its connection's guidance off (HI-2670): the guidance, its latest handover and the Workspace notes.
    const guidance = policy.guidance ? await this.combworkGuidance(projectPath).catch(() => '') : ''
    // The Workspace notes note as it is now (#1433): every agent, whatever its tools or folder; a running one keeps its own.
    const notes = policy.guidance ? await workspaceNotesFor(projectPath).catch(() => '') : ''
    // Instructions of Combwork's own given to this conversation at an earlier launch, by any agent (SessionRecord.promptAdded).
    const promptAddedBefore = resume && (await workspace.sessionsFile(projectPath).catch(() => null))?.sessions.find((s) => s.id === sessionId)?.promptAdded === true
    if (assistantText?.text.trim() || notes.trim()) l.promptAdded = true
    // A reviewer's grant of the project's review copies (#1439): one fixed folder, made if new, so it never changes
    // between submissions. Never in a slot (either building there) nor with review copies off.
    const copies = copiesDirOf(workspaceOf(projectPath).worktreesRoot, projectPath)
    const granted = grantsCopies({ capable: adapter.descriptor.capabilities.extraDirs, on: advanced.get(COPIES_REVIEW) !== false, reviews: policy.tools && reviewsWork(agentWorkflowRole(agent)), inProjectFolder: !l.slotEnv && samePlace(cwd, projectPath), assistant: workspace.isAssistantHome(projectPath) })
    const extraDirs = granted && (await mkdir(copies, { recursive: true }).then(() => true, () => false)) ? [copies] : []
    l.extraDirs = extraDirs
    l.cliVersion = info.version ?? null
    // Its side of the workflow for its metrics (HI-2049), once: its part in the running lanes now, else its own role.
    l.workflow = workspace.isAssistantHome(projectPath) ? 'none' : launchWorkflow(agentWorkflowRole(agent), await this.laneParts(projectPath, agent.id).catch(() => []))
    times?.mark('guidance')
    // Agents' temp folder (HI-2496): its own folder there, made, when the setting has one (none: the system Temp, as
    // before). Never in a project, slot or Combwork's own folders, of any open workspace: one that is stops the launch.
    const assistantHost = workspace.isAssistantHome(projectPath)
    // None with every override of its connection's off (HI-2670: as in a terminal, the system Temp).
    const tempSetting = Object.values(policy.overrides).some((v) => v) || !Object.keys(policy.overrides).length ? agentTempSetting(workspaceOf(projectPath)) : null
    const tempDir = tempSetting ? await prepareAgentTemp({ setting: tempSetting, host: projectPath, agentId: agent.id, assistant: assistantHost, protect: [...(await protectedFolders(openWorkspaces())), projectPath, cwd] }) : null
    times?.mark('tempDir')
    const binPath = (env: Record<string, string>, dir: string | null): Record<string, string> => (policy.tools ? withBinOnPath(env, dir) : env)
    const fixedHookUrl = this.fixedHookUrl()
    const ctx: LaunchContext = {
      projectPath,
      agentId: agent.id,
      executable: info.path,
      cliVersion: info.version,
      cwd,
      workspacePath: workspaceOf(projectPath).path!,
      runId: state.runId,
      sessionId: state.sessionId,
      resume,
      name: opts.name,
      skills: eff.skills,
      mcpServers: eff.mcpServers[TOOLS_SERVER] && dialectEnv.CW_DIALECT_FILE ? { ...eff.mcpServers, [TOOLS_SERVER]: { ...eff.mcpServers[TOOLS_SERVER], env: { ...eff.mcpServers[TOOLS_SERVER].env, ...dialectEnv } } } : eff.mcpServers,
      model: eff.model,
      // An effort the model that runs doesn't take (HI-1770: one moved onto it, or a connection's default) is kept, not used.
      effort: eff.effort && eff.connection && !eff.connection.startsWith('!') && !effortUsable(adapter.id, eff.model, modelAccount, eff.effort) ? null : eff.effort,
      permissionMode: mode,
      extraArgs: eff.extraArgs,
      use200kContext: eff.use200kContext,
      copies: copyBook(workspaceOf(projectPath)),
      othersHere: () => this.othersIn(cwd, id),
      extraDirs,
      hookUrl: `${this.hookUrl}?run=${state.runId}`,
      fixedHookUrl,
      hookAuthFile: hookAuth.file,
      privateDir: hookAuth.dir,
      guidance,
      instructions: assistantText?.text,
      notes,
      promptAddedBefore,
      // Its connection's overrides of its CLI (HI-2670), as this launch read them.
      overrides: policy.overrides,
      // The whole "as from a terminal" preset (HI-2731's Independent role or a connection with every switch off): HI-2761.
      asFromTerminal: !policy.guidance && !policy.tools && !policy.typing && Object.values(policy.overrides).every((v) => !v),
      trustedCombworkTools: workspace.isAssistantHome(projectPath) ? assistantTools(config.settings.assistant?.control, config.settings.assistant?.changeSettings === true, journalSettingsOf(workspaceOf(projectPath)).enabled) : undefined,
      // Not typed in without its connection's typing (HI-2670), nor given on the command line.
      initialPrompt: policy.typing ? l.initialPrompt : undefined,
      allowBackgroundSessions: providerSettings(config.settings, adapter.id).allowBackgroundSessions,
      ...(conn ? { connectionHome: conn.folder } : {}),
      // Its server connection's models (HI-2682): the adapter passes a local model's limits from them.
      ...(conn?.server ? { server: { models: conn.server.models, connection: (eff.connectionId && eff.connection === conn.id ? eff.connectionName : null) ?? conn.name } } : {}),
      // On a connection, without the variables its CLI would read as a login in its place (HI-1757).
      // A server connection's own variables (HI-1772: its server, models and key) after those left out, for this launch only.
      tempDir,
      // Its temp folder's variables last, over the account's and server's (HI-2496): none set, the environment as before.
      // Without Combwork's tools (HI-2670), only what its hooks report status with: no project, agent or API variables,
      // no cw-progress on its PATH.
      // Its signer last (HI-2867): with Combwork's tools and the Advanced switch on, its commits sign through cw-sign,
      // never waiting for a passphrase; entries of another Combwork's signer are dropped either way.
      env: withSessionSigner(withAgentTemp(binPath(withServerEnv(conn?.server?.env, withoutAccountEnv(conn ? adapter : null, childEnv({
        CW_HOOK_TOKEN: hookAuth.token,
        // Claude Code's hook commands (HI-2777: SessionStart, the admin snippet's status line) read where to post and the
        // auth file's header from these, so no command names a port or holds the token.
        [HOOK_URL_ENV]: fixedHookUrl ?? this.hookUrl,
        [HOOK_AUTH_FILE_ENV]: hookAuth.file,
        CW_RUN_ID: state.runId,
        ...(state.sessionId ? { CW_SESSION_ID: state.sessionId } : {}),
        ...(policy.tools ? { CW_PROJECT: basename(projectPath), CW_PROJECT_PATH: projectPath, CW_WORKSPACE: workspaceOf(projectPath).path!, CW_AGENT: agent.name, CW_PROVIDER: adapter.id } : {}),
        // Its dialect's file (HI-2443), for cw-progress run in its shell; none while it speaks the Default.
        ...dialectEnv,
        // Its slot's name and port block (#1429's slotEnv), while it runs in one.
        ...l.slotEnv,
        // Its connection's folder as the CLI's home (HI-1755): its login, settings and memory, its transcripts shared.
        ...(conn ? { [conn.homeEnv]: conn.folder } : {}),
        // Not for the Assistant: it reaches the API through its Combwork tools, with its own token.
        ...(workspace.isAssistantHome(projectPath) || !policy.tools ? {} : this.apiEnv(projectPath, agent.id))
      }))), this.binDir), tempDir), this.signer && policy.tools && advanced.get<boolean>(SIGN_FAIL_FAST) ? { ...this.signer, timeoutMs: advanced.number(SIGN_TIMEOUT) * 1000 } : null)
    }
    // The GitHub hosts a CLI signing in on one launches with (HI-2779): its project's, its workspace's, else the environment's.
    if (adapter.descriptor.capabilities.githubHost) ctx.githubHosts = await githubHostsFor(workspaceOf(projectPath), projectPath, ctx.env)
    const delivered = await adapter.prepareLaunch(ctx)
    times?.mark('prepareLaunch')
    // A local model's limits as applied (HI-2682), for its context meter: this launch's, never read again.
    state.localLimits = ctx.localLimits ?? undefined
    // The /model lineup it asked Claude Code for (HI-2684), or why none.
    state.picker = ctx.picker
    // The GitHub hosts it signs in on (HI-2779), as resolved for this launch: its usage stays attributed to them.
    state.signInHost = ctx.signInHost
    l.launchEnv = ctx.env
    // What the session got, measured on the copies its CLI reads (not their sources: a kept old copy is what it reads).
    const deliveredSizes = await deliveredSkillSizes(adapter, ctx, delivered).catch(() => ({ catalog: 0, bytes: 0, unmeasured: Object.values(delivered).filter((d) => d.revision).length }))
    times?.mark('skillSizes')
    if (workspace.isAssistantHome(projectPath)) await this.onAssistantLaunch(projectPath)
    times?.mark('assistantLaunch')
    // Through its gate when its processes can be tracked (#507), else directly, untracked, as said once.
    const tracked = await this.trackingReady()
    times?.mark('trackingReady')
    // Not while its folder is being changed under it (#646: a Git switch or pull there): it starts once that is done.
    await folderSteady(cwd)
    times?.mark('folderSteady')
    // A resumed conversation's transcript as it is before its CLI can write (HI-2816): the transcript fallback counts only
    // what it gains from here, however soon the CLI writes and whenever Combwork first looks. Not found: any counts.
    if (l.resumed) l.resumedBytes = await this.liveTranscript(l).then((t) => (t ? stat(t).then((s) => s.size) : -1)).catch(() => -1)
    // Its connection, the last await (HI-1755): its choice as saved now (read under the lock saves take), resolved again,
    // must still be the one prepared. From here to the spawn nothing awaits, so no save lands between. Another chosen,
    // or the one prepared removed: this launch ends, and it starts again on the choice saved now (launchOnChosen).
    await lastLook()
    // Checked after the last await, just before spawning: stopped, its workspace closed or switched, or the
    // provider turned off while this launch was being prepared, it must not start a process.
    if (l.stopRequested || this.live.get(id) !== l || this.starting.get(id)?.cancelled || !workspaceFor(projectPath) || this.shuttingDown || workspaceFor(projectPath)?.closing) throw combworkError(M.stoppedBeforeStart)
    // The model and effort it was given (HI-1996), and whether that model was chosen (its connection's) or its CLI's.
    state.launchedWith = launchedWithOf(ctx.model, ctx.effort)
    // Its account (conn), and the connection on it whose values it launched with (HI-2397), which the window names.
    const named = conn && eff.connectionId && eff.connection === conn.id ? { connection: { id: eff.connectionId, name: eff.connectionName ?? conn.name } } : {}
    state.launchedConnection = conn ? { id: conn.id, name: conn.name, ...named, ...(conn.note ? { note: conn.note } : {}), ...(conn.login ? { login: conn.login } : {}), ...(conn.server ? { server: { models: conn.server.models, local: conn.server.local } } : {}) } : undefined
    if (conn?.server && state.sessionId) (l.serverSids ??= new Set()).add(state.sessionId)
    // Decision H (HI-2108): its connection is off here or gone, so it runs on its CLI's first usable one: said once a launch.
    if (conn?.note === 'offFallback' || conn?.note === 'missing') toast('warning', tr(M.connectionFallbackTitle, { agent: this.label(state) }), tr(M.connectionFallback, { why: conn.note, wanted: getConnection(agent.connection)?.name ?? '', name: conn.name }), undefined, projectPath, agentTarget(projectPath, state.agentId, this.label(state))) // i18n-ignore: select keys, never shown
    if (!isProviderEnabled(config.settings, adapter.id)) throw combworkError(msg({ id: 'session.start.turnedOff', defaultMessage: '{provider} was turned off while {agent} was starting.', description: "Starting an agent failed: its coding agent was turned off in Settings meanwhile. {provider} is the coding agent's name, {agent} the agent's." }), { provider: adapter.descriptor.name, agent: agent.name }, { kind: 'conflict' })
    l.startAllowed?.()
    const cmd = adapter.buildCommand(info.path, ctx)
    // What the user should know about this launch: once per agent, folder and notice while Combwork runs.
    const notice = adapter.launchNotice?.(ctx)
    const noticeKey = notice ? `${id}\n${ctx.cwd}\n${notice.title}` : ''
    if (notice && !this.launchNotices.has(noticeKey)) {
      this.launchNotices.add(noticeKey)
      toast('warning', `${this.label(state)}: ${notice.title}`, notice.message, undefined, projectPath, agentTarget(projectPath, state.agentId, this.label(state)))
    }
    this.checkFolder(projectPath, ctx.cwd)
    // Where it compacts by itself (#242): for the model it runs as (chosenModel, above).
    // Once the session reports the model it runs, that model alone: another model's window isn't its own.
    const modelsFor = (running?: string): string[] => (running ? [running] : [chosenModel && resolvedModel(info, chosenModel), chosenModel].filter((m): m is string => !!m))
    l.autoCompactFor = adapter.autoCompact ? (running) => adapter.autoCompact!(ctx, cmd, modelsFor(running)) : undefined
    state.autoCompact = l.autoCompactFor?.()
    // Its hooks, for its Hooks dialog (HI-982): never a reason for the launch to fail.
    try {
      l.hooks = adapter.launchHooks?.(ctx, cmd)
    } catch (e) {
      log.warn(`${userText(this.label(state))}: its hooks couldn't be listed`, e)
    }
    l.hookHistory = []
    l.hookBlock = undefined
    l.titleAttention = adapter.titleAttention?.(info.version, ctx) ?? undefined
    l.terminalTurnOf = adapter.terminalTurn ? () => adapter.terminalTurn!() : undefined
    l.terminalSaid = undefined
    l.terminalCarry = ''
    l.turnScreen = adapter.turnScreen?.(info.version) ?? undefined
    l.ledger = newLedger()
    // Whether its hooks reach Combwork (#1336), and what can say why they don't.
    l.hooksWatch = newHooksWatch(Date.now(), !!adapter.descriptor.capabilities.startHook, adapter.transcriptTurns ? (adapter.turnsJoin ?? 'id') : null)
    l.hooksOffIn = adapter.hooksOffIn ? () => adapter.hooksOffIn!(ctx) : undefined
    // Read once, in the background: the warning names it if its hooks don't come (HI-2777).
    if (adapter.hookCause) {
      void adapter.hookCause(ctx).then(
        (c) => (l.hookCause = c),
        () => (l.hookCause = null)
      )
    }
    l.newerThanTested = info.tested?.installed === 'newer'
    // What it was given: Combwork's guidance revision and each skill as delivered (the Agent API's project status shows
    // them). A skill not delivered as asked (kept old copy, failed copy) leaves it needing a restart.
    // Stored with the launch record, for any reader: said in the Default (as guidance.ts's "it was not delivered").
    const notGiven = Object.fromEntries(Object.entries(eff.skillProblems).map(([name, why]) => [name, { revision: null, problem: inDefaultDialect(() => say(SESSION.skillNotGiven, { why })), lasting: true as const }]))
    const record = launchRecord(eff.skillHashes, { ...delivered, ...notGiven })
    state.launchSignature = this.signature({ ...eff, skillHashes: record.settled })
    // The side its tools are offered for (HI-2664), to tell when a role or lane change needs it restarted.
    l.side = (eff.mcpServers[TOOLS_SERVER]?.env?.CW_SIDE as string | undefined) ?? null
    l.workflowHidden = workflowHiddenOf(eff.mcpServers[TOOLS_SERVER]?.env?.CW_WORKFLOW_HIDDEN as string | undefined)
    l.launchKey = launchKeyOf(eff)
    l.sideRestart = false
    // Its dialect chain (HI-2443): each layer's file, "model unknown", and the guidance revision as said in it, where a
    // dialect is set (a text overridden, or a file picked). Speaking the Default, its record is as before, but for
    // "model unknown" (decision Q4), said compactly: the status every agent reads carries it (replysize).
    const dialect = !l.dialect ? undefined : l.dialect.chain.hash || l.dialect.input.pick !== 'auto' ? launchDialectOf(l.dialect, chainGuidanceRevision()) : l.dialect.chain.modelUnknown ? { modelUnknown: true as const } : undefined
    state.launched = { guidance: GUIDANCE_REVISION, skills: record.skills, ...(record.problems ? { problems: record.problems } : {}), ...(dialect ? { dialect } : {}) }
    // Performance metrics: what Combwork gave this session, exact sizes. The session contract once (whichever way the
    // provider gets it); the skills that reached it, measured on their copies; the ones asked for that didn't.
    const given = Object.keys(record.skills)
    const parts = launchParts(ctx.guidance, workspace.isAssistantHome(projectPath) ? 'assistant' : 'agent', basename(projectPath), assistantText, ctx.notes)
    recordLaunch(metrics, workspace.isAssistantHome(projectPath) ? null : basename(projectPath), {
      provider: adapter.id,
      role: workspace.isAssistantHome(projectPath) ? 'assistant' : 'agent',
      workflow: l.workflow,
      // Split by its dialect chain where one overrides text (HI-2443), so Compare tells it from the Default's.
      ...(dialect && 'hash' in dialect && dialect.hash ? { dialect: dialect.hash } : {}),
      ...parts,
      skills: given.length,
      skillCatalogBytes: deliveredSizes.catalog,
      skillBytes: deliveredSizes.bytes,
      skillsNotDelivered: Object.keys(eff.skillHashes).length - given.length,
      skillsUnmeasured: deliveredSizes.unmeasured
    })
    l.defaultModel = !eff.model
    l.defaultEffort = eff.effort ? undefined : { model: eff.model }

    // The footer is read from the rendered screen: a CLI may redraw only the characters that changed. So is a mode
    // menu, whose entries Combwork picks by what they say (#396).
    const key = this.key(projectPath, agent.id)
    const size = startSize(key)
    const caps = l.adapter.descriptor.capabilities
    const screen = l.adapter.footerMode || l.adapter.modeMenuKeys || l.turnScreen || caps.bracketedPaste || caps.enterOnceDrawn ? new TerminalScreen(size.cols, size.rows) : null
    l.screen = screen
    // The developer console (#636): how it was started (launchEvent: never its arguments).
    devConsole.capture([sessionSourceId(projectPath, agent.id)], () => launchEvent({ provider: adapter.id, name: adapter.descriptor.name, file: cmd.file, args: cmd.args, cwd, version: info.version, state, resumed: !!l.resumed }))
    flightRecorder.launched(l.state, () => this.label(l.state), info.version)
    spawnPty(key, {
      ...size,
      file: cmd.file,
      args: ptyArgs(cmd),
      cwd,
      env: cmd.env ?? ctx.env,
      // After a worktree's setup command, its output stays at the top of the terminal.
      continueBuffer: true,
      onData: (data) => {
        if (l.switchTail !== undefined) l.switchTail = (l.switchTail + data.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ' ').replace(/\x1b\][^\x07]*\x07/g, ' ')).replace(/\s+/g, ' ').slice(-2000)
        // The CLI refusing or failing a compaction Combwork asked for sends no hook ("Not enough messages to compact.").
        this.live.get(id)?.compacting?.terminal(data)
        screen?.write(data, () => {
          this.readFooterMode(l, screen)
          this.screenDrawn(id, l)
          this.idleScreenDrawn(id, l)
          this.inputBlockedDrawn(id, l)
        })
        this.watchTitle(id, data)
        this.watchTerminalTurn(id, data)
        this.watchReadyOutput(id, data)
        this.recognisePrompt(l, data)
      },
      onResize: (cols, rows) => screen?.resize(cols, rows),
      // Everything it starts is tracked, to offer to end what it leaves running (#507): it starts once it is.
      ...(tracked
        ? {
            track: (pid: number, cancelled: AbortSignal) => {
              state.pid = pid
              return trackLaunch({ runId: state.runId, projectPath, agentId: agent.id, agentName: agent.name, gated: true }, pid, cancelled).then((r) => this.launchWord(r))
            }
          }
        : {}),
      onExit: (code, output) => {
        screen?.dispose()
        // A server connection's key stays masked until what its exit left (its last output) is handled (HI-1772).
        // Its server markers go with the run (HI-1829): those its record has, at once; the rest are held from now (before
        // onExit takes it out of live) until their record says so, or kept if it can't.
        const ending = this.serverRunEnding(l)
        void Promise.resolve(this.onExit(projectPath, agent.id, state.runId, code, output)).finally(() => this.serverRunEnded(projectPath, ending))
      }
    })
    // Its process runs now (spawnPty returned, not thrown): its slot's writer is the run's processes' to settle (#1434).
    this.writerSpawned(state.runId)
    // A task on its command line is its first prompt (#1336: a hook should follow it), though it is still starting: no
    // turn of its own runs yet.
    if (l.initialPrompt) this.notePrompt(l, true)
    l.initialPrompt = undefined
    l.startAllowed = undefined
    // After each look at the transcript, whether its CLI waits to retry (HI-1972), then the silence check: what the CLI
    // recorded (a turn's end) comes first (#648); then whether its hooks are arriving (#1336).
    l.backupTimer = setInterval(() => {
      void this.backup(projectPath, agent.id)
        .catch((e) => log.warn('transcript look failed', e))
        .then(() => this.checkRetry(projectPath, agent.id))
        .then(() => this.checkRetryNotice(projectPath, agent.id))
        .then(() => this.checkSilence(projectPath, agent.id))
        .then(() => this.checkHooks(projectPath, agent.id))
        .catch((e) => log.warn('hooks check failed', e))
    }, 5000)
    // The process runs now: failing to record it (a full disk) must not leave it untracked.
    if (state.sessionId) await this.recordSession(projectPath, agent, l).catch((e) => log.warn(`${userText(this.label(state))}: could not record session ${state.sessionId}`, e))
    if (resume && state.sessionId && assistantText?.modeId) this.onAssistantResumed(projectPath, state.runId, state.sessionId, assistantText.modeId)

    // Launched as active: starting a session implies working on the project.
    if (!workspace.isAssistantHome(projectPath) && !workspaceOf(projectPath).activeNames().includes(basename(projectPath))) workspace.setActive(projectPath, true)
    this.emitState(state)
    workspaceOf(projectPath).scheduleRefresh()
  }

  /**
   * Whether `l` is still its agent's launch (#650): one stopped or started again while a step of its own waited gets
   * nothing more of that step that is the current launch's (its state shown, its locks, the agent's session to resume).
   */
  private owns(l: LiveSession): boolean {
    return this.live.get(liveId(l.state.projectPath, l.state.agentId)) === l
  }

  /**
   * Records the running session in sessions.json and as the agent's session to resume. The session's own record is kept
   * whatever happens to the launch; the agent's session to resume and its cards only while it is still the agent's
   * launch.
   */
  private async recordSession(projectPath: string, agent: Pick<AgentDef, 'id' | 'name'>, l: LiveSession): Promise<void> {
    const { state } = l
    const sessionId = state.sessionId
    // On a server connection (HI-1772), this conversation's usage leaves the CLI's cost reports out from now on.
    if (state.launchedConnection?.server && sessionId) {
      ;(l.serverSids ??= new Set()).add(sessionId)
      ;(l.serverRecorded ??= new Set()).add(sessionId)
    }
    // A new conversation began with this launch, or (one the CLI switched to) now: its record says so, and the footer
    // names it by the record's time, as the Sessions tab does (#630: a minute apart when recorded after a minute's turn).
    state.sessionCreatedAt ??= state.startedAt
    // Attachments pasted before the provider named the session wait in the launch's folder: move them to the session's,
    // only between folders of the host's own (never through a link) and never over a file there.
    await this.moveEarlyAttachments(projectPath, `run-${state.runId}`, sessionId).catch((e) => log.warn("Could not move the launch's attachments to its session's", e))
    const rec = await workspace.upsertSession(projectPath, {
      id: sessionId,
      agent: state.provider,
      name: l.name,
      // Launched with the names agents see now (HI-2463): only a launch sets it, so a conversation from before never
      // passes for one of now by being read, listed or failing to start.
      names: SESSION_NAMES,
      ...(state.titleAtRename !== undefined ? { titleAtRename: state.titleAtRename } : {}),
      lastActiveAt: new Date().toISOString(),
      // The agent running it now; a session can move between agents that share a folder. Its name too, for once it's gone.
      agentId: agent.id,
      agentName: agent.name,
      // The Assistant's mode its conversation was last given (a resumed one's is unknown until it is told: assistantMode.ts).
      ...(l.mode ? { mode: l.mode } : {}),
      // Combwork's own instructions were given it (#1433): kept, never cleared, so later resumes refresh its prompt.
      ...(l.promptAdded ? { promptAdded: true as const } : {}),
      // Providers that choose their own ids file transcripts by date, not folder: remember where.
      ...(l.transcriptPath && !l.adapter.descriptor.capabilities.fixedSessionId ? { transcriptPath: l.transcriptPath } : {}),
      // Where it ran (#1434: always, the project folder too): a conversation resumes only there.
      cwd: state.cwd,
      ...(legacyWorktree(agent) ? { branch: legacyWorktree(agent)!.branch } : {}),
      ...(l.handedOverFrom ? { handedOverFrom: l.handedOverFrom } : {}),
      // The connection its latest run launched on (HI-1755), id and name as then: what it actually ran on.
      ...(state.launchedConnection ? { connection: { id: state.launchedConnection.id, name: state.launchedConnection.name } } : {}),
      // The GitHub hosts its latest run signed in on (HI-2779), as resolved at its launch.
      ...(state.signInHost ? { signInHost: state.signInHost } : {}),
      // On a server connection (HI-1772), kept once set: its CLI's cost reports are never counted for it.
      ...(state.launchedConnection?.server ? { serverRan: true as const } : {}),
      // Free (HI-1772, Darren 27 Oct) only while every run of it was on a server on this PC: kept once set, each.
      ...(state.launchedConnection?.server?.local ? { serverLocal: true as const } : { notLocal: true as const })
    }, { createdAt: state.sessionCreatedAt })
    // Its record says it ran on a server (HI-1772, now or in an earlier run): its reads leave the CLI's cost reports out
    // while it runs; once it exits, its record says so (serverSaved: only once that write succeeded).
    if (rec.serverRan && sessionId) {
      ;(l.serverSids ??= new Set()).add(sessionId)
      ;(l.serverSaved ??= new Set()).add(sessionId)
      serverMarks.saved(projectPath, sessionId)
    }
    // A record of this host saved: those whose record couldn't be saved before are tried again (HI-1829).
    void this.saveServerMarks(projectPath)
    // Free as the conversation's record says (this run's flag merged with earlier runs'), never by this run alone.
    l.costFree = !!rec.serverLocal && !rec.notLocal
    // The footer follows at once (and liveCost keeps it so): a conversation switched to that ran elsewhere isn't free.
    if (!!state.costFree !== l.costFree) {
      state.costFree = l.costFree ? true : undefined
      this.emitState(state)
    }
    // The conversation it was meant for has it: one the CLI moves to later (/clear, /new) wasn't handed over.
    l.handedOverFrom = undefined
    // Started in a slot: bound to the lease it started under (a conversation the CLI moves to later, too).
    if (l.lease && rec.lease !== l.lease) await bindSession(projectPath, sessionId, l.lease)
    state.sessionCreatedAt = rec.createdAt
    if (!this.owns(l)) return
    // The agent's session to resume (and no other agent's any more), decided under the config's lock as it is written: a
    // launch started again while this write waited for the lock keeps its own (#650).
    await workspace
      .mutateProjectConfig(projectPath, (cfg) => {
        const agents = projectAgents(cfg)
        if (!this.owns(l) || !agents.some((a) => a.id === agent.id)) return {}
        return { agents: agents.map((a) => (a.id === agent.id ? { ...a, lastSessionId: sessionId } : a.lastSessionId === sessionId ? { ...a, lastSessionId: undefined } : a)) }
      })
      .catch(() => undefined)
    // The card it was started on (or already has in Doing), only while it is the agent's launch as the record is written.
    if (!this.owns(l)) return
    await recordCards(workspaceOf(projectPath), projectPath, agent.id, sessionId, () => this.owns(l)).catch((e) => log.warn(`Could not record the cards of session ${sessionId}`, e))
  }

  /**
   * Stops one agent's session, or every agent of the project when agentId is omitted. `cause`: who asked, when the
   * caller knows (HI-1881); left out, the pane says just "stopped".
   */
  stop(projectPath: string, agentId?: string, cause?: StopCause): void {
    const agents = agentId ? [agentId] : this.projectStates(projectPath).map((s) => s.agentId)
    for (const a of agents) {
      // Someone's Stop (HI-2815): what Combwork owed it since (a lane's new conversation) doesn't start it again.
      if (cause && STOPPED_ON_PURPOSE.has(cause)) this.stoppedOnPurpose.set(liveId(projectPath, a), Date.now())
      // A switch of connection waiting for it ends with it (HI-1755): a stop is the user's.
      this.switches.get(liveId(projectPath, a))?.cancel('stopped')
      const l = this.live.get(liveId(projectPath, a))
      if (l) {
        l.stopRequested = true
        if (cause) l.stopCause = cause
        this.endProcess(l)
      } else killPty(this.key(projectPath, a))
    }
    // Starts still being prepared (no process yet) give up at their next check.
    for (const [k, p] of this.starting) if (p.projectPath.toLowerCase() === projectPath.toLowerCase() && (!agentId || k === liveId(projectPath, agentId))) p.cancelled = true
  }

  /**
   * Whether an agent's run `runId` is in a turn as its hooks tell it (HI-1706): the turn ledger's turn still running. A
   * Stop Combwork answered with a continuation (the inbox drain) leaves it running, whatever the status said meanwhile.
   */
  turnOpen(projectPath: string, agentId: string, runId: string): boolean {
    const l = this.live.get(liveId(projectPath, agentId))
    return !!l && l.state.runId === runId && l.ledger?.active?.state === 'running'
  }

  /**
   * Why nothing may be typed into an agent's prompt now (HI-1706's quit), or null: Combwork typing into it, a line of Combwork's
   * not taken yet (#430: or confirming, or the user's draft over it), the user typing within the pause, or what the user
   * typed last not sent (a draft of theirs in its prompt).
   */
  inputHeld(projectPath: string, agentId: string): string | null {
    const l = this.live.get(liveId(projectPath, agentId))
    if (!l) return null
    const key = this.key(projectPath, agentId)
    if (this.delivering.has(key)) return 'Combwork is typing into it' // i18n-ignore: a reason for the log
    if (this.lineBlocked(l)) return "a line Combwork typed isn't taken yet" // i18n-ignore: a reason for the log
    if (this.userMayBeTyping(projectPath, agentId)) return 'the user is typing there' // i18n-ignore: a reason for the log
    const u = this.userInput.get(key)
    if (u && !u.enter) return "the user's draft is in its prompt" // i18n-ignore: a reason for the log
    return null
  }

  /**
   * Ends an agent's run `runId` as a person would, at its lane's end (HI-1706): its CLI's quitLine typed, then Enter (or
   * its exitKeys), and killed if that run still runs after the grace. `fenced` is the caller's own check (its lease, its
   * slot's writer), asked with the run's before each key and before the kill. `ready` (not forced): why its turn isn't
   * over after all (the caller's own states), asked with the rest at each key and before Enter, so a turn that begins
   * meanwhile stops it. 'held': its input is held (inputHeld), or the user typed, a prompt was taken or `ready` said no
   * while it typed (what it typed cleared again unless the user typed since), the caller looks again; 'gone': that run
   * or the fence is; 'sent': typed (or already ending). `force` (the caller's deadline): `ready` isn't asked, and a
   * prompt that can't be typed into is killed rather than typed over; input arriving while it types still stops it.
   */
  async quit(projectPath: string, agentId: string, runId: string, o: { fenced: () => boolean; why: string; force?: boolean; ready?: () => string | null; cause?: StopCause }): Promise<'sent' | 'held' | 'gone'> {
    const { fenced, why, force = false } = o
    const id = liveId(projectPath, agentId)
    const key = this.key(projectPath, agentId)
    const l = this.live.get(id)
    const same = (): boolean => !!l && this.live.get(id) === l && l.state.runId === runId && fenced()
    if (!l || !same()) return 'gone'
    if (l.ending) return 'sent'
    const label = userText(this.label(l.state))
    const held = this.inputHeld(projectPath, agentId) ?? (force ? null : (o.ready?.() ?? null))
    const line = l.adapter.quitLine
    const keys = l.adapter.exitKeys
    if (held || (!line && !keys)) {
      if (held && !force) return 'held'
      log.info(`${label}: killed (${why}${held ? `; ${held}` : ', its CLI has no exit command'})`)
      l.stopRequested = true
      // Who asked, as its caller says (HI-1881: a lane's end says lane; a switch of connection, nothing).
      l.stopCause = o.cause
      l.ending = true
      killPty(key)
      return 'sent'
    }
    // From here, whatever the typing pause says: any input of the user's, any prompt its CLI takes (a turn beginning),
    // or (not forced) its turn not over after all stops it before the next key and before Enter.
    const since = Date.now()
    const prompts = l.prompts ?? 0
    const guard = (): void => {
      if (!same()) throw new Error('its run or lease is gone') // i18n-ignore: for the log
      if (this.userTypedAt(projectPath, agentId) >= since) throw new Error('the user typed there') // i18n-ignore: for the log
      if ((l.prompts ?? 0) !== prompts) throw new Error('its CLI took a prompt') // i18n-ignore: for the log
      const not = force ? null : (o.ready?.() ?? null)
      if (not) throw new Error(not)
    }
    // Ending from here: its exit is a stop asked for (not a crash), and Stop meanwhile kills it at once (endProcess).
    l.stopRequested = true
    l.stopCause = o.cause
    l.ending = true
    try {
      if (line) {
        await this.sendPrompt(projectPath, agentId, line.line, guard)
      } else {
        for (const k of keys!.keys) {
          guard()
          writePty(key, k)
          await new Promise((r) => setTimeout(r, keys!.gapMs))
        }
      }
    } catch (e) {
      // Nothing more is typed; sendPrompt cleared what it typed unless the user typed since. Ending no more.
      if (this.live.get(id) === l) {
        l.stopRequested = false
        l.ending = false
        // Not stopping after all: a later exit is its own (HR5's HI-1881 round 1), not this quit's cause.
        l.stopCause = undefined
      }
      log.info(`${label}: its exit command wasn't typed (${why}): ${(e as Error).message}`)
      return same() ? 'held' : 'gone'
    }
    const graceMs = line?.graceMs ?? keys!.graceMs
    log.info(`${label}: ${line ? `typed ${line.line}` : 'its exit keys typed'} (${why}); killed if still running in ${Math.round(graceMs / 1000)} s`)
    setTimeout(() => {
      if (!same()) return
      log.info(`${label}: still running ${Math.round(graceMs / 1000)} s after its exit command (${why}): killed`)
      killPty(key)
    }, graceMs).unref?.()
    return 'sent'
  }

  /**
   * Ends a session's CLI: as a person ends it first, where the provider says how (exitKeys), so it writes what it
   * owes as it exits (Copilot's token totals, #465), and killed if it is still running after a moment. Killed at once
   * while its worktree setup runs, or when it is stopped again while ending. Keys and the kill reach only this
   * session's terminal: a restart's new one is left alone. Where the adapter says what its screen shows once the exit
   * is armed, the keys go on conditions (HI-2272, exitKeys.ts): a turn under way cancelled and its end waited for, the
   * key that exits typed once the hint shows; the kill only for one that hangs.
   */
  private endProcess(l: LiveSession): void {
    const key = this.key(l.state.projectPath, l.state.agentId)
    const exit = l.adapter.exitKeys
    if (!exit || l.state.settingUp || l.ending) return killPty(key)
    l.ending = true
    const id = liveId(l.state.projectPath, l.state.agentId)
    const same = (): boolean => this.live.get(id) === l
    setTimeout(() => same() && killPty(key), exit.graceMs)
    const armed = exit.armed
    if (!armed) return void exit.keys.forEach((k, i) => setTimeout(() => same() && writePty(key, k), i * exit.gapMs))
    const io: ExitKeysIO = {
      alive: () => same() && hasPty(key),
      inTurn: () => l.ledger?.active?.state === 'running' || EXIT_IN_TURN.has(l.state.status),
      armed: () => armed.test(l.screen?.text() ?? ''),
      // Checked at the write too, as the fixed beat's keys are: never into a restart's terminal.
      press: () => void (same() && writePty(key, exit.keys[0])),
      wait: (ms) => new Promise((r) => setTimeout(r, ms))
    }
    driveExitKeys(io, exit.gapMs).catch((e) => log.warn(`${userText(this.label(l.state))}: its exit keys stopped: ${(e as Error).message}`))
  }

  /** Stops every running agent of one provider (e.g. when the provider is turned off). */
  stopProvider(provider: ProviderId): void {
    for (const l of [...this.live.values()]) if (l.state.provider === provider) this.stop(l.state.projectPath, l.state.agentId)
  }

  stopAll(): void {
    for (const l of this.live.values()) killPty(this.key(l.state.projectPath, l.state.agentId))
  }

  /**
   * Stops every session and waits until each has been through onExit (final transcript backup,
   * session list update), or until the timeout, so quitting never loses the last messages or hangs.
   */
  async stopAllAndWait(timeoutMs = 3000): Promise<void> {
    this.shuttingDown = true
    return this.stopWhereAndWait(() => true, timeoutMs)
  }

  /**
   * Stops the sessions matching `which` (e.g. one window's workspace) and waits for them as stopAllAndWait
   * does. Starts in progress for matching projects are cancelled and waited for too.
   */
  async stopWhereAndWait(which: (s: { projectPath: string }) => boolean, timeoutMs = 3000, cause?: StopCause): Promise<void> {
    const pending = [...this.starting.values()].filter((p) => which(p))
    for (const p of pending) p.cancelled = true
    const chosen = [...this.live.entries()].filter(([, l]) => which(l.state))
    const waits = chosen.map(([k]) => k).map(
      (k) =>
        new Promise<void>((res) => {
          const previous = this.exitWaiters.get(k)
          this.exitWaiters.set(k, () => {
            previous?.()
            res()
          })
        })
    )
    for (const [, l] of chosen) {
      l.stopRequested = true
      // Who asked, as its caller says (HI-1881: a workspace closing says closed); Combwork quitting says so itself (endReason).
      if (cause) l.stopCause ??= cause
      this.endProcess(l)
    }
    const waitMs = stopWaitMs(timeoutMs, chosen.map(([, l]) => l.adapter.exitKeys?.graceMs))
    await Promise.race([Promise.all([...waits, ...pending.map((p) => p.done)]), new Promise((r) => setTimeout(r, waitMs))])
  }

  /**
   * Compacts a session's conversation now (the CLI's /compact), optionally with focus instructions.
   * Only while the agent is idle: while it works the command would queue or interrupt, and while it
   * waits on a prompt the text would land in that prompt. Ctrl+U first clears anything half-typed.
   */
  async compact(projectPath: string, focus?: string, agentId?: string): Promise<void> {
    projectPath = workspace.assertSessionHost(projectPath)
    agentId ||= await this.soleAgent(projectPath)
    const id = liveId(projectPath, agentId)
    const key = this.key(projectPath, agentId)
    const check = (l: LiveSession | undefined): LiveSession => {
      if (!l || l.state.settingUp) throw combworkError(M.noSession, undefined, { kind: 'conflict' })
      if (l.compacting) throw combworkError(msg({ id: 'session.compact.already', defaultMessage: 'This session is already compacting.', description: 'Compact is refused: the conversation is being compacted already.' }), undefined, { kind: 'conflict' })
      if (this.delivering.has(key)) throw combworkError(M.typingBusy, undefined, { kind: 'conflict' })
      // Watching its cards (its turn has ended) may compact: the watch stays.
      if (l.state.status !== 'ready' && l.state.status !== 'finished' && l.state.status !== 'watching') {
        throw l.state.status === 'waiting'
          ? combworkError(msg({ id: 'session.compact.waiting', defaultMessage: 'The agent is waiting for your answer. Compact after it has finished.', description: 'Compact is refused: the agent waits for the user.' }), undefined, { kind: 'conflict' })
          : combworkError(msg({ id: 'session.compact.busy', defaultMessage: 'The agent is busy. Compact once it has finished.', description: 'Compact is refused: the agent is working.' }), undefined, { kind: 'conflict' })
      }
      return l
    }
    const l = check(this.live.get(id))
    const src = await this.liveTranscript(l)
    const before = src ? ((await this.usageFor(l.state.projectPath, src, l.state.sessionId, l.state.provider, this.costPolicy(l)))?.compactions.length ?? 0) : 0
    // Again: a second Compact or a prompt may have come meanwhile (one at a time, only while idle).
    if (this.live.get(id) !== l) throw combworkError(M.noSession, undefined, { kind: 'conflict' })
    check(l)
    // Reserved while Combwork types the command (a long focus takes a while), so nothing else is typed or compacted
    // meanwhile; Compaction's limits run from its submission.
    const c: Compaction = new Compaction(before, l.adapter.compactFailure, () => this.compactionDone(id, l, c))
    l.compacting = c
    this.fact(l.state, { maintenance: 'compacting' })
    l.state.status = 'working'
    setStatus(l.state, COMPACTING_TEXT)
    this.delivering.add(key)
    this.fact(l.state, { composer: 'held' })
    this.emitState(l.state)
    const runId = l.state.runId
    // The agent stopped or restarted meanwhile: the rest mustn't reach the new process.
    const same = (): boolean => this.live.get(id) === l && l.state.runId === runId && l.compacting === c
    // The user typing in its pane meanwhile (HI-1979, HR6's round 1): nothing more is pressed or typed, what they typed
    // theirs, and Compact isn't sent.
    const since = Date.now()
    const stillSame = (): void => {
      if (!same()) throw combworkError(msg({ id: 'session.compact.stopped', defaultMessage: 'The agent stopped before Compact was sent.', description: 'Compact failed: the agent stopped or restarted while Combwork typed the command.' }), undefined, { kind: 'conflict' })
      if (this.userTypedAt(projectPath, agentId) >= since) throw combworkError(msg({ id: 'session.compact.userTyped', defaultMessage: "You typed in the agent's terminal while Combwork was sending Compact, so it wasn't sent: what you typed stays.", description: "Compact failed: the user typed in the agent's terminal while Combwork was clearing its input or typing the command, so Combwork stopped." }), undefined, { kind: 'conflict' })
    }
    const pause = async (ms: number): Promise<void> => {
      await new Promise((r) => setTimeout(r, ms))
      stillSame()
    }
    try {
      // Settings → Advanced can leave the CLI's draft in front of it (#1286); cleared as a prompt's is (HI-1979).
      if (advanced.get<boolean>(PROMPT_CLEAR_DRAFT)) await this.clearInput(l, key, stillSame)
      // On one line, without control characters (HI-1920): typed key by key, one would press a key.
      const text = l.adapter.descriptor.capabilities.compactFocus ? promptInput((focus ?? '').replace(/\s+/g, ' ').trim(), false, false) : ''
      // Written in one go, a long line counts as a paste, and pasted input is sent as a message even when
      // it starts with "/compact". So type the command on its own, then the focus in small pieces.
      stillSame()
      writePty(key, '/compact')
      await pause(150)
      if (text) await typeInto(key, ` ${text}`, () => (stillSame(), true))
      await pause(150)
      writePty(key, '\r')
      c.submitted()
    } catch (e) {
      c.end()
      this.compactionDone(id, l, c)
      throw e
    } finally {
      this.delivering.delete(key)
      this.noteComposer(this.live.get(id), key)
    }
  }

  /** A compaction Combwork watches is over with no hook saying so (Compaction's `over`): an agent still showing it is idle again. */
  private compactionDone(id: string, l: LiveSession, c: Compaction): void {
    if (l.compacting !== c) return
    l.compacting = undefined
    // A session that has exited stays stopped.
    if (this.live.get(id) !== l) return
    const ended = this.fact(l.state, { maintenance: null })
    if (applyStep(l.state, compactionOver(l.state, this.idleStatus(l, 'ready'))) || ended) this.emitState(l.state)
  }

  /**
   * A compaction the CLI began by itself while the agent was idle (#1115): Claude Code precomputes one in the background,
   * idle too, sending PreCompact at once and PostCompact only once it uses it, so it may never say this one is over.
   * Watched as Combwork's own from now (begun): over at PostCompact or a prompt, a compaction recorded in the transcript
   * since its PreCompact (the CLI writes it once the model has summarised, well after the hook), or LIMIT_MS.
   */
  private watchAutoCompaction(id: string, l: LiveSession): void {
    const c: Compaction = new Compaction({ since: Date.now() }, null, () => this.compactionDone(id, l, c))
    l.compacting = c
    c.begin()
  }

  /**
   * For CLIs whose terminal title says when a person must act (Codex): whether it says so changes the status
   * (titleStep). Before the session has started, its question at start is the startup's to show.
   */
  private watchTitle(id: string, data: string): void {
    const l = this.live.get(id)
    if (!l?.titleAttention) return
    const { title, carry } = lastTitle(l.titleCarry ?? '', data)
    l.titleCarry = carry
    if (title === null) return
    const asks = l.titleAttention(title)
    if (asks === !!l.titleRead) return
    l.titleRead = asks
    // i18n-ignore: the developer console's event data, recorded like a log, stays English (#1104)
    devConsole.capture([sessionSourceId(l.state.projectPath, l.state.agentId)], () => ({ kind: 'terminal', name: 'title', provider: l.state.provider, raw: { title }, made: { asksYou: asks }, summary: `terminal title: ${asks ? 'asks you' : 'asks nobody'}` }))
    // After the hooks that came before it: they are answered at once and handled one at a time, so a slow one (the
    // first records the session) holds back a prompt and an ask that came before the title (#254).
    const runId = l.state.runId
    void this.inHookOrder(runId, () => {
      const now = this.live.get(id)
      if (!now || now.state.runId !== runId || asks === !!now.titleAsks) return
      const step = now.state.status === 'starting' || now.askedAtStart ? null : titleStep(asks, this.statusInput(now))
      now.titleAsks = asks
      if (step) this.carryOut(id, now, step, 'title')
    }).catch((e) => log.warn('title: could not apply it', e))
  }

  /**
   * For CLIs that write their turn's state to the terminal (Copilot's OSC 7501, HI-2802): what it last said is kept all
   * along (a turn may end before its hooks are found missing), and shown only while they are (terminalTurnShown).
   */
  private watchTerminalTurn(id: string, data: string): void {
    const l = this.live.get(id)
    if (!l?.terminalTurnOf || (!l.terminalCarry && !data.includes('\x1b'))) return
    const re = l.terminalTurnOf()
    if (!re) return
    const { turn, carry } = lastTerminalTurn(re, l.terminalCarry ?? '', data)
    l.terminalCarry = carry
    if (!turn || turn === l.terminalSaid) return
    l.terminalSaid = turn
    if (!l.state.hooksMissing) return
    // i18n-ignore: the developer console's event data, recorded like a log, stays English (#1104)
    devConsole.capture([sessionSourceId(l.state.projectPath, l.state.agentId)], () => ({ kind: 'terminal', name: 'turn state', provider: l.state.provider, made: { terminal: turn }, summary: `terminal: its turn ${turn} (its hooks missing)` }))
    this.terminalTurnShown(l)
  }

  /** While its hooks are missing (#1336), what its terminal last said of its turn (HI-2802) is its status's last resort. */
  private terminalTurnShown(l: LiveSession): void {
    const h = l.state.hooksMissing
    if (!h || !l.terminalSaid || h.terminal === l.terminalSaid) return
    l.state.hooksMissing = { ...h, terminal: l.terminalSaid }
    this.emitState(l.state)
  }

  /** For CLIs whose first hook waits for the first prompt: the prompt showing in the terminal means ready. */
  private watchReadyOutput(id: string, data: string): void {
    const l = this.live.get(id)
    const s = l && { status: l.state.status, askedAtStart: !!l.askedAtStart, settled: (l.prompts ?? 0) > 0 || !!l.startupDone }
    if (!l || !s || !startupWatched(s, l.adapter)) return
    l.modeTail = (l.modeTail + data.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ' ')).slice(-600)
    const seen = startupScreen(s, l.modeTail.replace(/\s+/g, ' '), l.adapter)
    if (seen && seen !== 'ready') {
      const asked = seen.asked
      // i18n-ignore: the developer console's event data, recorded like a log, stays English (#1104)
      devConsole.capture([sessionSourceId(l.state.projectPath, l.state.agentId)], () => ({ kind: 'terminal', name: 'startup question', provider: l.state.provider, raw: { screen: asked }, made: { status: 'waiting', trust: asked.includes('trust') }, safe: { made: { status: true } }, summary: 'terminal: asks something before it starts; waiting' }))
      if (l.state.status !== 'starting') log.info(`${userText(this.label(l.state))}: asks something before it starts, after its prompt showed (it was ready): waiting`)
      l.askedAtStart = true
      l.modeTail = ''
      this.fact(l.state, { attention: 'waiting' })
      l.state.status = 'waiting'
      l.state.unseen = true
      const asks = asked.includes('trust')
        ? msg({ id: 'session.status.asksTrust', defaultMessage: 'Asks whether to trust this folder', description: "An agent's status: its CLI asks, before it starts, whether to trust the project's folder." })
        : msg({ id: 'session.status.asksAtStart', defaultMessage: 'Asks something before it starts', description: "An agent's status: its CLI asks the user something before it starts." })
      setStatus(l.state, asks)
      this.notify(l.state.projectPath, withValues(M.needsInput, { agent: this.label(l.state) }), asks, 'waiting', undefined, l.state.agentId)
      this.emitState(l.state)
    } else if (seen === 'ready') {
      // i18n-ignore: the developer console's event data, recorded like a log, stays English (#1104)
      devConsole.capture([sessionSourceId(l.state.projectPath, l.state.agentId)], () => ({ kind: 'terminal', name: 'ready', provider: l.state.provider, raw: { screen: l.modeTail.replace(/\s+/g, ' ').slice(-200) }, made: { status: 'ready' }, safe: { made: { status: true } }, summary: 'terminal: its prompt shows; ready' }))
      this.startupAnswered(l)
      this.fact(l.state, { lifecycle: 'running' })
      l.state.status = 'ready'
      this.emitState(l.state)
    }
  }

  /**
   * The developer console's record that the CLI's prompt was recognised on its screen (#638), once a launch and whatever
   * the status: a CLI whose prompt changed never gets one (the contract tests' pattern check).
   */
  private recognisePrompt(l: LiveSession, data: string): void {
    if (!l.recognition.output(data)) return
    // i18n-ignore: the developer console's event data, recorded like a log, stays English (#1104)
    devConsole.capture([sessionSourceId(l.state.projectPath, l.state.agentId)], () => ({ kind: 'terminal', name: 'prompt shown', provider: l.state.provider, made: { recognised: 'prompt' }, safe: { made: { recognised: true } }, summary: 'terminal: its prompt recognised' }))
  }

  /** The question before the start was answered: the agent is starting again. */
  private startupAnswered(l: LiveSession): void {
    if (!l.askedAtStart) return
    l.askedAtStart = false
    l.startupDone = true
    setStatus(l.state, null)
    this.fact(l.state, { attention: null })
  }

  /**
   * Sets facts of an agent's runtime where Combwork learns them (LiveSessionState.runtime, #648), never from its status word.
   * True when one changed (the state needs sending; the caller sends it).
   */
  private fact(st: LiveSessionState, patch: Partial<RuntimeFacts>): boolean {
    const f = (st.runtime ??= { lifecycle: 'starting', maintenance: null, attention: null, composer: 'free' })
    let changed = false
    for (const k of Object.keys(patch) as (keyof RuntimeFacts)[]) {
      if (patch[k] === undefined || f[k] === patch[k]) continue
      Object.assign(f, { [k]: patch[k] })
      changed = true
    }
    return changed
  }

  /** Whether Combwork holds an agent's input (RuntimeFacts.composer): typing into it, or a line it typed not taken yet. */
  private composerOf(l: LiveSession, key = this.key(l.state.projectPath, l.state.agentId)): RuntimeFacts['composer'] {
    return this.delivering.has(key) || this.lineBlocked(l) ? 'held' : 'free'
  }

  /**
   * The agent's input may be held or freed now (Combwork typing, confirming, a line taken or given up): sent when it changed.
   * Only a report: it never stops what Combwork is typing (`key`: the terminal's, when the caller has it).
   */
  private noteComposer(l: LiveSession | undefined, key?: string): void {
    if (!l) return
    try {
      if (this.fact(l.state, { composer: this.composerOf(l, key) })) this.emitState(l.state)
    } catch (e) {
      log.warn('could not report whether Combwork holds an input', e)
    }
  }

  /** Reads the mode from the CLI's footer on its screen as it redraws, so a mode change in the terminal shows in Combwork at once. */
  private readFooterMode(l: LiveSession, screen: TerminalScreen): void {
    if (this.live.get(liveId(l.state.projectPath, l.state.agentId)) !== l || !l.adapter.footerMode) return
    const text = screen.text()
    // The first footer recognised this launch, whatever the mode was before (#638's contract marker).
    const first = l.recognition.footerOf(text, l.launchMode)
    // i18n-ignore: the developer console's event data, recorded like a log, stays English (#1104)
    if (first) devConsole.capture([sessionSourceId(l.state.projectPath, l.state.agentId)], () => ({ kind: 'terminal', name: 'footer seen', provider: l.state.provider, raw: { footer: first }, made: { recognised: 'footer', permissionMode: first }, safe: { raw: { footer: true }, made: { recognised: true, permissionMode: true } }, summary: `terminal footer recognised: mode ${first}` }))
    const mode = l.adapter.footerMode(text, l.launchMode)
    if (mode && (mode !== l.state.permissionMode || mode !== l.state.modeObserved)) {
      // i18n-ignore: the developer console's event data, recorded like a log, stays English (#1104)
      devConsole.capture([sessionSourceId(l.state.projectPath, l.state.agentId)], () => ({ kind: 'terminal', name: 'footer mode', provider: l.state.provider, raw: { footer: mode }, made: { permissionMode: mode, was: l.state.permissionMode }, safe: { raw: { footer: true }, made: { permissionMode: true, was: true } }, summary: `terminal footer: mode ${mode}` }))
      this.observeMode(l, mode)
      this.emitState(l.state)
    }
  }

  /**
   * The mode the CLI showed (its footer, a hook, its transcript): the session's mode from now, except in one launched in
   * the CLI's own setting (#1284), which keeps saying so: only recorded as seen.
   */
  private observeMode(l: LiveSession, mode: PermissionMode): void {
    l.state.modeObserved = mode
    if (!isCliOwnMode(l.launchMode)) l.state.permissionMode = mode
  }

  /**
   * Switches a running agent's permission mode the way you would by hand (Claude Code: Shift+Tab in its
   * terminal until the footer shows the mode). Not while it is asking a question (the keys could change
   * the answer). Modes the provider can't switch to live need a restart (restartInMode).
   */
  async setPermissionMode(projectPath: string, agentId: string, mode: PermissionMode): Promise<{ ok: boolean; restart?: boolean; message?: string }> {
    projectPath = workspace.assertSessionHost(projectPath)
    const id = liveId(projectPath, agentId)
    const l = this.live.get(id)
    if (!l || l.state.settingUp) throw combworkError(M.noSession, undefined, { kind: 'conflict' })
    const st = l.state
    const p = st.provider
    const name = l.adapter.descriptor.name
    if (st.permissionMode === mode) return { ok: true }
    if (workspace.isAssistantHome(projectPath) && isCliOwnMode(mode)) throw combworkError(M.assistantCliOwn, undefined, { kind: 'conflict' })
    if (!modeAllowed(p, mode, config.settings)) throw combworkError(msg({ id: 'session.mode.off', defaultMessage: '{mode} is turned off in Settings → {provider}.', description: "Switching an agent's permission mode is refused: that mode is turned off. {mode} is the mode's name; {provider} the coding agent's (its Settings section)." }), { mode: permissionLabel(p, mode, tr), provider: name }, { kind: 'conflict' })
    const how = l.adapter.descriptor.capabilities.liveModeSwitch
    // Never to or from the CLI's own setting (#1284): Combwork doesn't know where such a session started.
    if (how === 'none' || !canSwitchModeLive(l.adapter.descriptor, mode, st.permissionMode, l.launchMode) || !l.adapter.canSwitchLive(mode, st.permissionMode, l.launchMode)) {
      return { ok: false, restart: true, message: tr(msg({ id: 'session.mode.restart', defaultMessage: "{mode} can't be switched to inside a running session. Restart the session in that mode; the conversation continues.", description: "Switching an agent's permission mode needs a restart. {mode} is the mode's name." }), { mode: permissionLabel(p, mode, tr) }) }
    }
    if (st.status === 'waiting') throw combworkError(msg({ id: 'session.mode.asking', defaultMessage: 'The agent is asking you something. Answer it first, then switch the mode.', description: "Switching an agent's permission mode is refused: it waits for the user's answer." }), undefined, { kind: 'conflict' })
    if (st.status === 'starting') throw combworkError(msg({ id: 'session.mode.starting', defaultMessage: 'The session is still starting. Try again in a moment.', description: "Switching an agent's permission mode is refused for a moment: it is starting." }), undefined, { kind: 'conflict' })
    const key = this.key(projectPath, agentId)
    // The composer is reserved while the keys go in (#649), as for a line Combwork types: none is typed into the menu, nor
    // the keys into a line.
    if (this.delivering.has(key)) throw combworkError(msg({ id: 'session.mode.typing', defaultMessage: 'Combwork is typing a line into this agent. Switch the mode in a moment.', description: "Switching an agent's permission mode is refused for a moment: Combwork is typing into its terminal." }), undefined, { kind: 'conflict' })
    this.delivering.add(key)
    try {
      return await this.switchModeKeys(l, mode, how)
    } finally {
      this.delivering.delete(key)
    }
  }

  /** setPermissionMode's keys, with the composer reserved. */
  private async switchModeKeys(l: LiveSession, mode: PermissionMode, how: string): Promise<{ ok: boolean; restart?: boolean; message?: string }> {
    const st = l.state
    const p = st.provider
    const name = l.adapter.descriptor.name
    const id = liveId(st.projectPath, st.agentId)
    const key = this.key(st.projectPath, st.agentId)
    if (how === 'menu' && l.adapter.modeMenuKeys) {
      // The CLI's own menu (Codex: /permissions). Only while idle: typed into a working agent it would queue.
      if (st.status === 'working') throw combworkError(msg({ id: 'session.mode.working', defaultMessage: '{provider} is working. Switch the mode once it has finished.', description: "Switching an agent's permission mode is refused while it works. {provider} is the coding agent's name." }), { provider: name }, { kind: 'conflict' })
      const before = st.permissionMode
      st.modeSwitching = mode
      l.switchTail = ''
      this.emitState(st)
      /** This switch's session is still the one running (not stopped, nor replaced by a restart while it waited). */
      const same = (): boolean => this.live.get(id) === l
      /** It is asking the user something (its status can change while the keys wait). */
      const asking = (): boolean => st.status === 'waiting'
      /** The switch didn't happen: the badge goes back, and the session (if it is still this one) keeps its mode. */
      const notSwitched = (message: string): { ok: false; message: string } => {
        l.switchTail = undefined
        st.modeSwitching = undefined
        if (same()) this.emitState(st)
        return { ok: false, message }
      }
      // Why the keys stopped, as the window says it (KeysStopped carries the English, for the log).
      let stoppedWhy: Text | null = null
      const stop = (text: Text): string => {
        stoppedWhy = text
        // log: KeysStopped's why, the log line's (the window's notice says stoppedWhy)
        return englishText(text)
      }
      try {
        await typeKeySteps(l.adapter.modeMenuKeys(mode), {
          write: (keys) => writePty(key, keys),
          screen: () => l.screen?.text() ?? null,
          // Asked before every key (#363): safe while this session runs, isn't asking the user anything, and isn't
          // busy (its status, or its screen holding what was typed); busy, it waits, at most 30 seconds.
          ready: async () => {
            for (const t0 = Date.now(); ; await new Promise((r) => setTimeout(r, 200))) {
              if (!same()) return stop(msg({ id: 'session.mode.why.ended', defaultMessage: 'its session ended', description: "Why Combwork stopped switching an agent's permission mode (a clause: \"Combwork didn't switch to Auto, as its session ended.\")." }))
              if (asking()) return stop(withValues(msg({ id: 'session.mode.why.asking', defaultMessage: '{provider} is asking you something', description: "Why Combwork stopped switching an agent's permission mode (a clause). {provider} is the coding agent's name." }), { provider: name }))
              if (st.status !== 'working' && !l.adapter.busyScreen?.(l.screen?.text() ?? '')) return true
              if (Date.now() - t0 >= 30_000) return stop(withValues(msg({ id: 'session.mode.why.busy', defaultMessage: '{seconds, plural, one {{provider} stayed busy for # second} other {{provider} stayed busy for # seconds}}', description: "Why Combwork stopped switching an agent's permission mode (a clause). {provider} is the coding agent's name; {seconds} how many seconds Combwork waited." }), { provider: name, seconds: 30 }))
            }
          }
        })
      } catch (e) {
        if (e instanceof KeysStopped) {
          // Nothing more typed, nothing chosen: what went in already may still be in its input.
          log.warn(`${userText(this.label(st))}: ${name}: stopped switching to ${mode}: ${e.why}`)
          return notSwitched(tr(msg({ id: 'session.mode.stopped', defaultMessage: "Combwork didn't switch to {mode}, as {why}. Check its terminal, or switch there.", description: "Switching an agent's permission mode stopped part-way. {mode} is the mode's name; {why} says why, as a clause." }), { mode: permissionLabel(p, mode, tr), why: stoppedWhy ? shownText(stoppedWhy) : e.why }))
        }
        if (!(e instanceof PickNotFound)) throw e
        // The menu doesn't show the mode (another CLI version): closed again, nothing chosen, nothing assumed. Escape
        // goes only into this session, and not over a question it asks meanwhile.
        if (same() && !asking()) writePty(key, '\x1b')
        log.warn(`${userText(this.label(st))}: ${name}: couldn't find ${e.what}`)
        return notSwitched(tr(msg({ id: 'session.mode.notFound', defaultMessage: "Combwork couldn't find {what}, so it didn't switch to {mode}. Check its terminal, or switch there.", description: "Switching an agent's permission mode failed: the CLI's menu didn't show what Combwork looked for. {what} names it, in the CLI's words; {mode} is the mode's name." }), { what: e.what, mode: permissionLabel(p, mode, tr) }))
      }
      if (!same()) return notSwitched(tr(M.switchEnded, { mode: permissionLabel(p, mode, tr) }))
      // The CLI records the new settings in its transcript at once: read them back rather than assume.
      const src = await this.liveTranscript(l)
      if (!same()) return notSwitched(tr(M.switchEnded, { mode: permissionLabel(p, mode, tr) }))
      const details = !!src && !!l.adapter.transcriptDetails
      // The CLI's own question about the mode picked (Codex's warning before Full Access, #1014): the user answers it in
      // the terminal, so the switch waits for the answer, however long (up to the adapter's answerMs: an advanced
      // setting), and the 12 seconds the CLI has to confirm start once it is answered. What the CLI printed before the
      // answer doesn't count: the user may still cancel.
      const wait = l.adapter.modeConfirmWait?.() ?? { appearMs: 0, answerMs: 0 }
      let asked = false
      const askedAt = Date.now()
      for (let t = Date.now(); same(); ) {
        if (details) {
          const hooks = l.hooksSeen ?? 0
          const s = await stat(src!).catch(() => null)
          if (s) await this.readDetails(l, src!, s.size, hooks)
          if (st.permissionMode === mode) break
        }
        if (l.adapter.modeConfirmScreen?.(l.screen?.text() ?? '')) {
          if (!asked) log.info(`${userText(this.label(st))}: ${name} asks to confirm ${mode} in its terminal`)
          asked = true
          if (Date.now() - askedAt >= wait.answerMs) break
          l.switchTail = ''
          t = Date.now()
        } else {
          if (Date.now() - t >= 12_000) break
          // The CLI's own confirmation in the terminal comes first (the transcript record a few seconds later).
          const said = l.adapter.modeFromOutput?.(l.switchTail ?? '')
          if (said) {
            st.permissionMode = said
            if (said === mode) break
          }
          // Nothing to read (no message sent yet) and nothing asked once the CLI has had a moment to ask: shown as picked;
          // the first turn's settings correct it.
          if (!details && !asked && Date.now() - t >= wait.appearMs) break
        }
        await new Promise((r) => setTimeout(r, 400))
      }
      if (!details && !asked && same() && st.permissionMode !== mode) {
        l.switchTail = undefined
        st.modeSwitching = undefined
        st.permissionMode = mode
        this.emitState(st)
        return { ok: true }
      }
      if (!same()) {
        st.permissionMode = before
        return notSwitched(tr(msg({ id: 'session.mode.endedUnconfirmed', defaultMessage: 'The session ended before {provider} confirmed switching to {mode}.', description: "Switching an agent's permission mode failed: its session ended first. {provider} is the coding agent's name, {mode} the mode's." }), { provider: name, mode: permissionLabel(p, mode, tr) }))
      }
      l.switchTail = undefined
      st.modeSwitching = undefined
      if (st.permissionMode !== mode) {
        st.permissionMode = before
        this.emitState(st)
        log.warn(`${userText(this.label(st))}: ${name} didn't confirm switching to ${mode}`)
        return { ok: false, message: tr(msg({ id: 'session.mode.unconfirmed', defaultMessage: "{provider} didn't confirm switching to {mode}. Check its terminal, or use /permissions there.", description: "Switching an agent's permission mode may have failed: the CLI didn't confirm it. {provider} is the coding agent's name, {mode} the mode's; /permissions is the CLI's command." }), { provider: name, mode: permissionLabel(p, mode, tr) }) }
      }
      this.emitState(st)
      log.info(`${userText(this.label(st))}: switched to ${mode} with the mode menu (confirmed)`)
      this.refreshSizeSoon(l)
      return { ok: true }
    }
    const seen = new Set<PermissionMode>()
    for (let i = 0; i < 8; i++) {
      const before = st.permissionMode
      if (before) seen.add(before)
      writePty(key, '\x1b[Z')
      const t = Date.now()
      // The footer redraw that shows the new mode can take a few seconds on a busy machine or just after the start.
      while (Date.now() - t < 4000 && st.permissionMode === before) await new Promise((r) => setTimeout(r, 50))
      if (st.permissionMode === mode) {
        log.info(`${userText(this.label(st))}: switched to ${mode}`)
        this.refreshSizeSoon(l)
        return { ok: true }
      }
      if (st.permissionMode === before) break
      // Back round to a mode already seen: the target isn't in this session's cycle.
      if (st.permissionMode && seen.has(st.permissionMode)) break
    }
    log.warn(`${userText(this.label(st))}: ${name} didn't reach ${mode} with Shift+Tab (now ${st.permissionMode ?? 'unknown'})`)
    const now = st.permissionMode
      ? tr(msg({ id: 'session.mode.notOfferedIn', defaultMessage: "{provider} didn't offer {mode} with Shift+Tab (it is now in {now}). Restart the session in that mode instead.", description: "Switching an agent's permission mode with Shift+Tab failed. {provider} is the coding agent's name, {mode} the mode asked for, {now} the mode it is in." }), { provider: name, mode: permissionLabel(p, mode, tr), now: permissionLabel(p, st.permissionMode, tr) })
      : tr(msg({ id: 'session.mode.notOffered', defaultMessage: "{provider} didn't offer {mode} with Shift+Tab (it is now in an unknown mode). Restart the session in that mode instead.", description: "Switching an agent's permission mode with Shift+Tab failed, and Combwork can't tell which mode it is in. {provider} is the coding agent's name, {mode} the mode asked for." }), { provider: name, mode: permissionLabel(p, mode, tr) })
    return { ok: false, restart: true, message: now }
  }

  /** Waits for an agent's live status to satisfy `test`, or gives up after `ms`. */
  private async waitStatus(projectPath: string, agentId: string, test: (s: LiveSessionState | null) => boolean, ms: number): Promise<LiveSessionState | null> {
    const t = Date.now()
    for (;;) {
      const st = this.live.get(liveId(projectPath, agentId))?.state ?? null
      if (test(st)) return st
      if (Date.now() - t > ms) throw new Error('timeout')
      await new Promise((r) => setTimeout(r, 400))
    }
  }

  /** The user typed in a terminal (Combwork's own typing goes through sendPrompt, not here). */
  noteUserInput(key: string, data: string): void {
    // xterm's own replies (focus in/out, cursor reports, colour queries) aren't typing.
    const typed = typedText(data)
    if (typed) this.userInput.set(key, { at: Date.now(), enter: typed.endsWith('\r') })
    if (typed?.includes('\r')) {
      this.userEnter.set(key, Date.now())
      // A prompt of the user's, perhaps (#1336): a hook should follow it if it starts a turn.
      const l = [...this.live.values()].find((x) => this.key(x.state.projectPath, x.state.agentId) === key)
      if (l) this.notePrompt(l, false, true)
    }
  }

  /**
   * A prompt was sent to an agent (#1336): while it is idle (or as its launch's task, `launch`), a hook should follow it.
   * `byUser`: the user's own Enter in its terminal (HI-2673: the turn it begins may come with no prompt hook).
   */
  private notePrompt(l: LiveSession, launch = false, byUser = false): void {
    const idle = launch || ['ready', 'finished', 'watching', 'background'].includes(l.state.status)
    if (l.hooksWatch) promptSent(l.hooksWatch, Date.now(), idle, byUser)
  }

  /**
   * Whether an agent's hooks are arriving (#1336, hooksHealth.ts), at each look at its transcript, in the launch's hook
   * order (a hook that came first is taken first, and nothing waits on a read): missing, its state is unknown, nothing is
   * typed into it, its lanes pause, and the user is told once a conversation.
   */
  private checkHooks(projectPath: string, agentId: string): Promise<void> {
    const id = liveId(projectPath, agentId)
    const l = this.live.get(id)
    if (!l?.hooksWatch) return Promise.resolve()
    return this.inHookOrder(l.state.runId, () => {
      const w = l.hooksWatch
      const st = l.state
      if (this.live.get(id) !== l || !w || st.hooksMissing || st.runtime?.lifecycle === 'stopped' || st.runtime?.lifecycle === 'signin') return
      // Tests hold the check while a file is there (#1371), to let a turn finish before any check looks (unpackaged only).
      const hold = !app.isPackaged ? process.env.CW_TEST_HOOKS_HOLD : undefined
      if (hold && existsSync(hold)) return
      // A question at its start (its folder's trust) waits for the user while it is on its screen.
      const text = l.screen?.text() ?? null
      const startWaits = st.status === 'waiting' || (!!l.askedAtStart && (text === null || !l.adapter.startupQuestion || l.adapter.startupQuestion.test(text.replace(/\s+/g, ' '))))
      const after = hooksMissing(w, { startWaits, screen: this.screenTurn(l) }, Date.now(), advanced.number('cw.hooks.missingSeconds') * 1000)
      if (after) this.hooksGone(l, after)
    })
  }

  /** Its hooks aren't arriving (#1336): why if Combwork can tell, its state unknown, its lanes paused, the user told once. */
  private hooksGone(l: LiveSession, after: 'start' | 'prompt' | 'transcript'): void {
    const st = l.state
    const offIn = (() => {
      try {
        return l.hooksOffIn?.() ?? null
      } catch {
        return null
      }
    })()
    // What on the PC would keep them away (HI-2777), read at launch: a setting and where; else hooksOffIn's answer. An
    // allowlist without the token's variable sends them with no token, which Combwork refuses: the allowlist is the cause.
    const cause = l.hookCause ?? (offIn ? { why: 'off' as const, setting: 'disableAllHooks', where: offIn, snippet: false } : null) // i18n-ignore: a select key and a setting's name, never shown
    const remote = !!l.adapter.descriptor.capabilities.remoteHookPolicy
    const events = l.heard ?? new Set<string>()
    const why: HooksMissing['why'] =
      cause?.why === 'blocked' ? 'blocked'
      : hooksRefused(st.runId) ? 'refused'
      : cause ? cause.why
      : remote && events.has('SessionStart') && [...events].every((e) => e === 'SessionStart') ? 'partial'
      : l.newerThanTested ? 'newer'
      : remote && after === 'start' ? 'org'
      : undefined
    const snippet = cause ? cause.snippet : why === 'partial' || why === 'org'
    const turn = after === 'transcript' ? l.hooksWatch?.flagged : null
    st.hooksMissing = { since: new Date().toISOString(), after, ...(turn ? { turn } : {}), ...(why ? { why } : {}), ...(cause && why === cause.why ? { offIn: cause.where, setting: cause.setting, ...(cause.also ? { also: cause.also } : {}) } : {}), ...(snippet ? { snippet } : {}), ...(l.terminalSaid ? { terminal: l.terminalSaid } : {}) }
    this.emitState(st)
    noteHooksMissing(st.projectPath, st.agentId, true)
    const label = this.label(st)
    log.warn(`${userText(label)}: no hooks from ${st.provider} ${after === 'start' ? 'since it started' : after === 'transcript' ? 'for a turn its transcript shows it took' : 'after a prompt it went to work on'}${why ? ` (${why})` : ''}: its status may be wrong, and nothing is typed into it until they come`)
    hookJournal(`run=${st.runId} (no hook) hooks missing after ${after}${why ? ` (${why})` : ''}`)
    // Once a conversation (a restart with the same hooks problem says it again only in its pane).
    if (!this.hooksTold.first(`${st.agentId}\n${st.sessionId || st.runId}`)) return
    // A toast, kept in Notifications.
    toast('warning', tr(msg({ id: 'session.notice.hooksMissingTitle', defaultMessage: "Combwork isn't hearing from {agent}'s hooks", description: "A notification's title: an agent's coding agent has stopped sending Combwork its hooks (the calls that tell Combwork what it is doing). {agent} is the agent." }), { agent: label }), hooksMissingNote(st, tr) ?? '', undefined, st.projectPath, agentTarget(st.projectPath, st.agentId, label))
  }

  /** Its hooks came again (#1336): its status is Combwork's to tell again, and its lanes go on. */
  private hooksBack(l: LiveSession): void {
    const st = l.state
    const was = st.hooksMissing
    st.hooksMissing = undefined
    this.emitState(st)
    noteHooksMissing(st.projectPath, st.agentId, false)
    log.info(`${userText(this.label(st))}: its hooks are arriving again${was ? ` (missing since ${was.since})` : ''}`)
  }

  /** Agents and conversations told their hooks went missing (#1336): once each while Combwork runs, a bounded few (#1369). */
  private hooksTold = new SeenOnce(500)

  /**
   * A line Combwork typed into an agent wasn't taken, even after Enter again (#430: its CLI wasn't reading its input). It is
   * marked in its pane, and the user told once; nothing more is typed into it until the CLI takes it or the user types
   * there. Only for this launch.
   */
  lineNotTaken(projectPath: string, agentId: string, runId: string, text: string, retried = true, rangFor: readonly string[] = []): void {
    const l = this.live.get(liveId(projectPath, agentId))
    if (!l || l.state.runId !== runId || l.state.untakenLine) return
    l.state.untakenLine = { since: new Date().toISOString(), text: text.replace(/\s+/g, ' ').trim().slice(0, 160) }
    l.untakenFor = [...rangFor]
    l.untakenText = text
    l.untakenPrompts = l.prompts ?? 0
    this.emitState(l.state)
    // Its screen as it is now, not only at its next draw (HR3's round 1): a dialog that took the line and has closed may
    // have left the input empty already, and nothing more may be drawn.
    const id = liveId(projectPath, agentId)
    if (l.adapter?.idleQuestion && l.screen) void this.inHookOrder(runId, () => (this.live.get(id) === l ? this.lookAtIdleScreen(id, l) : undefined)).catch((e) => log.warn('lost line: check failed', e))
    const label = this.label(l.state)
    const body = retried
      ? msg({ id: 'session.notice.untakenRetried', defaultMessage: "Combwork typed it and pressed Enter twice, but its CLI wasn't reading its input. Show it, click its terminal and press Enter.", description: "The notification that an agent's CLI didn't take a line Combwork typed into it." })
      : msg({ id: 'session.notice.untaken', defaultMessage: "Combwork typed it, but couldn't press Enter again (the agent was busy, or you were typing there). Show it, click its terminal and press Enter.", description: "The notification that an agent's CLI didn't take a line Combwork typed into it." })
    this.notify(projectPath, withValues(msg({ id: 'session.notice.untakenTitle', defaultMessage: "{agent} hasn't taken a line Combwork typed", description: "A notification's title: an agent's CLI didn't take a line Combwork typed into it (a wake, a message). {agent} is the agent." }), { agent: label }), body, 'waiting', l.state.agentName, agentId)
  }

  /**
   * Holds an agent's input for a typed wake being confirmed (#430), for that launch: nothing more is typed into it until
   * the returned release (taken, or marked not taken: the mark holds it then), or the launch ends (a new launch has its
   * own state). Null when it isn't running in that launch.
   */
  holdForConfirm(projectPath: string, agentId: string, runId: string): (() => void) | null {
    const l = this.live.get(liveId(projectPath, agentId))
    if (!l || l.state.runId !== runId) return null
    const token = Symbol('confirming')
    l.confirming = token
    const key = this.key(projectPath, agentId)
    this.noteComposer(l, key)
    return () => {
      if (l.confirming !== token) return
      l.confirming = undefined
      this.noteComposer(l, key)
    }
  }

  /**
   * A line Combwork typed into an agent, marked not taken, was taken after all (#1514): `delivery`, which that very line rang
   * for, was read in the same launch (Codex takes a line typed while a turn runs as queued input, with no prompt Combwork
   * sees). The mark goes, so its input isn't held for a line its CLI no longer has. Another line's delivery read leaves it
   * (round 1 finding: an older line's, read late, says nothing of this one).
   */
  lineTaken(projectPath: string, agentId: string, runId: string, delivery: string, why: string): void {
    const l = this.live.get(liveId(projectPath, agentId))
    if (!l || l.state.runId !== runId || !l.untakenFor?.includes(delivery)) return
    this.clearUntaken(l, why)
  }

  /** Whether an agent has a line Combwork typed that its CLI hasn't taken (#430): nothing more is typed into it meanwhile. */
  lineUntaken(projectPath: string, agentId: string): boolean {
    return !!this.live.get(liveId(projectPath, agentId))?.state.untakenLine
  }

  /**
   * Whether a line Combwork typed into an agent is still waiting to be taken (#430): typed in the last PENDING_MS and not
   * taken yet, or marked as not taken. Nothing more is typed into it meanwhile (it would clear that line, or be lost).
   */
  lineWaiting(projectPath: string, agentId: string): boolean {
    return this.lineBlocked(this.live.get(liveId(projectPath, agentId)))
  }
  private lineBlocked(l: LiveSession | undefined): boolean {
    if (!l) return false
    if (l.state.untakenLine || l.confirming) return true
    // The user's draft over a line of Combwork's: until a prompt is submitted there.
    if (l.draftOver && (l.prompts ?? 0) <= l.draftOver.prompts) return true
    return !!l.typed && (l.prompts ?? 0) <= l.typed.prompts && Date.now() - l.typed.at < PENDING_MS
  }

  private clearUntaken(l: LiveSession, why: string): void {
    const u = l.state.untakenLine
    if (!u) return
    log.info(`${userText(this.label(l.state))}: the line Combwork typed is no longer waiting (${why}, ${Math.round((Date.now() - Date.parse(u.since)) / 1000)} s after it was marked)`)
    l.state.untakenLine = undefined
    l.untakenFor = undefined
    l.untakenText = undefined
    l.untakenPrompts = undefined
    this.dropLostLook(l)
    this.emitState(l.state)
  }

  /** When the user last pressed Enter in each terminal (by pty key): a prompt its CLI takes soon after is theirs (#418). */
  private userEnter = new Map<string, number>()

  /**
   * The user sent an agent a prompt from its pane (#418): what its CLI took (UserPromptSubmit) soon after the user's own
   * Enter there, later than any line Combwork typed. main/watches.ts tells the Assistant's watches.
   */
  userReplied: (projectPath: string, agentId: string, agentName: string, text: string) => void = () => undefined

  /**
   * A line Combwork typed, never taken, was lost from the CLI's input (HI-1959): the deliveries it rang for, of that launch,
   * are queued again by the delivery service (main/deliveries.ts), so the doorbell rings once more; one read meanwhile
   * isn't.
   */
  lineLost: (projectPath: string, agentId: string, runId: string, deliveries: readonly string[]) => void = () => undefined

  private noteUserReply(l: LiveSession, text: string | null | undefined): void {
    const st = l.state
    if (!text?.trim() || text.trim().startsWith('/') || workspace.isAssistantHome(st.projectPath)) return
    // A launch's task on its command line is its CLI's first prompt (HI-2218, #712), Combwork's whatever Enter the user
    // pressed on its start screen; `prompted` has counted it already.
    if (l.launchTask && (l.prompts ?? 0) <= 1) return
    const enterAt = this.userEnter.get(this.key(st.projectPath, st.agentId)) ?? 0
    // Not when Combwork's own Enter came after the user's (HI-2218): its line, reported taken while its typing still waits.
    if (enterAt <= Math.max(l.typed?.at ?? 0, l.combworkEnterAt ?? 0) || Date.now() - enterAt > USER_REPLY_MS) return
    this.userReplied(st.projectPath, st.agentId, st.agentName ?? st.agentId, text)
  }

  /** Whether the user may still be writing in an agent's terminal (Settings → Assistant → Pause after you type). */
  userMayBeTyping(projectPath: string, agentId: string): boolean {
    const u = this.userInput.get(this.key(projectPath, agentId))
    if (!u) return false
    const s = config.settings.assistant
    if (u.enter && (s?.enterEndsPause ?? true)) return false
    return Date.now() - u.at < (s?.typingPause ?? 15) * 1000
  }

  /** When userMayBeTyping ends for an agent (ms since the epoch), while it holds; null when it doesn't (HI-2191: a wait for it). */
  userQuietAt(projectPath: string, agentId: string): number | null {
    if (!this.userMayBeTyping(projectPath, agentId)) return null
    return this.userInput.get(this.key(projectPath, agentId))!.at + (config.settings.assistant?.typingPause ?? 15) * 1000
  }

  /**
   * The run `runId` of the Combwork Assistant was told its mode `modeId`: its conversation records it, so a resume
   * tells it again only after another switch (#334).
   */
  async modeGiven(projectPath: string, agentId: string, runId: string, modeId: string): Promise<void> {
    const l = this.live.get(liveId(projectPath, agentId))
    if (!l || l.state.runId !== runId) return
    l.mode = modeId
    if (l.state.sessionId) await workspace.upsertSession(projectPath, { id: l.state.sessionId, mode: modeId })
  }

  /** When the user last typed in an agent's terminal (ms since the epoch), or 0. */
  userTypedAt(projectPath: string, agentId: string): number {
    return this.userInput.get(this.key(projectPath, agentId))?.at ?? 0
  }

  /** Files an agent holds a lock on (it is editing them this turn). */
  locksFor(projectPath: string, agentId: string): string[] {
    const id = liveId(projectPath, agentId)
    return [...this.locks.values()].filter((x) => x.liveId === id).map((x) => x.path)
  }

  /** Files any agent holds a lock on in a folder (#1351: an agent builds there, so the merge queue doesn't update it). */
  locksIn(folder: string): string[] {
    return [...this.locks.values()].filter((x) => inFolder(x.path, folder)).map((x) => x.path)
  }

  /**
   * Clears a CLI's input before Combwork types into it (Settings → Advanced: Clear the CLI's draft before Combwork types). One
   * Ctrl+U where it clears the whole line, as before. Where it deletes only the row the cursor is on
   * (capabilities.ctrlUClearsRow, HI-1979: Claude Code 2.1.312), Ctrl+U a key at a time while its input box
   * (adapter.promptBox) holds anything. Empty is only ever what a key of Combwork's draws now, never a box already on the
   * screen (its redraw may be late, HR6's round 1): a letter typed (CLEAR_PROBE) must show alone in the box, then the
   * Backspace that takes it back must leave the box empty; a draft left shows the letter at its end, and is cleared with
   * it. Each key must be answered within Advanced's wait for each key, by the box drawn differently, or, while the box
   * can't be read (a draft taller than the screen), by the screen changing, which can only go on, never end it. A key not
   * answered, CLEAR_KEYS_MOST keys, or a box it can't read refuse what was to be typed: nothing of it is written, and
   * the letter, if it is still there, is taken back unless the user has typed since. `check` runs before each key (the
   * same run, the caller's guard: the user typing there stops it, their draft theirs).
   */
  private async clearInput(l: LiveSession | undefined, key: string, check: () => void): Promise<void> {
    if (!l?.adapter?.descriptor.capabilities.ctrlUClearsRow) {
      writePty(key, '\x15')
      await new Promise((r) => setTimeout(r, 150))
      check()
      return
    }
    const screen = l.screen
    const { projectPath, agentId, runId } = l.state
    const since = Date.now()
    // The box as drawn (adapter.promptBox): a key that deletes only an empty row (a line break's) changes it too. Empty
    // is nothing but spacing in it.
    const drawn = (): string | null => (screen && l.adapter.promptBox ? l.adapter.promptBox(screen.textWithoutDim()) : null)
    const read = (): string | null => {
      const box = drawn()
      return box === null ? null : box.trim() ? box : ''
    }
    const words = (box: string | null): string => (box ?? '').replace(/\s+/g, ' ').trim()
    const notCleared = (why: string): Error => {
      log.info(`${userText(this.label(l.state))}: its input wasn't seen empty, so nothing is typed into it: ${why}`) // i18n-ignore: why, for the log
      return combworkError(msg({ id: 'session.prompt.inputNotCleared', defaultMessage: "Its input couldn't be seen empty after Combwork cleared it: nothing is typed into it until it can be.", description: "Typing into an agent is refused (a message's notice is put off and tried again; Compact fails): Combwork pressed keys to clear the draft in its coding agent's input, and didn't see the input empty afterwards." }), undefined, { kind: 'conflict' })
    }
    const waitMs = advanced.number(CLEAR_KEY_WAIT) * 1000
    // Refused because a key went unanswered while the box read empty (HI-2191): something else may take its keys.
    let unanswered = false
    /** The box once the key just pressed is answered: drawn differently from `before`, or null while it can't be read and the screen changed. */
    const answered = async (keyName: string, before: string | null, shown: string | null): Promise<string | null> => {
      const t = Date.now()
      for (;;) {
        await new Promise((r) => setTimeout(r, 25))
        const box = read()
        if (box !== before && box !== null) return box
        if (before === null && box === null && shown !== null && screen!.text() !== shown) return null
        if (Date.now() - t > waitMs) {
          unanswered = before === ''
          throw notCleared(before === null ? "its input box isn't on the screen" : `${keyName} wasn't answered within ${waitMs} ms (the box read "${userText(words(before).slice(0, 60))}")`) // i18n-ignore: why, for the log
        }
      }
    }
    /** Presses a key and waits for it to be answered, from the box and the screen as they were before it. */
    const press = async (data: string, keyName: string, before: string | null): Promise<string | null> => {
      const shown = screen?.text() ?? null
      writePty(key, data)
      return answered(keyName, before, shown)
    }
    let box = read()
    // The letter typed and not taken back yet.
    let probe = false
    try {
      for (let n = 0; ; n++) {
        if (n >= CLEAR_KEYS_MOST) throw notCleared(`${CLEAR_KEYS_MOST} keys didn't empty it`) // i18n-ignore: why, for the log
        check()
        if (box === '') {
          probe = true
          box = await press(CLEAR_PROBE, 'A letter typed', box) // i18n-ignore: the key's name, for the log
          if (words(box) !== CLEAR_PROBE) {
            // A draft left (its redraw was late), the letter at its end: cleared with it.
            probe = false
            continue
          }
          check()
          box = await press('\x7f', 'A Backspace', box)
          probe = false
          if (box !== '') throw notCleared(`the letter Combwork typed and took back left "${userText(words(box).slice(0, 60))}"`) // i18n-ignore: why, for the log
          check()
          l.unanswered = 0
          return
        }
        box = await press('\x15', 'A Ctrl+U', box)
      }
    } catch (e) {
      const same = this.live.get(liveId(projectPath, agentId)) === l && l.state.runId === runId
      if (probe && same && this.userTypedAt(projectPath, agentId) < since) writePty(key, '\x7f')
      if (unanswered && same) this.inputUnanswered(l)
      throw e
    }
  }

  /**
   * Whether something on an agent's screen takes the keys its input box should (HI-2191): nothing is typed into it, and
   * no Enter pressed, until it is seen to take keys again.
   */
  inputBlocked(projectPath: string, agentId: string): boolean {
    const l = this.live.get(liveId(projectPath, agentId))
    return !!l?.inputBlocked && l.inputBlocked.runId === l.state.runId
  }

  /**
   * Why Combwork keeps out of an agent (HI-2670): `independent`, its role now (its own, or its connection launching
   * without Combwork's tools), whatever its launch got; `plain`, the launch it runs got neither Combwork's tools nor its
   * typing. Null: Combwork may type into it, deliver to it and add to its context. Read at each use from the workspace's
   * projects as held (no file is read): hooks and deliveries ask it. The Assistant: never.
   */
  keepsOut(projectPath: string, agentId: string): 'independent' | 'plain' | null {
    const ws = workspaceFor(projectPath)
    if (!ws || ws.isAssistantHome(projectPath)) return null
    if (independentIn(ws, projectPath, agentId)) return 'independent'
    const policy = this.live.get(liveId(projectPath, agentId))?.policy
    return policy && (!policy.tools || !policy.typing) ? 'plain' : null
  }

  /** Its input box as drawn now, as clearInput reads it ('' when empty, null when none is on the screen). */
  private boxNow(l: LiveSession): string | null {
    const box = l.screen && l.adapter.promptBox ? l.adapter.promptBox(l.screen.textWithoutDim()) : null
    return box === null ? null : box.trim() ? box : ''
  }

  /**
   * A clear refused because a key went unanswered while its box read empty (HI-2191: Claude Code 2.1.314's offer to teach
   * auto mode, drawn under the empty box, took Combwork's keys 105 times while nobody was told). At INPUT_BLOCKED_AFTER in a
   * row the input is blocked: the agent waits for the user with why, unless it already waits on something else, whose
   * reason stays (nothing is typed meanwhile either way).
   */
  private inputUnanswered(l: LiveSession): void {
    l.unanswered = (l.unanswered ?? 0) + 1
    if (l.unanswered < INPUT_BLOCKED_AFTER || l.inputBlocked) return
    const st = l.state
    const id = liveId(st.projectPath, st.agentId)
    const text = msg({ id: 'session.status.inputBlocked', defaultMessage: 'Something on its screen is taking its keys: answer it there, then Try again', description: "An agent's status: Combwork typed into its coding agent's input and nothing reached it (a dialog or question of the coding agent's own, which Combwork doesn't recognise, takes the keys). The user answers it in the agent's terminal. Try again is the button beside this status: keep its name as it is translated there." })
    // agent-stored: agentField says it for each agent where its status is sent (setStatus keeps its text)
    const ask: Ask = { kind: 'question', blocking: true, message: englishText(text), text }
    const at = Date.now()
    l.inputBlocked = { runId: st.runId, ask, box: this.boxNow(l), since: at }
    st.inputBlocked = { since: new Date(at).toISOString() }
    log.info(`${userText(this.label(st))}: its input took no key in ${l.unanswered} clears in a row: something on its screen takes them; it waits for the user, and nothing is typed into it until it takes keys again`) // i18n-ignore: for the log
    const ev: HookEvent = { kind: 'ask', ask }
    if (AT_PROMPT.has(st.status)) this.carryOut(id, l, hookStep(ev, this.statusInput(l)), 'screen', ev)
    else this.emitState(st)
  }

  /**
   * Its input is seen to take keys again (HI-2191: its box answered the user's key, a hook moved it, or Try again's clear
   * was answered), in the run it was blocked in: typing goes on, and the agent that waited on it is idle again. Another
   * reason it waits for (a newer question) stays.
   */
  private unblockInput(id: string, l: LiveSession, why: string): void {
    const b = l.inputBlocked
    if (!b || this.live.get(id) !== l || l.state.runId !== b.runId) return
    l.inputBlocked = undefined
    l.unanswered = 0
    l.state.inputBlocked = undefined
    log.info(`${userText(this.label(l.state))}: its input takes keys again (${why})`) // i18n-ignore: for the log
    if (l.state.status === 'waiting' && l.waitingOn === b.ask) this.carryOut(id, l, idleQuestionGone(this.statusInput(l)), 'screen')
    else this.emitState(l.state)
  }

  /**
   * The screen drawn while its input is blocked (HI-2191): once the user has typed there, a box drawn differently from
   * when it was blocked took a key of theirs, so the input takes keys. Keys that only move about a dialog leave it so.
   */
  private inputBlockedDrawn(id: string, l: LiveSession): void {
    const b = l.inputBlocked
    if (!b || b.retrying || this.userTypedAt(l.state.projectPath, l.state.agentId) < b.since) return
    const box = this.boxNow(l)
    if (box !== null && box !== b.box) this.unblockInput(id, l, "its input box took the user's key") // i18n-ignore: for the log
  }

  /**
   * Try again (HI-2191), the user's, beside a blocked input's status: one clear of its input, as before typing, for the
   * block `since` names (LiveSessionState.inputBlocked) in its run, one at a time. Answered, typing goes on; not, it stays
   * blocked. The user's own click, so the pause after they type doesn't hold it (their Esc that put a dialog off is
   * typing too); a box holding their text took a key already, and is never cleared, and their typing meanwhile stops it.
   * 'gone': that block is over (or another began); 'busy': a try or a line is being typed.
   */
  async retryInput(projectPath: string, agentId: string, since: string): Promise<'clear' | 'blocked' | 'gone' | 'busy'> {
    const id = liveId(projectPath, agentId)
    const l = this.live.get(id)
    const b = l?.inputBlocked
    if (!l || !b || b.runId !== l.state.runId || l.state.inputBlocked?.since !== since) return 'gone'
    const key = this.key(projectPath, agentId)
    if (b.retrying || this.delivering.has(key)) return 'busy'
    const box = this.boxNow(l)
    if (box) {
      this.unblockInput(id, l, 'Try again: its input box holds text') // i18n-ignore: for the log
      return 'clear'
    }
    b.retrying = true
    this.delivering.add(key)
    const started = Date.now()
    try {
      await this.clearInput(l, key, () => {
        if (this.live.get(id) !== l || l.inputBlocked !== b || this.userTypedAt(projectPath, agentId) > started) throw combworkError(M.stoppedBeforePrompt)
      })
      this.unblockInput(id, l, 'Try again: its input took the key') // i18n-ignore: for the log
      return 'clear'
    } catch {
      return l.inputBlocked === b ? 'blocked' : 'gone'
    } finally {
      b.retrying = false
      this.delivering.delete(key)
    }
  }

  /** Types a message into an agent's terminal and sends it. */
  /** Agents Combwork is typing a prompt into (one at a time each). */
  private delivering = new Set<string>()

  /**
   * Types a prompt into an agent and sends it, on one line (a new line would send it early in the CLI).
   * Refused while another is being typed there; stops if the agent stops or restarts meanwhile. `guard` throws if the
   * prompt mustn't go in any more (the agent got busy, the user typed there): it is checked before the input is
   * cleared, before each part is typed and before it is sent. Stopped part-way, what Combwork typed is cleared again,
   * unless the user has typed since (their input stays).
   */
  async sendPrompt(projectPath: string, agentId: string, text: string, guard?: () => void, opts: { confirm?: boolean } = {}): Promise<void> {
    const key = this.key(projectPath, agentId)
    const l = this.live.get(liveId(projectPath, agentId))
    const runId = l?.state.runId
    if (this.delivering.has(key)) throw combworkError(M.typingBusy, undefined, { kind: 'conflict' })
    // A line typed before isn't taken yet (#430): typing more would clear it, or be lost behind it.
    const waiting = (): void => {
      if (this.lineBlocked(this.live.get(liveId(projectPath, agentId)))) throw combworkError(msg({ id: 'session.prompt.untaken', defaultMessage: "Its CLI hasn't taken the line Combwork typed before; nothing more is typed until it does.", description: "Typing into an agent is refused: its CLI hasn't taken the line Combwork typed before." }), undefined, { kind: 'conflict' })
    }
    // Its CLI's own question on its screen (HI-1959): it takes the keys, and Enter answers it.
    const asked = (): void => {
      if (this.cliAsks(projectPath, agentId)) throw combworkError(msg({ id: 'session.prompt.cliAsks', defaultMessage: 'Its CLI shows a question for you: nothing is typed into it until you answer it there.', description: "Typing into an agent is refused: its coding agent shows a question of its own on its screen (such as Claude Code's offer to teach auto mode about your environment), which the keys would answer." }), undefined, { kind: 'conflict' })
      // Something on its screen takes its keys (HI-2191): nothing more goes into it until it is seen to take them again.
      if (this.inputBlocked(projectPath, agentId)) throw combworkError(msg({ id: 'session.prompt.inputBlocked', defaultMessage: 'Something on its screen is taking its keys: nothing is typed into it until you answer it there.', description: "Typing into an agent is refused: keys Combwork typed into its coding agent's input didn't reach it (a dialog or question of the coding agent's own takes them)." }), undefined, { kind: 'conflict' })
    }
    waiting()
    asked()
    this.delivering.add(key)
    this.noteComposer(l, key)
    const same = (): boolean => !!runId && this.live.get(liveId(projectPath, agentId))?.state.runId === runId
    const check = (): void => {
      if (!same()) throw combworkError(M.stoppedBeforePrompt)
      waiting()
      asked()
      guard?.()
    }
    const since = Date.now()
    let typed = false
    // What a multi-line prompt typed so far, by line (HI-1327): taken back as exactly that if stopped part-way.
    let lines: number[] | null = null
    // What a one-line prompt writes (pasted, or typed in pieces): taken back character by character where Ctrl+U
    // deletes one wrapped row (backspaceKeys).
    let typedOut = ''
    let sent: { at: number; prompts: number; from: number } | null = null
    // Settings → Advanced (#1286): whether Combwork clears the CLI's input first (and takes back a prompt it stopped), and
    // whether it keeps the prompt as written.
    const clearDraft = advanced.get<boolean>(PROMPT_CLEAR_DRAFT)
    const asTyped = advanced.get<boolean>(PROMPT_AS_TYPED)
    try {
      check()
      if (clearDraft) await this.clearInput(l, key, check)
      typed = true
      const line = asTyped ? text : text.replace(/\s+/g, ' ').trim()
      // A CLI busy for a moment reads what Combwork typed in one go, Ctrl+U and Enter included: Claude Code takes such a
      // read as a paste with those keys in it as text, and then Enter again doesn't send it either (#597). A bracketed
      // paste is text however it arrives. A slash command is still typed: pasted, it is sent as a message.
      // Enter once the CLI has drawn the line (#600: a busy Codex drops an Enter it reads with the line): its end shows
      // on the screen once more than before it was typed.
      const paste = !!l?.screen?.bracketedPaste() && l.adapter.descriptor.capabilities.bracketedPaste && !line.startsWith('/')
      // Typed as written into a CLI with a new-line key (HI-1327, Settings → Advanced): its line breaks are that key. A
      // slash command keeps spaces.
      // By the CLI's version as this run was launched, never the one installed since (HR6's round 1).
      const newline = !paste && asTyped && !line.startsWith('/') && l ? l.adapter.typedNewline?.(l.cliVersion ?? null) : null
      const segments = newline ? typedPrompt(line, TYPED_NEWLINE_KEYS[newline]) : null
      // What Enter waits to see drawn: the last piece with something visible in it (a line of spaces draws nothing to
      // find); none, no wait, as for an empty line.
      const out = segments ? segments.flatMap((s) => ('text' in s && s.text.trim() ? [s.text] : [])).at(-1) ?? '' : promptInput(line, paste, asTyped)
      const drawn = l?.screen && l.adapter.descriptor.capabilities.enterOnceDrawn && out.trim() ? drawnLine(l.screen, out) : null
      typedOut = out
      if (paste) writePty(key, `\x1b[200~${out}\x1b[201~`)
      else if (segments) {
        lines = [0]
        await typeSegments(key, segments, () => (check(), true), lines)
      } else await typeInto(key, out, () => (check(), true))
      if (l) await heldTyped(this.label(l.state), check)
      await new Promise((r) => setTimeout(r, 300))
      check()
      if (drawn && !drawn()) {
        // How long, at most: Settings → Advanced (a slower CLI may need longer).
        const most = advanced.number(drawnWaitId(l!.adapter.id)) * 1000
        // Typed, and not drawn yet (a busy CLI): e2e suites wait for this line (wakepaste-codex).
        log.info(`${userText(this.label(l!.state))}: the line Combwork typed is in; Enter once it shows`)
        const t = Date.now()
        while (!drawn() && Date.now() - t < most) {
          await new Promise((r) => setTimeout(r, 50))
          check()
        }
        if (!drawn()) log.info(`${userText(this.label(l!.state))}: the line Combwork typed wasn't drawn within ${most} ms: Enter anyway`)
      }
      const before = l?.prompts ?? 0
      // Combwork's line from its Enter (HI-2218): the CLI reports it taken while the confirm below still waits, before `typed`.
      if (l) l.combworkEnterAt = Date.now()
      writePty(key, '\r')
      // Waiting to be taken from here (#430), for whatever Combwork types next: recorded once this call is done with it (its
      // own Enter again below is no line over it; nothing else types meanwhile, it holds `delivering`).
      sent = { at: Date.now(), prompts: before, from: since }
      // A hook should follow it (#1336), unless it is a command of the CLI's own.
      if (l && !line.startsWith('/')) this.notePrompt(l)
      // i18n-ignore: the developer console's event data, recorded like a log, stays English (#1104)
      devConsole.capture([sessionSourceId(projectPath, agentId)], () => ({ kind: 'input', name: 'Combwork typed a line', provider: l?.state.provider, raw: { text: line }, made: { bracketedPaste: !!l?.screen?.bracketedPaste(), confirm: !!opts.confirm }, summary: `Combwork typed a line (${line.length} chars) and Enter` }))
      // confirm: until the CLI reports the prompt submitted. One just resumed and still drawing its conversation can
      // drop the Enter, or take it as a new line (#334): Enter again, which an empty prompt ignores. Still not
      // reported (a CLI that doesn't report prompts), it counts as sent: typing it again could send it twice.
      const taken = (): boolean => (l?.prompts ?? 0) !== before || !same()
      for (let i = 0; opts.confirm && i < 3; i++) {
        const t = Date.now()
        while (!taken() && Date.now() - t < 3000) await new Promise((r) => setTimeout(r, 100))
        if (taken()) break
        if (i === 2) {
          log.warn(`${userText(this.label(l!.state))}: the CLI didn't report Combwork's prompt submitted`)
          break
        }
        // Never an Enter that would send what the user has begun typing, or into a session that got busy.
        if (this.userTypedAt(projectPath, agentId) >= since) break
        try {
          check()
        } catch {
          break
        }
        if (l) l.combworkEnterAt = Date.now()
        writePty(key, '\r')
      }
    } catch (e) {
      const who = userText(l ? this.label(l.state) : agentId)
      if (clearDraft && typed && same() && this.userTypedAt(projectPath, agentId) < since) {
        // A multi-line prompt: one Ctrl+U for each of its lines with text and each line break, each its own key, so no
        // line of it is left to go with a later prompt (HR6's round 1 of HI-1327); none past it. A CLI whose Ctrl+U
        // deletes one wrapped row gets a Backspace for each character instead, a few at a time as typing goes (HI-1974).
        // Each take-back is logged as its keys are written (HI-2875: a put-off line's take-back had no time in the log).
        let pressed = 0
        const rows = !!l?.adapter.descriptor.capabilities.ctrlUClearsRow
        const n = rows ? backspaceKeys(lines ?? typedOut) : lines ? rollbackKeys(lines) : 1
        if (rows) {
          for (let i = 0; i < n; i += 8) {
            if (!same() || this.userTypedAt(projectPath, agentId) >= since) break
            writePty(key, '\x7f'.repeat(Math.min(8, n - i)))
            pressed += Math.min(8, n - i)
            if (i + 8 < n) await new Promise((r) => setTimeout(r, 10))
          }
        } else {
          for (let i = 0; i < n; i++) {
            if (!same() || this.userTypedAt(projectPath, agentId) >= since) break
            writePty(key, '\x15')
            pressed++
            if (i + 1 < n) await new Promise((r) => setTimeout(r, 10))
          }
        }
        log.info(`${who}: the line Combwork typed is taken back: ${pressed} of ${n} ${rows ? 'Backspace' : 'Ctrl+U'} written`)
      } else if (typed) log.info(`${who}: the line Combwork typed is left as it is: ${!clearDraft ? 'clearing drafts is off' : !same() ? 'its run changed' : 'the user typed there'}`)
      throw e
    } finally {
      if (sent && l) l.typed = sent
      this.delivering.delete(key)
      // Its input is held while the line waits to be taken, at most PENDING_MS: free again then, if not taken sooner.
      this.noteComposer(this.live.get(liveId(projectPath, agentId)), key)
      if (sent) setTimeout(() => this.noteComposer(this.live.get(liveId(projectPath, agentId)), key), PENDING_MS + 100).unref?.()
    }
  }

  /**
   * Hands one agent's work over to another (any provider): the source writes a handover with Combwork's
   * cw_create_handover tool, then the target starts and picks it up with cw_read_latest_handover.
   * Conversations can't move between providers; a handover carries the work instead. To itself, it ends the agent's
   * conversation: only while it may (#1057, handOverCheck.ts: idle, not merging, on no running lane's card), checked as
   * it is asked and again just before the conversation ends.
   */
  /**
   * Hands an agent's work over (to another agent, or to itself in a new conversation). `allowed` throws once the caller
   * may no longer have it (HI-2420: the Assistant's Control or session, as newConversation's): checked before each step
   * that acts (asking for the handover, ending the conversation, giving or launching the target), while each line is
   * typed, and as the target's launch spawns. Once it throws, nothing more is done.
   */
  async handOver(projectPath: string, fromAgentId: string, toAgentId: string, opts: { handover: boolean; allowed?: () => void }): Promise<void> {
    projectPath = workspace.assertProject(projectPath)
    const allowed = opts.allowed
    const holds = allowed
      ? (): boolean => {
          try {
            allowed()
            return true
          } catch {
            return false
          }
        }
      : undefined
    // To itself: the agent carries on in a new conversation (a long transcript made short again).
    const self = fromAgentId === toAgentId
    if (!this.combworkMcp(projectPath)) throw combworkError(msg({ id: 'session.handOver.noTools', defaultMessage: 'Handing over needs Combwork\'s tools in sessions: turn on "Provide Combwork tools to sessions" in Settings → Agent API.', description: 'Hand Over to… is refused: agents need Combwork\'s tools to write and read a handover. "Provide Combwork tools to sessions" is a setting in Settings → Agent API: keep its name as Combwork shows it.' }), undefined, { kind: 'conflict' })
    const { agent: to } = await this.agentDef(projectPath, toAgentId)
    const { agent: from } = await this.agentDef(projectPath, fromAgentId)
    // Ending its conversation only while it may (#1057): what the notice, the footer and the dialog offer, checked here
    // too, so a notice or dialog left open while the agent started work, joined a lane or took the merge slot can't.
    if (self && !(await this.handOverAllowed(projectPath, fromAgentId).catch(() => false))) throw combworkError(M.handOverNotNow, { agent: from.name }, { kind: 'conflict' })
    const source = this.live.get(liveId(projectPath, fromAgentId))?.state ?? null
    const fromSession = source?.sessionId || from.lastSessionId || ''
    // The handover the target reads, by name: a newer one appearing meanwhile isn't the one meant.
    let handover = ''
    // When the handover was asked for, and written (its file's time): the turn the request began writes it; another turn
    // begun since, or after it was written, is other work.
    let askedAt = NaN
    let writtenAt = NaN
    if (opts.handover) {
      if (!source) throw combworkError(msg({ id: 'session.handOver.notRunning', defaultMessage: "{agent} isn't running. Resume it to write a handover, or hand over the latest handover.", description: "Hand Over to… with a new handover is refused: the agent handing over isn't running. {agent} is its name." }), { agent: from.name }, { kind: 'conflict' })
      if (source.status !== 'ready' && source.status !== 'finished') throw combworkError(M.handOverBusy, { agent: from.name }, { kind: 'conflict' })
      // Proof, not status: the target starts only once a handover newer than this one exists, written in the
      // source's own conversation (its header's Session, which Combwork writes), not by another agent meanwhile.
      // Among the newest few, since another agent may write one after the source does.
      const known = new Map((await this.recentHandovers(projectPath, 20)).map((h) => [h.relPath, h.modified]))
      const want = source.sessionId
      const isNew = (h: HandoverRef): boolean => (!known.has(h.relPath) || h.modified > known.get(h.relPath)!) && (!want || h.session === want)
      // The caller's authority, after the reads above, before anything is said or asked.
      allowed?.()
      toast(
        'info',
        tr(msg({ id: 'session.handOver.writing', defaultMessage: '{agent} is writing a handover', description: "A notice's title: an agent writes a handover of its work (Hand Over to…). {agent} is its name." }), { agent: from.name }),
        self
          ? tr(msg({ id: 'session.handOver.self', defaultMessage: "It continues from it in a new conversation when it's done.", description: 'The notice that an agent writes a handover to itself (Hand Over to… the same agent).' }))
          : tr(msg({ id: 'session.handOver.other', defaultMessage: "{agent} continues from it when it's done.", description: "The notice that an agent writes a handover for another. {agent} is the other agent's name." }), { agent: to.name }),
        undefined,
        projectPath,
        agentTarget(projectPath, from.id, from.name)
      )
      // A handover delivery (#649), given now or not at all.
      askedAt = Date.now()
      await this.delivery().now(projectPath, {
        agentId: fromAgentId,
        agentName: from.name,
        conversation: source.sessionId || null,
        kind: 'handover',
        from: CW_SENDER,
        // A delivery's body is stored: said in the Default until stored records are said when read (5b, 6b).
        body: inDefaultDialect(() => say(SESSION.handover.ask, { self: self ? 'yes' : 'no', to: to.name })),
        need: 'free'
      }, holds)
      const t0 = Date.now()
      let idleSince = 0
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000))
        const h = (await this.recentHandovers(projectPath, 10).catch(() => [] as HandoverRef[])).find(isNew)
        if (h) {
          handover = h.relPath
          writtenAt = Date.parse(h.modified)
          break
        }
        const st = this.live.get(liveId(projectPath, fromAgentId))?.state
        if (!st) throw combworkError(msg({ id: 'session.handOver.stopped', defaultMessage: '{agent} stopped before writing a handover.', description: "Hand Over to… failed: the agent handing over stopped. {agent} is its name." }), { agent: from.name }, { kind: 'conflict' })
        if (st.status === 'waiting') throw combworkError(msg({ id: 'session.handOver.asking', defaultMessage: '{agent} is asking you something before it can write the handover. Answer it, then hand over again without a new handover.', description: "Hand Over to… stopped: the agent handing over waits for the user. {agent} is its name." }), { agent: from.name }, { kind: 'conflict' })
        // Finished without one (the file can land a moment after the turn ends): give it 20 seconds.
        idleSince = st.status === 'finished' || st.status === 'ready' ? idleSince || Date.now() : 0
        if (idleSince && Date.now() - idleSince > 20_000 && Date.now() - t0 > 30_000) throw combworkError(msg({ id: 'session.handOver.noneWritten', defaultMessage: '{agent} finished without writing a handover. Ask it to write one, then hand over again without a new handover.', description: "Hand Over to… failed: the agent finished its turn without writing a handover. {agent} is its name." }), { agent: from.name }, { kind: 'conflict' })
        if (Date.now() - t0 > 15 * 60_000) throw combworkError(msg({ id: 'session.handOver.slow', defaultMessage: "{agent} didn't write its handover in 15 minutes.", description: "Hand Over to… gave up waiting for the handover. {agent} is the agent's name." }), { agent: from.name }, { kind: 'conflict' })
      }
    }
    if (!handover) {
      handover = (await this.latestHandover(projectPath))?.relPath ?? ''
      if (!handover) throw combworkError(msg({ id: 'session.handOver.none', defaultMessage: 'There is no handover for {project} yet. Hand over with a new handover instead.', description: "Hand Over to… with the latest handover is refused: the project has none. {project} is its name." }), { project: basename(projectPath) }, { kind: 'conflict' })
    }
    // To itself: its conversation ends here (it stays in the Sessions tab), and a new one starts below. Only if it still
    // may (#1057): writing the handover takes minutes, in which it can take the merge slot, join a lane, be relaunched, or
    // be given other work (a task typed in, a background task's wake): being told to stop once the handover is written is
    // no proof it has. Only the turn that wrote it may still be running; with no new handover, no turn may run.
    if (self && this.live.has(liveId(projectPath, fromAgentId))) {
      const sameLaunch = (): boolean => !source || this.live.get(liveId(projectPath, fromAgentId))?.state.runId === source.runId
      const otherWork = (): boolean => {
        const l = this.live.get(liveId(projectPath, fromAgentId))
        if (!l) return false
        const a = l.ledger?.active
        if (tasksWillWake(l.state) || l.state.status === 'waiting' || !!l.state.mergeSlot) return true
        if (Number.isNaN(writtenAt)) return a?.state === 'running' || l.state.status === 'working'
        const starts = l.turnStarts ?? []
        return starts.filter((t) => t >= askedAt).length > 1 || starts.some((t) => t > writtenAt) || (a?.state === 'running' && a.startedAt > writtenAt)
      }
      const may = sameLaunch() && !otherWork() && (await this.handOverAllowed(projectPath, fromAgentId, true).catch(() => false))
      // And with nothing awaited between this and the stop, its launch and its work once more, and the caller's authority.
      if (!may || !sameLaunch() || otherWork()) throw combworkError(M.handOverMomentLost, { agent: from.name, handover }, { kind: 'conflict' })
      allowed?.()
    }
    if (self && this.live.has(liveId(projectPath, fromAgentId)) && !(await this.endConversation(projectPath, fromAgentId))) throw combworkError(msg({ id: 'session.handOver.didntStop', defaultMessage: '{agent} didn\'t stop. Stop it, then start it and ask it to read the handover "{handover}".', description: "Handing over to the same agent failed: it didn't stop to start a new conversation. {agent} is its name, {handover} the handover's path in the shared notes." }), { agent: from.name, handover }, { kind: 'conflict' })
    // The target: given the message in its running session, or started with it as its launch's task (#782), as a task
    // start is. Typed into a CLI that had only just looked ready, it could be lost under load (Codex's screen looks ready
    // before it takes input), and the next hand-over from it was refused.
    const target = this.live.get(liveId(projectPath, toAgentId))?.state ?? null
    if (target && target.status !== 'ready' && target.status !== 'finished') throw combworkError(M.handOverBusy, { agent: to.name }, { kind: 'conflict' })
    // The caller's authority, after every await above (the handover's read, a conversation's end), before the target is given it.
    allowed?.()
    // A delivery's body is stored: said in the Default until stored records are said when read (5b, 6b).
    const nd: NewDelivery = { agentId: toAgentId, agentName: to.name, kind: 'handover', from: CW_SENDER, body: inDefaultDialect(() => say(SESSION.handover.read, { handover, self: self ? 'yes' : 'no', from: from.name })) }
    // The sessions are linked with the launch's conversation as it is recorded (#782: Codex names it only with its first
    // prompt, which a question at start can hold off for minutes), never by a wait here that could give up first.
    if (target) {
      await this.delivery().now(projectPath, { ...nd, need: 'free' }, holds)
      if (fromSession) await this.linkHandover(projectPath, toAgentId, target.runId, fromSession)
    } else await this.delivery().launch(projectPath, nd, (line) => this.start(projectPath, { agentId: toAgentId, prompt: line, ...(fromSession ? { handedOverFrom: fromSession } : {}), ...(self ? { keepWatch: true } : {}), ...(allowed ? { allowed } : {}) }))
  }

  /**
   * Links the conversation a running agent was handed over into (its launch `runId`'s) with the one it came from: at once
   * when its id is known, else as it is recorded (recordSession). Another launch of the agent by now is another's.
   */
  private async linkHandover(projectPath: string, agentId: string, runId: string, fromSession: string): Promise<void> {
    const l = this.live.get(liveId(projectPath, agentId))
    if (!l || l.state.runId !== runId) return
    if (!l.state.sessionId) {
      l.handedOverFrom = fromSession
      return
    }
    await workspace.upsertSession(projectPath, { id: l.state.sessionId, handedOverFrom: fromSession }).catch((e) => log.warn(`${userText(this.label(l.state))}: could not link the handed-over session`, e))
  }

  /**
   * Gives an idle running agent a task in a new conversation (cw_prompt_agent with newConversation): its conversation
   * ends as when it hands over to itself (it stays in the Sessions tab), and a new one starts on the task, with no
   * handover. The caller has checked it is idle; refused while Combwork is typing into it or its CLI hasn't taken a prompt
   * Combwork typed (ending it would lose that prompt). Nothing awaits before the stop, so the caller's checks still hold.
   * `allowed` throws if the caller may no longer have it (the Assistant's Control or session): checked before the stop,
   * after it, and just before the new launch spawns. `purpose` (#1434): where the new conversation has the agent work, as
   * a start's (#1443: a pooled reviewer's review, in the project folder, whatever slot it builds in).
   */
  async newConversation(projectPath: string, agentId: string, prompt: string, allowed?: () => void, purpose?: FolderPurpose): Promise<LiveSessionState> {
    projectPath = workspace.assertProject(projectPath)
    const now = this.agentNow(projectPath, agentId)
    // Never for an agent Combwork keeps out of (HI-2670): the task would be typed into it.
    const out = this.keepsOut(projectPath, agentId)
    if (out) throw combworkError(out === 'independent' ? M.independentNoTask : M.plainNoTask, { agent: this.liveFor(projectPath, agentId)?.agentName ?? agentId }, { kind: 'conflict' })
    if (!now) throw combworkError(msg({ id: 'session.newConversation.notRunning', defaultMessage: "It isn't running.", description: 'Giving an agent a task in a new conversation is refused: it isn\'t running.' }), undefined, { kind: 'conflict' })
    if (now.pending || this.delivering.has(this.key(projectPath, agentId))) throw combworkError(msg({ id: 'session.newConversation.pending', defaultMessage: 'It has just been given a prompt that its CLI has not taken yet.', description: "Giving an agent a task in a new conversation is refused: a prompt Combwork typed hasn't been taken yet." }), undefined, { kind: 'conflict' })
    allowed?.()
    if (!(await this.endConversation(projectPath, agentId))) throw combworkError(msg({ id: 'session.newConversation.didntStop', defaultMessage: "It didn't stop, so no new conversation was started.", description: "Giving an agent a task in a new conversation failed: it didn't stop." }), undefined, { kind: 'conflict' })
    allowed?.()
    return this.start(projectPath, { agentId, prompt, allowed, ...(purpose ? { purpose } : {}) })
  }

  /**
   * Start Fresh (#1437): an idle running agent's conversation ended (it stays in the Sessions tab) and a new one started,
   * where its new conversations start (agentFolders.ts): null, or why not. `whyNot` (freshStarts.ts) says why it isn't
   * idle now; it is asked, and Combwork typing into it checked, just before the stop with no wait between them
   * (stopWhereAndWait marks the run stopping before its first wait), so the run stopped is the idle one checked.
   */
  async startFresh<W extends string>(projectPath: string, agentId: string, whyNot: () => W | null): Promise<W | 'pending' | null> {
    projectPath = workspace.assertProject(projectPath)
    const why = this.delivering.has(this.key(projectPath, agentId)) ? 'pending' : whyNot()
    if (why) return why
    if (!(await this.endConversation(projectPath, agentId))) throw combworkError(msg({ id: 'session.newConversation.didntStop', defaultMessage: "It didn't stop, so no new conversation was started.", description: "Giving an agent a task in a new conversation failed: it didn't stop." }), undefined, { kind: 'conflict' })
    await this.start(projectPath, { agentId })
    return null
  }

  /** Stops a running agent to end its conversation (kept in the Sessions tab): whether it has stopped. */
  private async endConversation(projectPath: string, agentId: string): Promise<boolean> {
    await this.stopWhereAndWait((s) => s.projectPath.toLowerCase() === projectPath.toLowerCase() && (s as { agentId?: string }).agentId === agentId, 15_000)
    return !this.live.has(liveId(projectPath, agentId))
  }

  /** Turns a running agent's Plan mode on or off (providers where it is a toggle, e.g. Codex's Shift+Tab). */
  async setPlanMode(projectPath: string, agentId: string, on: boolean): Promise<void> {
    projectPath = workspace.assertSessionHost(projectPath)
    const l = this.live.get(liveId(projectPath, agentId))
    if (!l || l.state.settingUp) throw combworkError(M.noSession, undefined, { kind: 'conflict' })
    if (!l.adapter.planToggleKey) throw combworkError(msg({ id: 'session.plan.noToggle', defaultMessage: '{provider} has no Plan mode toggle.', description: "Turning Plan mode on or off is refused: the coding agent has no such toggle. {provider} is its name." }), { provider: l.adapter.descriptor.name }, { kind: 'invalid' })
    if (l.state.status === 'waiting') throw combworkError(msg({ id: 'session.plan.asking', defaultMessage: 'The agent is asking you something. Answer it first.', description: 'Turning Plan mode on or off is refused: the agent waits for the user.' }), undefined, { kind: 'conflict' })
    if (!!l.state.planMode === on) return
    // Not into a line Combwork is typing (#649: the composer is reserved meanwhile).
    if (this.delivering.has(this.key(projectPath, agentId))) throw combworkError(msg({ id: 'session.plan.typing', defaultMessage: 'Combwork is typing a line into this agent. Try again in a moment.', description: 'Turning Plan mode on or off is refused for a moment: Combwork is typing into the terminal.' }), undefined, { kind: 'conflict' })
    writePty(this.key(projectPath, agentId), l.adapter.planToggleKey)
    l.state.planMode = on
    this.emitState(l.state)
  }

  /** Stops the agent and resumes the same conversation in another permission mode. */
  async restartInMode(projectPath: string, agentId: string, mode: PermissionMode): Promise<void> {
    projectPath = workspace.assertSessionHost(projectPath)
    if (workspace.isAssistantHome(projectPath) && isCliOwnMode(mode)) throw combworkError(M.assistantCliOwn, undefined, { kind: 'conflict' })
    const id = liveId(projectPath, agentId)
    const l = this.live.get(id)
    if (!l) throw combworkError(M.noSession, undefined, { kind: 'conflict' })
    const { sessionId, sessionName } = l.state
    // A session nobody has typed in yet has no conversation (its transcript, if any, holds no messages,
    // and the CLI answers "no conversation found" to --resume): start a new one in the mode instead.
    const usage = sessionId ? await this.usage(projectPath, sessionId).catch(() => null) : null
    const resumable = !!sessionId && (usage?.userMessages ?? 0) > 0
    const previous = this.exitWaiters.get(id)
    const exited = new Promise<void>((res) =>
      this.exitWaiters.set(id, () => {
        previous?.()
        res()
      })
    )
    this.stop(projectPath, agentId)
    // Its exit, waited for as long as its CLI's own way of ending may take (stopWaitMs, as stopping waits), never a
    // fixed 8 s a slow CLI outlasts (HI-1869). Exited, its slot's writer release is under way, and the start below waits
    // for it (placeFor's earlierWritersSettled, HI-1867), refused only if its processes are kept or not known to end.
    let timer: NodeJS.Timeout | undefined
    await Promise.race([exited, new Promise((r) => (timer = setTimeout(r, stopWaitMs(8000, [l.adapter.exitKeys?.graceMs]))))])
    clearTimeout(timer)
    // Still running: said so, rather than the start's "already running" (its old run keeps its slot meanwhile).
    if (this.live.get(id)?.state.runId === l.state.runId) throw combworkError(msg({ id: 'session.restartMode.didntStop', defaultMessage: "{agent} didn't stop in time, so it wasn't restarted in the new mode. Try again once it has stopped.", description: "Switching a running agent's permission mode (it restarts in the new mode) is refused: the agent ({agent}, its name) was told to stop but hadn't ended yet, so nothing was started." }), { agent: l.state.agentName ?? agentId }, { kind: 'conflict' })
    await this.start(projectPath, { resumeId: resumable ? sessionId : undefined, name: sessionName, agentId, permissionMode: mode })
  }

  // A changed mode setting applies to new sessions; for running ones, Combwork offers to switch them now.
  private modeOffers = new Map<string, { id: string; label: string; mode: string; value: PermissionMode }>()
  private modeOfferTimer: NodeJS.Timeout | null = null
  /**
   * Switch Now's offers (HI-2320): each running agent it named and the mode it offered that agent (HR2's round 2: its
   * settings' generation). Gone with the last of them, or superseded by a newer offer for one of them.
   */
  private modeOfferAgents = new Map<string, Map<string, PermissionMode>>()
  private modeOfferSeq = 0

  /** An agent's session ended: a Switch Now offer left with none of its agents running no longer applies (HI-2320). */
  private modeOfferGone(id: string): void {
    for (const [offer, ids] of this.modeOfferAgents) {
      if (!ids.delete(id) || ids.size) continue
      this.modeOfferAgents.delete(offer)
      resolveOffer(offer, tr(OUTCOME.modesNextSession))
    }
  }

  /**
   * Switch Now, from its notice (HI-2320): only an offer still open, only the agents it named, and only into the mode it
   * named for each (HR2's rounds 1 and 2). Settings changed since (another mode for one of them): nothing is switched,
   * and the notice says so. Checked again at the switch itself (applyModeSettings).
   */
  async applyModeOffer(offer: string): Promise<{ switched: string[]; skipped: string[] }> {
    const offered = this.modeOfferAgents.get(offer)
    if (!offered) {
      resolveOffer(offer, tr(OUTCOME.modesNothing))
      return { switched: [], skipped: [] }
    }
    for (const [id, mode] of offered) {
      const l = this.live.get(id)
      if (!l) continue
      const { agent } = await this.agentDef(l.state.projectPath, l.state.agentId).catch(() => ({ agent: null }))
      const now = agent ? (await this.effective(l.state.projectPath, pinProvider(agent, l.state.provider))).permissionMode : null
      if (now !== mode) {
        this.modeOfferAgents.delete(offer)
        resolveOffer(offer, tr(OUTCOME.modesChanged))
        return { switched: [], skipped: [] }
      }
    }
    if (!this.modeOfferAgents.has(offer)) return { switched: [], skipped: [] }
    const r = await this.applyModeSettings(offered)
    this.modeOfferAgents.delete(offer)
    const text = r.switched.length || r.skipped.length ? [...r.switched, ...r.skipped].join('\n') : tr(OUTCOME.modesNothing)
    resolveOffer(offer, text)
    return r
  }

  private noticeModeSetting(l: LiveSession, mode: PermissionMode | null): void {
    if (!mode || l.configuredMode === undefined || mode === l.configuredMode || mode === l.offeredMode) return
    if (mode === l.state.permissionMode) {
      // Already in it (switched by hand): nothing to offer.
      l.configuredMode = mode
      return
    }
    l.offeredMode = mode
    this.modeOffers.set(liveId(l.state.projectPath, l.state.agentId), { id: liveId(l.state.projectPath, l.state.agentId), label: this.label(l.state), mode: permissionLabel(l.state.provider, mode, tr), value: mode })
    if (this.modeOfferTimer) clearTimeout(this.modeOfferTimer)
    this.modeOfferTimer = setTimeout(() => {
      this.modeOfferTimer = null
      const offers = [...this.modeOffers.values()]
      this.modeOffers.clear()
      if (!offers.length) return
      const modes = [...new Set(offers.map((o) => o.mode))]
      // Its offer (HI-2320): live while one of the agents it names still runs this session, each with the mode offered
      // it. A newer offer for one of them supersedes an older one (HR2's round 2): the settings changed since.
      for (const [older, ids] of [...this.modeOfferAgents]) {
        if (!offers.some((o) => ids.has(o.id))) continue
        this.modeOfferAgents.delete(older)
        resolveOffer(older, tr(OUTCOME.modesChanged))
      }
      const offer = `modes:${++this.modeOfferSeq}`
      this.modeOfferAgents.set(offer, new Map(offers.map((o) => [o.id, o.value])))
      toast(
        'info',
        tr(msg({ id: 'session.modeOffer.title', defaultMessage: 'Permission mode changed to {modes}', description: "A notice's title: the permission mode in Settings changed for running agents. {modes} is the new mode's name (several joined by \" / \")." }), { modes: modes.join(' / ') }),
        offers.length === 1
          ? tr(msg({ id: 'session.modeOffer.one', defaultMessage: 'Switch {agent} now? Otherwise the new mode applies from its next session.', description: 'The notice that the permission mode setting changed for a running agent. {agent} is the agent.' }), { agent: offers[0].label })
          : tr(msg({ id: 'session.modeOffer.many', defaultMessage: '{n, plural, other {Switch # running agents ({agents}) now? Otherwise the new mode applies from their next session.}}', description: 'The notice that the permission mode setting changed for running agents. {n} is how many (2 or more), {agents} lists them.' }), { n: offers.length, agents: offers.map((o) => o.label).join(', ') }),
        [{ label: tr(msg({ id: 'session.modeOffer.switch', defaultMessage: 'Switch Now', description: "A notice's button: switches the running agents to the new permission mode now." })), command: 'session.applyPermissionModes', args: [offer] }],
        undefined,
        undefined,
        { offer }
      )
    }, 400)
  }

  /**
   * "Switch Now": moves every running agent whose settings now say another mode into that mode. The switches run side
   * by side (at most MODE_SWITCHES_AT_ONCE), each in its own terminal: one waiting for the user's answer to its CLI's
   * own question (Codex's Full Access warning, up to 10 minutes: #1024) doesn't hold up the others. Reported in the
   * agents' order once all have ended.
   */
  async applyModeSettings(only?: ReadonlyMap<string, PermissionMode>): Promise<{ switched: string[]; skipped: string[] }> {
    const todo: { l: LiveSession; mode: PermissionMode }[] = []
    for (const l of [...this.live.values()]) {
      const st = l.state
      if (only && !only.has(liveId(st.projectPath, st.agentId))) continue
      // Still launching: it starts in what the settings say now.
      if (st.settingUp || l.configuredMode === undefined) continue
      const { agent } = await this.agentDef(st.projectPath, st.agentId).catch(() => ({ agent: null }))
      if (!agent) continue
      const mode = (await this.effective(st.projectPath, pinProvider(agent, st.provider))).permissionMode
      if (!mode || mode === l.configuredMode) continue
      // From a notice: only into the mode it named for this agent (the settings changed since: not this one).
      if (only && only.get(liveId(st.projectPath, st.agentId)) !== mode) continue
      l.configuredMode = mode
      if (mode !== st.permissionMode) todo.push({ l, mode })
    }
    const results: { switched?: string; skipped?: string }[] = []
    const one = async (i: number): Promise<void> => {
      const { l, mode } = todo[i]
      const st = l.state
      // Queued, its session may have stopped or been replaced (a restart) meanwhile: the switch was for this session, and
      // never goes into another. setPermissionMode takes the session it switches before its first await.
      if (this.live.get(liveId(st.projectPath, st.agentId)) !== l) {
        results[i] = { skipped: `${this.label(st)}: ${tr(M.switchEnded, { mode: permissionLabel(st.provider, mode, tr) })}` }
        return
      }
      try {
        const r = await this.setPermissionMode(st.projectPath, st.agentId, mode)
        results[i] = r.ok ? { switched: `${this.label(st)} → ${permissionLabel(st.provider, mode, tr)}` } : { skipped: `${this.label(st)}: ${r.message}` }
      } catch (e) {
        results[i] = { skipped: `${this.label(st)}: ${shownError(e)}` }
      }
    }
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < todo.length) await one(next++)
    }
    await Promise.all(Array.from({ length: Math.min(MODE_SWITCHES_AT_ONCE, todo.length) }, worker))
    return { switched: results.flatMap((r) => r.switched ?? []), skipped: results.flatMap((r) => r.skipped ?? []) }
  }

  /** Stops the CLI's background job holding a conversation, then resumes the conversation in this agent. */
  async stopBackgroundAndResume(projectPath: string, agentId: string, jobId: string, sessionId: string, fromOffer?: string): Promise<void> {
    projectPath = workspace.assertSessionHost(projectPath)
    // Checked again (HI-2320, HR2's round 1): from its notice, only while that notice's offer (this job, this
    // conversation) is still open; and never while the agent runs, the conversation already open here again or another.
    const offer = `bg:${liveId(projectPath, agentId)}#${jobId}#${sessionId}`
    if (fromOffer !== undefined && (fromOffer !== offer || !offerOpen(offer))) return
    if (this.bgSettling.has(offer)) return
    /**
     * Whether it may still go on (HR2's round 2, checked again after each wait before stopping or starting anything): its
     * notice's offer, when it came from one, still open; and the agent not running (its conversation open here again, or
     * another), which resolves the notice instead.
     */
    const stillApplies = (): boolean => {
      if (fromOffer !== undefined && !offerOpen(offer)) return false
      const running = this.live.get(liveId(projectPath, agentId))
      if (!running) return true
      resolveOffer(offer, tr(running.state.sessionId === sessionId ? OUTCOME.openHereAgain : OUTCOME.runsAnother))
      return false
    }
    if (!stillApplies()) return
    this.bgSettling.add(offer)
    try {
      const { agent } = await this.agentDef(projectPath, agentId)
      const rec = (await workspace.sessionsFile(projectPath)).sessions.find((s) => s.id === sessionId)
      const adapter = providerAdapter((await this.resumeProvider(projectPath, sessionId, rec)) ?? agentProvider(agent, config.settings))
      if (!stillApplies()) return
      const info = providerService.info(adapter.id)
      if (!adapter.stopBackgroundJob || !info.path) throw combworkError(msg({ id: 'session.background.cantStop', defaultMessage: "{provider} can't stop background sessions.", description: "Stop It and Resume is refused: the coding agent can't stop its background service's job. {provider} is its name." }), { provider: adapter.descriptor.name }, { kind: 'invalid' })
      await adapter.stopBackgroundJob(info.path, jobId)
      // The job lets go of the conversation as it exits.
      await new Promise((r) => setTimeout(r, 1500))
      if (!stillApplies()) return
      await this.start(projectPath, { agentId, resumeId: sessionId })
      resolveOffer(offer, tr(OUTCOME.stoppedAndResumed))
    } finally {
      this.bgSettling.delete(offer)
    }
  }

  /** Stop It and Resume offers whose own action runs now: its outcome says what happened, not the agent starting (HI-2320). */
  private bgSettling = new Set<string>()

  /** Sessions that would be interrupted by quitting: an agent is working or waiting on a prompt. */
  busyStates(): LiveSessionState[] {
    // A watching agent is in the middle of its work (waiting on cards it will carry on with): busy too.
    return this.liveStates().filter((s) => s.status === 'working' || s.status === 'waiting' || s.status === 'background' || s.status === 'watching')
  }

  private async onExit(projectPath: string, agentId: string, runId: string, code: number, output = ''): Promise<void> {
    // What notices offered about this run no longer applies (HI-2320): its conversation ended here.
    resolveOffers((o) => o.startsWith(`transcript:${liveId(projectPath, agentId)}#`), tr(OUTCOME.conversationEnded))
    this.modeOfferGone(liveId(projectPath, agentId))
    // When and how it ended, as it ended (HR5's HI-1881 round 1): not after the bookkeeping below, which can take a
    // while (the time would drift, and a quit begun meanwhile would relabel it).
    const exitAt = new Date().toISOString()
    const shutting = this.shuttingDown
    const atExit = this.live.get(liveId(projectPath, agentId))
    const stopAsked = !!atExit?.stopRequested
    const causeAtExit = atExit?.stopCause
    const id = liveId(projectPath, agentId)
    const l = this.live.get(id)
    const sessionId = l?.state.sessionId ?? ''
    // The CLI refused to open a conversation it is running as a background job (e.g. Claude Code's agent view):
    // say so, and offer to stop that job and resume here.
    const job = l && !l.stopRequested && sessionId ? l.adapter.backgroundJobIn?.(output) : null
    if (l && job) {
      toast(
        'warning',
        tr(msg({ id: 'session.background.title', defaultMessage: '{agent}: the session is running in the background', description: "A notice's title: the coding agent runs this conversation as a background job, so Combwork can't open it. {agent} is the agent." }), { agent: this.label(l.state) }),
        tr(msg({ id: 'session.background.body', defaultMessage: "{provider} moved this conversation into its background service (job {job}), so it can't be opened here until that job is stopped. The conversation is kept.", description: "The notice that a conversation runs as a background job. {provider} is the coding agent's name, {job} the job's id." }), { provider: l.adapter.descriptor.name, job }),
        [{ label: tr(msg({ id: 'session.background.stopAndResume', defaultMessage: 'Stop It and Resume', description: "A notice's button: stops the coding agent's background job, then resumes the conversation in the agent." })), command: 'session.stopBackgroundAndResume', args: [projectPath, agentId, job, sessionId, `bg:${id}#${job}#${sessionId}`] }],
        projectPath,
        { kind: 'agent', projectPath, agentId, name: this.label(l.state), project: basename(projectPath) },
        { offer: `bg:${id}#${job}#${sessionId}` }
      )
    }
    // Exited before its session started, and nobody stopped it: a failed start, whose reason the pane shows.
    const failure: StartFailure | undefined = l
      ? failedStart(
          { status: l.state.status, settingUp: l.state.settingUp, stopRequested: !!l.stopRequested || this.shuttingDown, backgroundJob: !!job, resumed: !!l.resumed },
          code,
          output,
          { name: l.adapter.descriptor.name, startHint: l.adapter.startHint?.bind(l.adapter) }
        )
      : undefined
    if (failure) {
      log.warn(`${userText(this.label(l!.state))}: exited with code ${code} before it started: ${userText(failure.reason.replace(/\n/g, ' | '))}`)
      // A card's stall says why (HI-1976).
      startFailed(projectPath, agentId, failure.reason)
    }
    if (l) {
      if (l.backupTimer) clearInterval(l.backupTimer)
      l.compacting?.end()
      this.cancelIdleGrace(l)
      await this.backup(projectPath, agentId, true).catch(() => undefined)
      // Its CLI has exited: its transcript is finished (archiving it at once is fine, inUse).
      this.noteExit(l.state.sessionId)
      this.live.delete(id)
      this.recheckTools(id)
      // The last of Combwork's sessions in its folder: Combwork's skill copies there go, as Settings → Advanced says (#1431). Not
      // as Combwork quits: the next start's sweep does it, unless sessions resume there first.
      if (!this.shuttingDown && !this.runningIn(l.state.cwd)) void sessionEnded(projectPath, l.state.cwd)
      // Its hooks missing were this launch's (#1336): its lanes go on (a stopped agent is the lane's own business).
      if (l.state.hooksMissing) noteHooksMissing(projectPath, agentId, false)
    }
    this.runs.delete(runId)
    // Its slot's writer released once its processes are known to have ended (#1434).
    this.settleWriterOf(runId)
    // Its hook token ends with it: hooks of an ended launch were ignored anyway (findLaunch).
    endHookToken(runId)
    this.releaseLocks(id)
    // Even when its workspace has just closed.
    if (basename(projectPath) === ASSISTANT_DIR) this.onAssistantExit(projectPath)
    else endAgentToken(projectPath, agentId, runId)
    this.launchEnded(projectPath, agentId, runId)
    void this.afterLaunch(runId, l ? this.label(l.state) : basename(projectPath))
    if (sessionId) {
      if (await this.anyTranscript(projectPath, sessionId)) {
        await workspace.upsertSession(projectPath, { id: sessionId, lastActiveAt: new Date().toISOString() }).catch(() => undefined)
        // Its transcript is finished: what it used goes into the usage history now (#1106), and its backup is compressed (#1110).
        usageHistory.sessionEnded(projectPath, sessionId)
        void this.compressBackups(projectPath, sessionId)
      } else {
        // Nothing was ever said (e.g. closed at the login screen) — there is nothing to resume.
        await workspace
          .mutateSessions(projectPath, (f) => {
            f.sessions = f.sessions.filter((s) => s.id !== sessionId)
          })
          .catch(() => undefined)
      }
    }
    // Why and when it ended, for its pane (HI-1881): none for a launch that failed (its failed bar says so).
    const why = l ? endReason({ failed: !!failure, shuttingDown: shutting, stopRequested: stopAsked, cause: causeAtExit, code }) : null
    const ended: SessionEnd | undefined = l && why ? { runId, startedAt: l.state.startedAt, at: exitAt, why, ...(why === 'crashed' ? { code } : {}) } : undefined
    emit({ type: 'session-exit', projectPath, agentId, sessionId, exitCode: code, ...(failure ? { failure } : {}), ...(ended ? { ended } : {}) })
    // i18n-ignore: the developer console's event data, recorded like a log, stays English (#1104)
    devConsole.capture([sessionSourceId(projectPath, agentId)], () => ({ kind: 'exit', name: 'exit', provider: l?.state.provider, raw: { exitCode: code }, made: { failedStart: !!failure, stopRequested: !!l?.stopRequested }, summary: `exited with code ${code}${failure ? ' before it started' : ''}` }))
    this.exitWaiters.get(id)?.()
    this.exitWaiters.delete(id)
    emit({
      type: 'session-status',
      state: { provider: l?.state.provider ?? '', runId, projectPath, agentId, cwd: l?.state.cwd ?? projectPath, sessionId, status: 'stopped', runtime: { lifecycle: 'stopped', maintenance: null, attention: null, composer: 'free' }, startedAt: l?.state.startedAt ?? '', launchSignature: '', unseen: false }
    })
    workspaceOf(projectPath).scheduleRefresh()
  }

  /**
   * What a launch's gate is told (#507): its command runs once its processes are tracked. One that can't be tracked
   * runs anyway, untracked, and Combwork says so (once); only one stopped while it was being tracked doesn't.
   */
  private launchWord(r: TrackResult): GateWord {
    if (r.tracked) return { go: true }
    // The gate's script prints its reason in English (launchGate.ts).
    if (r.reason === STOPPED_BEFORE_START) return { go: false, reason: r.reason }
    // agent-text: trackLaunch
    this.untracked(r.text ?? r.reason)
    return { go: true }
  }

  /** Whether a launch can go through its gate, its processes tracked (#507); when not, said once (untracked). */
  private async trackingReady(): Promise<boolean> {
    const ok = await trackingReady()
    // agent-text: trackingProblemText
    if (!ok && process.platform === 'win32') this.untracked(trackingProblemText())
    return ok
  }

  /** Agents' processes can't be tracked (#507): said once a Combwork run (noteUntracked); agents start all the same. */
  private untracked(reason: TextPart | null): void {
    noteUntracked(reason)
  }

  /**
   * A launch's CLI has exited: what it left running (#507) is ended, as Settings → Agents says, or offered to the user
   * to end; the agent's pane header lists it meanwhile. Quitting Combwork asks about every agent's at once instead.
   */
  private async afterLaunch(runId: string, label: string): Promise<void> {
    let left = await launchEnded(runId)
    if (!left) return
    // Those it couldn't end stay listed, and are offered as below.
    let failed = false
    if (config.settings.agents.leftoverProcesses === 'end') {
      try {
        await settleLeftovers(left.projectPath, left.agentId, 'end')
        return
      } catch {
        failed = true
        left = leftoversOf(left.projectPath, left.agentId)
      }
    }
    if (this.shuttingDown) return
    const n = left.processes.length + left.more
    if (!n) return
    const summary = leftoversSummary(left, undefined, { tr, list: fmt.list })
    // Its buttons act on exactly what it lists (HI-2320): a newer launch's leftovers are another offer.
    const offer = leftoversOffer(left.projectPath, left.agentId)
    toast(
      'warning',
      tr(msg({ id: 'session.leftovers.title', defaultMessage: '{agent} left {processes} running', description: "A notice's title: an agent's processes still run after it stopped. {agent} is the agent; {processes} how many (\"2 processes\")." }), { agent: label, processes: processCount(n, tr) }),
      failed
        ? tr(msg({ id: 'session.leftovers.notEndedBody', defaultMessage: "{processes}. {n, plural, one {It was started by the agent and may hold the project's folder or ports. Combwork couldn't end it by itself.} other {They were started by the agent and may hold the project's folder or ports. Combwork couldn't end them by itself.}}", description: "The notice of processes an agent left running, which Combwork tried to end and couldn't. {processes} lists them (\"node serve.js, 4 × tail -f …\"); {n} is how many." }), { processes: summary, n })
        : tr(msg({ id: 'session.leftovers.body', defaultMessage: "{processes}. {n, plural, one {It was started by the agent and may hold the project's folder or ports.} other {They were started by the agent and may hold the project's folder or ports.}}", description: "The notice of processes an agent left running. {processes} lists them (\"node serve.js, 4 × tail -f …\"); {n} is how many." }), { processes: summary, n }),
      [
        { label: tr(msg({ id: 'session.leftovers.end', defaultMessage: 'End Them', description: "A notice's button: ends the processes the agent left running." })), command: 'session.settleLeftovers', args: [left.projectPath, left.agentId, 'end', offer] },
        { label: tr(msg({ id: 'session.leftovers.keep', defaultMessage: 'Keep Running', description: "A notice's button: keeps the processes the agent left running, and stops listing them." })), command: 'session.settleLeftovers', args: [left.projectPath, left.agentId, 'keep', offer] }
      ],
      left.projectPath,
      { kind: 'agent', projectPath: left.projectPath, agentId: left.agentId, name: label, project: basename(left.projectPath) },
      { offer }
    )
  }

  /** The running session's transcript, once the provider has written one. */
  private async liveTranscript(l: LiveSession): Promise<string | null> {
    if (!l.state.sessionId) return null
    if (l.transcriptPath && existsSync(l.transcriptPath)) return l.transcriptPath
    const t = await l.adapter.transcriptPath(l.state.cwd, l.state.sessionId, l.transcriptPath)
    if (t) l.transcriptPath = t
    return t
  }

  /**
   * Windows is shutting down or signing out: backs up every running session's transcript before returning, as its
   * callbacks don't wait for a Promise. Only the bytes: usage, details and cost wait for the next start. Best effort
   * within `budgetMs` in all (syncCopyNow says how closely): `incomplete` ran out of time part way, `skipped` were
   * not tried (no transcript found yet, or no time left). Their backups are as of the last ordinary one, or a little
   * further.
   */
  backupAllNow(budgetMs: number): { saved: number; incomplete: number; skipped: number; failed: number } {
    const done = { saved: 0, incomplete: 0, skipped: 0, failed: 0 }
    if (!config.settings.sessions.backupTranscripts) return done
    const deadline = Date.now() + budgetMs
    for (const l of this.live.values()) {
      const src = l.transcriptPath
      if (!l.state.sessionId || !src || Date.now() >= deadline) {
        done.skipped++
        continue
      }
      try {
        if (syncCopyNow(src, this.backupPath(l.state.projectPath, l.state.sessionId), deadline)) {
          l.lastBackupAt = Date.now()
          done.saved++
        } else done.incomplete++
      } catch (e) {
        log.warn('backup at shutdown failed', e)
        done.failed++
      }
    }
    return done
  }

  /** After the PC wakes up: read each running session's transcript again (usage, background tasks, plan usage) and report its state. */
  refreshAfterResume(): void {
    for (const l of this.live.values()) {
      void this.backup(l.state.projectPath, l.state.agentId, true)
        .catch(() => undefined)
        .finally(() => this.emitState(l.state))
    }
  }

  /** Copies the live transcript into <project>/.combwork/sessions so it survives the CLI's own cleanup (backupNow), each look kept on the session until it ends (LiveSession.looks). */
  private backup(projectPath: string, agentId: string, force = false, hooksBefore?: number): Promise<void> {
    const l = this.live.get(liveId(projectPath, agentId))
    if (!l) return Promise.resolve()
    const run = this.backupNow(l, projectPath, agentId, force, hooksBefore)
    const looks = (l.looks ??= new Set())
    looks.add(run)
    const done = (): void => void looks.delete(run)
    void run.then(done, done)
    return run
  }

  private async backupNow(l: LiveSession, projectPath: string, agentId: string, force: boolean, hooksBefore?: number): Promise<void> {
    // Tasks that expire or run past the limit end without a word in the transcript.
    this.settleBackground(l, false)
    const sessionId = l.state.sessionId
    const src = await this.liveTranscript(l)
    if (!src) return
    // The hooks so far, for the transcript as it is now (readDetails); a switch's, those before the prompt that switched.
    const hooks = hooksBefore ?? l.hooksSeen ?? 0
    const s = await stat(src).catch(() => null)
    if (!s) return
    this.noteTranscriptSize(l, s.size)
    // The size too: Windows can report a file's old modified time while another process keeps appending to it.
    const mtime = `${s.mtimeMs}:${s.size}`
    const backups = config.settings.sessions.backupTranscripts
    // Nothing new, and the backup (if any) has everything: nothing to do.
    if (!force && l.transcriptMtime === mtime && (!backups || l.backupMtime === mtime)) return
    if (force || l.transcriptMtime !== mtime) await this.transcriptChanged(l, projectPath, agentId, src, s.size, force, hooks)
    l.transcriptMtime = mtime
    if (!backups) return
    // While the agent works, at most once a minute (a change held back is copied at a later look); the end of each
    // turn (Stop) and the session's exit force one, so nothing is left out. Only what the transcript gained is written.
    if (!force && l.lastBackupAt && Date.now() - l.lastBackupAt < BACKUP_INTERVAL_MS) return
    try {
      await syncCopy(src, this.backupPath(projectPath, sessionId))
      l.lastBackupAt = Date.now()
      l.backupMtime = mtime
    } catch (e) {
      // Tried again at the next look, whether or not the transcript changes.
      log.warn('backup failed', e)
    }
  }

  /** What follows from the live transcript growing: status, usage, details, compaction, cost. */
  private async transcriptChanged(l: LiveSession, projectPath: string, agentId: string, src: string, size: number, force: boolean, hooks: number): Promise<void> {
    const sessionId = l.state.sessionId
    // Fallback if hooks never arrive: a transcript means the session is up. Not a resumed conversation's as it was, there
    // before its CLI started (HI-2816: a held or slow resume showed ready, and deliveries tried to type into it): only
    // what it gained since its size before the spawn.
    const before = l.resumed ? (l.resumedBytes ?? -1) : -1
    if (l.state.status === 'starting' && size > before) {
      this.fact(l.state, { lifecycle: 'running' })
      l.state.status = 'ready'
      this.emitState(l.state)
    }
    // The CLI is heard from: a turn whose state was unknown for its silence isn't silent any more (#648).
    if (l.ledger) {
      heard(l.ledger)
      if (l.state.turn?.state === 'unknown') this.noteTurn(l)
    }
    emit({ type: 'usage-changed', projectPath, sessionId })
    await this.readDetails(l, src, size, hooks)
    await this.readTurns(l, src, size).catch((e) => log.warn(`${userText(this.label(l.state))}: reading its transcript's turns`, e))
    this.settleBackground(l, await this.readBackground(l, src, size))
    await this.readSafeguards(l, src)
    if (l.compacting) {
      // Fallback if the compaction hooks never arrive: a new compaction in the transcript.
      const u = await this.usageFor(l.state.projectPath, src, sessionId, l.state.provider, this.costPolicy(l))
      if (u) l.compacting?.transcript(u.compactions)
    }
    if (l.defaultModel) {
      const usage = await this.usageFor(l.state.projectPath, src, sessionId, l.state.provider, this.costPolicy(l))
      if (usage?.model) {
        providerService.observeDefaultModel(l.state.provider, usage.model)
        l.defaultModel = false
      }
    }
    await this.liveCost(l, src, force)
  }

  /**
   * A live session's cost as the settings say now (#436): the CLI's own report (`reportedCost`, from its status line)
   * for a provider that reports one, unless the user chose their prices; else Combwork's estimate, which re-reads the whole
   * transcript, so at most every 30 seconds while the agent works and at each turn's end (`force`, also after a price
   * change). With the user's prices but none for its model, the CLI's newest report (its status line's, else its
   * transcript's), never recomputed. Without a price or a report the cost is cleared, so it shows as unknown.
   */
  private async liveCost(l: LiveSession, src: string, force: boolean): Promise<void> {
    // On a server connection (HI-1772) the CLI's report prices its server's model as a Claude model: never used, only
    // Combwork's estimate by the real model's id (unpriced unless the user priced it).
    const onServer = !!l.state.launchedConnection?.server
    // Free (HI-1772): only on servers on this PC, the conversation's record says: a known $0, shown as free (local).
    // Shown as its conversation's policy is now, both ways (a /resume into a conversation that ran elsewhere ends it).
    if (!!l.state.costFree !== !!l.costFree) {
      l.state.costFree = l.costFree ? true : undefined
      this.emitState(l.state)
    }
    if (l.costFree) return this.setLiveCost(l, 0, false)
    const own = onServer || usesOwnPrices(l.state.provider, config.settings)
    if (l.adapter.descriptor.capabilities.reportsCost && !own) return this.setLiveCost(l, l.reportedCost, false)
    if (!force && Date.now() - (l.costAt ?? 0) <= COST_INTERVAL_MS) return
    l.costAt = Date.now()
    const usage = await this.usageFor(l.state.projectPath, src, l.state.sessionId, l.state.provider, this.costPolicy(l))
    // The settings changed while it was read: the read they started decides.
    if ((onServer || usesOwnPrices(l.state.provider, config.settings)) !== own || !usage) return
    // An estimate is Combwork's (the user's prices, or a provider that reports none); anything else is the CLI's report.
    // Priced only in part (HI-2675: a model with no price beside priced ones): said with the cost, as "+ ?".
    const part = !!usage.costUnpriced
    if (usage.costUsd != null && usage.costEstimated) this.setLiveCost(l, usage.costUsd, true, part)
    else if (onServer) this.setLiveCost(l, undefined, false)
    else if (own) this.setLiveCost(l, l.reportedCost ?? usage.costUsd ?? undefined, false, l.reportedCost === undefined && part)
    else this.setLiveCost(l, usage.costUsd ?? undefined, false, part)
  }

  private setLiveCost(l: LiveSession, costUsd: number | undefined, estimated: boolean, unpriced = false): void {
    const part = costUsd !== undefined && unpriced
    if (l.state.costUsd === costUsd && !!l.state.costEstimated === estimated && !!l.state.costUnpriced === part) return
    Object.assign(l.state, { costUsd, costEstimated: estimated, costUnpriced: part || undefined })
    this.emitState(l.state)
  }

  /** Prices or the cost source changed (#436): each live session's cost again, at once, idle ones too. */
  async repriceLive(): Promise<void> {
    await Promise.all(
      [...this.live.values()]
        .filter((l) => l.state.sessionId)
        .map((l) =>
          this.liveTranscript(l)
            .then((src) => (src ? this.liveCost(l, src, true) : l.adapter.descriptor.capabilities.reportsCost && !usesOwnPrices(l.state.provider, config.settings) ? this.setLiveCost(l, l.reportedCost, false) : undefined))
            .catch((e) => log.warn('could not price a live session again', e))
        )
    )
  }

  /**
   * Live details from what the provider appended to its transcript since the last look (Codex, Copilot), up to `size`
   * bytes: the transcript when the launch had had `hooks` hooks (hooksSeen).
   */
  private async readDetails(l: LiveSession, path: string, size: number, hooks = l.hooksSeen ?? 0): Promise<void> {
    if (!l.adapter.transcriptDetails) return
    const from = l.detailsOffset ?? 0
    if (size <= from) {
      if (size < from) {
        l.detailsOffset = 0
        l.detailsMemo = undefined
      }
      return
    }
    // The tail is enough: details only ever need the latest records.
    const start = Math.max(from, size - 4 * 1024 * 1024)
    const text = await readSpan(path, start, size)
    if (text === null) return
    const end = text.lastIndexOf('\n')
    if (end < 0) return
    l.detailsOffset = start + Buffer.byteLength(text.slice(0, end + 1))
    const chunk = text.slice(0, end + 1)
    const d = l.adapter.transcriptDetails(chunk, (l.detailsMemo ??= {}))
    devConsole.capture([sessionSourceId(l.state.projectPath, l.state.agentId)], () => transcriptEvent(l.state.provider, chunk, d))
    this.applyDetails(l, d, hooks)
  }

  /**
   * Turns the transcript identifies (#1371, hooks health), from what it gained since the last look, for the check to wait
   * on those no hook names. One reading per conversation and file: this launch's new conversation from its start, any
   * other (resumed, or switched to, or found later) from its end as it is then, so history never counts (nor does a
   * turn whose prompt came before the launch began). Another file (its path, a shrink, its first bytes changed) or
   * conversation starts the reading again, and what it found is let go. Whole lines only; a gap of more than 4 MB
   * forgets what it knew of the turns (one whose prompt it didn't read is unknown, never a turn). What a read found is
   * kept only if the launch, conversation and reading are still the ones it read for.
   */
  private async readTurns(l: LiveSession, path: string, size: number): Promise<void> {
    const w = l.hooksWatch
    const turnsOf = l.adapter.transcriptTurns?.bind(l.adapter)
    // Still its transcript (a hook may have named another file while the look before this read waited): else it isn't read.
    if (!w || !turnsOf || l.transcriptPath !== path) return
    const sessionId = l.state.sessionId
    const prev = l.turnsRead
    const look = await lookAtTurns(prev, { path, sessionId, size, fresh: !l.turnsBegun && !l.resumed }, (start, end) => readSpan(path, start, end))
    // Still this launch, conversation, file and reading (not restarted, switched or read again meanwhile): else what it found goes.
    if (!look || this.live.get(liveId(l.state.projectPath, l.state.agentId)) !== l || l.state.sessionId !== sessionId || l.transcriptPath !== path || l.turnsRead !== prev) return
    l.turnsRead = look.reading
    if (look.restarted) {
      l.turnsBegun = true
      this.turnsReset(l, w)
    }
    if (look.lines && transcriptTurns(w, turnsOf(look.lines, look.reading.memo), Date.now(), Date.parse(l.state.startedAt)) && l.state.hooksMissing?.after === 'transcript') this.hooksBack(l)
  }

  /** What its transcript showed of its turns is let go (#1371), and an alarm that evidence raised goes with it. */
  private turnsReset(l: LiveSession, w: HooksWatch): void {
    if (transcriptReset(w) && l.state.hooksMissing?.after === 'transcript') this.hooksBack(l)
  }

  /**
   * Background tasks started or ended in what the transcript gained since the last look (providers that report
   * them). Only this launch's count: tasks from before it ended with the CLI. True if one ended that wakes the CLI (not
   * one it stopped itself).
   */
  private async readBackground(l: LiveSession, path: string, size: number): Promise<boolean> {
    if (!l.adapter.backgroundTasks) return false
    const from = l.tasksOffset ?? 0
    if (size <= from) {
      if (size < from) {
        l.tasksOffset = 0
        l.tasksMemo = undefined
      }
      return false
    }
    const start = Math.max(from, size - 4 * 1024 * 1024)
    const text = await readSpan(path, start, size)
    if (text === null) return false
    const end = text.lastIndexOf('\n')
    if (end < 0) return false
    l.tasksOffset = start + Buffer.byteLength(text.slice(0, end + 1))
    const since = Date.parse(l.state.startedAt) - 5000
    const tasks = (l.tasks ??= new Map())
    const ended = (l.tasksEnded ??= new Set())
    let woke = false
    for (const ev of l.adapter.backgroundTasks(text.slice(0, end + 1), (l.tasksMemo ??= {}))) {
      if (ev.at < since) continue
      if (ev.kind === 'start') {
        // A start read after its end counts nothing, unless the task starts again (a subagent resumed, #1584).
        if (ev.resumed) ended.delete(ev.id)
        if (!ended.has(ev.id)) tasks.set(ev.id, { at: ev.at, expiresAt: ev.expiresAt, type: ev.type, description: ev.description })
        continue
      }
      // A task the agent stopped itself wakes nothing (#640: read after its Stop, it showed HB3 working with no turn).
      if (tasks.delete(ev.id) && !ev.stopped) woke = true
      ended.add(ev.id)
      if (ended.size > 500) ended.delete(ended.values().next().value!)
    }
    return woke
  }

  /**
   * Safeguard stops and model switches in what the transcript gained since the last look (#606), this launch's only:
   * noted on the agent's state (LiveSessionState.safeguard), and a switch told (a notice, a note on its Doing cards).
   */
  private readSafeguards(l: LiveSession, path: string): Promise<void> {
    // One read at a time (the transcript growing, and a prompt about a stop), so no line is read twice.
    const run = (l.guardReading ?? Promise.resolve()).then(() => this.readSafeguardsNow(l, path))
    l.guardReading = run.catch(() => undefined)
    return run
  }

  private async readSafeguardsNow(l: LiveSession, path: string): Promise<void> {
    if (!l.adapter.safeguards) return
    const size = (await stat(path).catch(() => null))?.size
    if (size === undefined) return
    const from = l.guardOffset ?? 0
    if (size <= from) {
      if (size < from) {
        l.guardOffset = 0
        l.guardMemo = undefined
      }
      return
    }
    // The tail is enough: a stop keeps only the last few tool calls before it.
    const start = Math.max(from, size - 4 * 1024 * 1024)
    const text = await readSpan(path, start, size)
    if (text === null) return
    const end = text.lastIndexOf('\n')
    if (end < 0) return
    l.guardOffset = start + Buffer.byteLength(text.slice(0, end + 1))
    const since = Date.parse(l.state.startedAt) - 5000
    for (const ev of l.adapter.safeguards(text.slice(0, end + 1), (l.guardMemo ??= {}))) if (ev.at >= since) this.noteSafeguard(l, ev)
  }

  /** A safeguard event on the agent's state (noteSafeguard); a switch to another model is told: Combwork's own notice, and a note on its Doing cards. */
  private noteSafeguard(l: LiveSession, ev: SafeguardEvent): void {
    const st = l.state
    if (ev.kind === 'stop' && ev.asked && ev.turn && this.guardSeen(l, ev.turn, 'asked')) {
      // The CLI's record of a stop its prompt showed in this turn: counted then, so only the model it adds.
      if (ev.model && st.safeguard && !st.safeguard.model) {
        st.safeguard = { ...st.safeguard, model: ev.model }
        this.emitState(st)
      }
      return
    }
    const before = st.safeguard
    // HI-2754: a stop no older than the latest prompt hit the latest turn; one read late is history only.
    const next = placeEvent(before, ev, l.promptAt)
    if (!next) return
    st.safeguard = next
    this.emitState(st)
    flightRecorder.safeguard(st, () => this.label(st), ev)
    if (ev.kind !== 'switch' || !next.switched || next.switched.to === before?.switched?.to) return
    const d = l.adapter.descriptor
    const label = this.label(st)
    const { from, to } = next.switched
    this.notify(
      st.projectPath,
      withValues(msg({ id: 'session.notice.safeguardSwitch', defaultMessage: '{agent} now runs on {model}', description: "A notification's title: after its CLI's safety classifier stopped a response, the agent runs on another model. {agent} is the agent, {model} the model's name." }), { agent: label, model: d.modelLabel(to) }),
      safeguardText(next, d.modelLabel, tr),
      'notice',
      undefined,
      st.agentId
    )
    log.info(`${userText(label)}: its model changed after a safeguard stop (${from} → ${to})`)
    // On the card it works on too, so whoever reads the card knows (only the event and tool names, never what was stopped):
    // English for agents, the window's language in the card (#866).
    if (!workspace.isAssistantHome(st.projectPath))
      void commentOnDoingCards(workspaceOf(st.projectPath), st.projectPath, st.agentId, safeguardComment({ ...next, switched: next.switched }, st.agentName ?? st.agentId, d.modelLabel, d.text?.safeguardHelp ?? null)).catch((e) => log.warn('safeguard: could not note the switch on its cards', e))
  }

  /**
   * Whether the CLI's screen shows its prompt about a safeguard stop now (ProviderAdapter.safeguardAsk), for `ask` (the one
   * it waits on, or any blocking ask naming no tool). False when Combwork doesn't read its screen.
   */
  private guardShown(l: LiveSession, ask: Ask = { kind: 'question', blocking: true, message: '' }): boolean {
    const screen = l.adapter.safeguardAsk ? l.screen?.text() : null
    return !!screen && l.adapter.safeguardAsk!(ask, screen)
  }

  /**
   * It waits on a safeguard prompt that may have been answered (#606): typed into since it began, or no longer on its
   * screen. Its CLI sends no hook for the answer; its idle notice, or the screen, then ends the wait (safeguardAnswered).
   */
  private guardAnswerable(l: LiveSession): boolean {
    const st = l.state
    if (!st.safeguard?.prompt || st.status !== 'waiting') return false
    return this.userTypedAt(st.projectPath, st.agentId) >= (l.guardPromptAt ?? 0) || !this.guardShown(l, l.waitingOn ?? undefined)
  }

  /** A blocking ask naming no tool, from a CLI that tells a safeguard prompt by its screen (a permission request its own reviewer decides is none). */
  private guardCandidate(l: LiveSession, ev: HookEvent): ev is Extract<HookEvent, { kind: 'ask' }> {
    if (ev.kind !== 'ask' || !ev.ask.blocking || !l.adapter.safeguardAsk) return false
    return !(ev.ask.kind === 'permission' && l.adapter.descriptor.permissionModes.find((m) => m.value === modeInEffect(l.state))?.reviewed)
  }

  /**
   * The agent waits on its CLI's prompt about a safeguard stop (#606): the stop noted (with the last tool calls its
   * transcript showed: the stop that asked HB3 had no record of its own), and the ask in words that say why, for its
   * status and the notification. Only the event and the tool names.
   */
  private async safeguardPrompt(l: LiveSession, ask: Ask, at: number): Promise<Ask> {
    const st = l.state
    // Its last tool calls as its transcript has them now (the read as it grows may not have come yet).
    const src = await this.liveTranscript(l).catch(() => null)
    if (src) await this.readSafeguards(l, src).catch((e) => log.warn('safeguard: transcript read failed', e))
    // Stopped or started again meanwhile (#650): nothing of it is shown over the agent's current launch.
    if (!this.owns(l)) return ask
    const memo = l.guardMemo
    // The prompt it already waits on, told again (its hook, then the screen): the same stop, not another.
    let noted = st.safeguard
    if (!noted?.prompt) {
      const model = memoModel(memo)
      const turn = memoTurn(memo)
      // Counted unless the CLI's record of it in this turn was read first.
      if (!turn || !this.guardSeen(l, turn, 'screen')) {
        const counted = noteSafeguard(noted, { kind: 'stop', at, model, tools: memoTools(memo) })
        // HI-2754: the prompt on screen is this turn's stop.
        if (counted) noted = latestStop(counted, at, l.promptAt)
      }
      // Kept on the session's record with its turn, so Performance counts it though the transcript may never record it
      // (HB3's didn't), and once if it does (withScreenStops), whenever Combwork reads it.
      if (st.sessionId) {
        const stop: ScreenStop = { at: new Date(at).toISOString(), ...(model ? { model } : {}), ...(turn ? { turn } : {}) }
        await this.keepScreenStop(st.projectPath, st.sessionId, stop).catch((e) => log.warn('safeguard: could not keep the stop seen on screen', e))
      }
      if (!this.owns(l)) return ask
    }
    const { idle: _i, ...rest } = noted!
    st.safeguard = { ...rest, prompt: true }
    l.guardPromptAt = at
    const tools = st.safeguard.tools
    this.emitState(st)
    const provider = l.adapter.descriptor.name
    const text = tools.length
      ? withValues(msg({ id: 'session.status.safeguardAsksTools', defaultMessage: 'A safety classifier stopped a response: {provider} asks what to do (its last tool calls: {tools})', description: "An agent's status: its CLI's safety classifier stopped a response, and the CLI asks the user what to do. {provider} is the coding agent's name; {tools} the names of its last tool calls, as they came." }), { provider, tools: tools.join(', ') })
      : withValues(msg({ id: 'session.status.safeguardAsks', defaultMessage: 'A safety classifier stopped a response: {provider} asks what to do', description: "An agent's status: its CLI's safety classifier stopped a response, and the CLI asks the user what to do. {provider} is the coding agent's name." }), { provider })
    // agent-stored: agentField says it for each agent where its status is sent (setStatus keeps its text)
    return { ...ask, message: englishText(text), text }
  }

  /** A stop seen only on screen, added to its session's record (SessionRecord.screenStops) for Performance. */
  private async keepScreenStop(projectPath: string, sessionId: string, stop: ScreenStop): Promise<void> {
    await workspace.mutateSessions(projectPath, (f) => {
      const rec = f.sessions.find((s) => s.id === sessionId)
      if (rec) rec.screenStops = [...(rec.screenStops ?? []), stop].slice(-MAX_SCREEN_STOPS)
    })
  }

  /** A stop in `turn` from its prompt on screen or the CLI's record (seenInTurn): true when it was counted already this launch. */
  private guardSeen(l: LiveSession, turn: string, from: 'screen' | 'asked'): boolean {
    return seenInTurn((l.guardTurns ??= new Map()), turn, from)
  }

  /**
   * The CLI's screen was drawn: a safeguard prompt it asked about shows now (the screen drawn after its hook), or the
   * one it waits on is gone after the user typed (#606). In order with the hooks, one check at a time.
   */
  private screenDrawn(id: string, l: LiveSession): void {
    if (l.guardChecking || !(l.guardAsk || (l.state.safeguard?.prompt && l.state.status === 'waiting'))) return
    l.guardChecking = true
    void this.inHookOrder(l.state.runId, async () => {
      l.guardChecking = false
      if (this.live.get(id) !== l) return
      const st = l.state
      const g = l.guardAsk
      if (g) {
        // The screen says within moments; an ask it never shows as a safeguard's is an ordinary one.
        if (Date.now() - g.at > GUARD_ASK_MS) l.guardAsk = undefined
        else if (this.guardShown(l, g.ask)) {
          l.guardAsk = undefined
          if (!g.applied) {
            // The ledger found it stale (asked after its turn's Stop): it is put to the user now, saying why.
            const ev: HookEvent = { kind: 'ask', ask: await this.safeguardPrompt(l, g.ask, g.at) }
            this.carryOut(id, l, hookStep(ev, this.statusInput(l)), 'screen', ev)
          } else if (st.status === 'waiting' && l.waitingOn === g.ask) {
            // Already told it waits: told again, now saying why (a notice, without a second chime).
            const ask = await this.safeguardPrompt(l, g.ask, g.at)
            l.waitingOn = ask
            // agent-text: safeguardPrompt
            setStatus(st, ask.text ?? ask.message)
            this.emitState(st)
            this.notify(st.projectPath, withValues(M.needsInput, { agent: this.label(st) }), ask.text ?? ask.message, 'notice', undefined, st.agentId)
          }
        }
      }
      if (this.guardAnswerable(l) && this.userTypedAt(st.projectPath, st.agentId) >= (l.guardPromptAt ?? 0) && !this.guardShown(l, l.waitingOn ?? undefined)) {
        this.carryOut(id, l, safeguardAnswered(this.statusInput(l)), 'screen')
        log.info(`${userText(this.label(st))}: its safeguard prompt was answered (gone from its screen)`)
      }
    }).catch((e) => log.warn('safeguard: screen check failed', e))
  }

  /**
   * Whether an agent's CLI shows a question of its own on its screen now (HI-1959: Claude Code's offer to teach auto mode
   * about the environment): nothing is typed into it meanwhile, and no Enter pressed, which would answer it.
   */
  cliAsks(projectPath: string, agentId: string): boolean {
    const l = this.live.get(liveId(projectPath, agentId))
    const ask = l?.adapter?.idleQuestion?.bind(l.adapter)
    const screen = ask ? l!.screen?.text() : null
    return !!screen && !!ask!(screen)
  }

  /**
   * The CLI's screen was drawn, for its question by itself and a held line it took (HI-1959): looked at while the agent
   * is between turns, waits on that question, or holds a line, one look at a time and in order with the hooks.
   */
  private idleScreenDrawn(id: string, l: LiveSession): void {
    if (!l.adapter.idleQuestion || !l.screen || l.idleChecking) return
    const st = l.state
    if (!l.idleAsk && !st.untakenLine && !AT_PROMPT.has(st.status)) return
    l.idleChecking = true
    void this.inHookOrder(st.runId, () => {
      l.idleChecking = false
      if (this.live.get(id) === l) this.lookAtIdleScreen(id, l)
    }).catch((e) => log.warn('idle question: screen check failed', e))
  }

  /**
   * Its CLI's question by itself (HI-1959), which sends no hook: on its screen between turns, the agent waits for the user
   * with it, as for any question (For you, a notification, the Assistant's wake); gone, it is idle again. Then the held
   * line, if any.
   */
  private lookAtIdleScreen(id: string, l: LiveSession): void {
    const st = l.state
    if (!l.adapter.idleQuestion || !l.screen) return
    const question = l.adapter.idleQuestion(l.screen.text())
    if (question && !l.idleAsk && AT_PROMPT.has(st.status)) {
      const text = withValues(msg({ id: 'session.status.cliAsks', defaultMessage: '{provider} asks: {question}', description: "An agent's status: its coding agent ({provider}, e.g. Claude Code) shows a question of its own on its screen and waits for the user to answer it there. {question} is the question, in the coding agent's own words (English)." }), { provider: l.adapter.descriptor.name, question })
      // agent-stored: agentField says it for each agent where its status is sent (setStatus keeps its text)
      const ask: Ask = { kind: 'question', blocking: true, message: englishText(text), text, onScreen: true }
      l.idleAsk = ask
      log.info(`${userText(this.label(st))}: its CLI asks on its screen: ${question}`)
      const ev: HookEvent = { kind: 'ask', ask }
      this.carryOut(id, l, hookStep(ev, this.statusInput(l)), 'screen', ev)
    } else if (!question && l.idleAsk) {
      const ask = l.idleAsk
      l.idleAsk = undefined
      log.info(`${userText(this.label(st))}: its CLI's question is gone from its screen`)
      if (st.status === 'waiting' && l.waitingOn === ask) this.carryOut(id, l, idleQuestionGone(this.statusInput(l)), 'screen')
    }
    this.lookAtHeldLine(id, l, !!question)
  }

  /** One look at a held line (heldLineLost): the agent, its screen with dim hints left out, and what was taken since. */
  private heldLook(l: LiveSession, asked: boolean): boolean {
    return heldLineLost({ asked, input: l.adapter.promptText?.(l.screen!.textWithoutDim()) ?? null, status: l.state.status, takenSince: (l.prompts ?? 0) > (l.untakenPrompts ?? 0) })
  }

  /**
   * A line Combwork typed, held as not taken, gone from the CLI's input since (HI-1959: a screen of the CLI's took it): seen
   * lost, it is looked at again after cw.lostLine.steadySeconds, and any draw meanwhile that says otherwise (a redraw, a
   * dialog, text in the input, a turn) calls that off.
   */
  private lookAtHeldLine(id: string, l: LiveSession, asked: boolean): void {
    const u = l.state.untakenLine
    if (!u || !l.adapter.promptText || !this.heldLook(l, asked)) return this.dropLostLook(l)
    if (l.lostSeen?.since === u.since) return
    this.dropLostLook(l)
    const runId = l.state.runId
    const timer = setTimeout(() => void this.inHookOrder(runId, () => this.lostLineSteady(id, l, u.since)).catch((e) => log.warn('lost line: check failed', e)), advanced.number('cw.lostLine.steadySeconds') * 1000)
    timer.unref?.()
    l.lostSeen = { since: u.since, timer }
  }

  private dropLostLook(l: LiveSession): void {
    if (l.lostSeen) clearTimeout(l.lostSeen.timer)
    l.lostSeen = undefined
  }

  /**
   * The second look at a held line seen lost (HI-1959): the same launch, the same line, and everything said again (no
   * question, its input drawn and empty, between turns, nothing taken). Then the hold goes: the deliveries it rang for are
   * offered again (an unread one is typed again; one read meanwhile isn't), and a line that rang for none is told to the
   * user with its words, never dropped unseen.
   */
  private lostLineSteady(id: string, l: LiveSession, since: string): void {
    if (this.live.get(id) !== l || l.lostSeen?.since !== since) return
    l.lostSeen = undefined
    const st = l.state
    if (st.untakenLine?.since !== since || !l.screen || !l.adapter.promptText) return
    if (!this.heldLook(l, !!l.adapter.idleQuestion?.(l.screen.text()))) return
    const text = l.untakenText ?? st.untakenLine.text
    const rang = [...(l.untakenFor ?? [])]
    this.clearUntaken(l, rang.length ? 'gone from its input, nothing taken: what it rang for is offered again' : 'gone from its input, nothing taken: told to the user') // i18n-ignore: for the log
    // The line it typed is gone, so nothing of it is pending any more (PENDING_MS would hold the next line for it).
    if (l.typed && (l.prompts ?? 0) <= l.typed.prompts) l.typed = undefined
    this.noteComposer(l, this.key(st.projectPath, st.agentId))
    if (rang.length) this.lineLost(st.projectPath, st.agentId, st.runId, rang)
    else this.notify(st.projectPath, withValues(msg({ id: 'session.notice.lineLostTitle', defaultMessage: "{agent} didn't get a line Combwork typed", description: "A notification's title: a line Combwork typed into an agent's terminal (a message, a prompt) was taken by a screen of its coding agent before it was sent, so the agent never got it. {agent} is the agent." }), { agent: this.label(st) }), withValues(msg({ id: 'session.notice.lineLost', defaultMessage: 'A screen of its CLI took it before it was sent. Send it again if it is still wanted: {text}', description: "The notification that a line Combwork typed into an agent was lost (a screen of its coding agent took it). {text} is the line, as Combwork typed it." }), { text }), 'notice', undefined, st.agentId)
  }

  /** Reads the transcript for background tasks now (at a turn's end, before choosing between finished and background). */
  private async refreshBackground(l: LiveSession): Promise<void> {
    const src = await this.liveTranscript(l).catch(() => null)
    const s = src ? await stat(src).catch(() => null) : null
    if (src && s) await this.readBackground(l, src, s.size).catch((e) => log.warn('background tasks: read failed', e))
  }

  /** Drops tasks past their expiry or the time limit and updates the count. True if the limit dropped one. */
  private sweepTasks(l: LiveSession): boolean {
    const minutes = taskMinutes()
    const dropped = l.tasks ? expireTasks(l.tasks, Date.now(), minutes) : []
    for (const id of dropped) log.info(`${userText(this.label(l.state))}: stopped counting background task ${id} after ${minutes} minutes`)
    const had = l.state.backgroundTasks
    l.state.backgroundTasks = l.tasks?.size || undefined
    // When they last ended (HI-1993): a review waiting on them starts its stall clock again from then.
    if (had && !l.state.backgroundTasks) l.state.backgroundEndedAt = new Date().toISOString()
    return dropped.length > 0
  }

  /** The status a turn's end (or an interruption) leaves: background while tasks will start the agent again. */
  private idleStatus(l: LiveSession, idle: 'finished' | 'ready'): SessionStatus {
    return idleAfter({ backgroundWakes: l.adapter.descriptor.capabilities.backgroundWakes, tasks: l.tasks?.size ?? 0 }, idle)
  }

  /**
   * After the background tasks changed: the count, and the status of an agent whose turn has ended. When the last
   * task ends, a CLI that is told starts a new turn (working); one that runs out of time leaves the agent finished.
   */
  private settleBackground(l: LiveSession, woke: boolean): void {
    const st = l.state
    const before = st.backgroundTasks
    const dropped = this.sweepTasks(l)
    let changed = before !== st.backgroundTasks
    if (l.adapter.descriptor.capabilities.backgroundWakes) {
      if (st.status === 'background' && !l.tasks?.size) {
        if (woke) {
          st.status = 'working'
          l.woke = true
        }
        else {
          st.status = 'finished'
          const stopped = dropped ? withValues(msg({ id: 'session.status.tasksDropped', defaultMessage: '{minutes, plural, one {Stopped counting its background tasks after # minute} other {Stopped counting its background tasks after # minutes}}', description: "An agent's status: Combwork stopped counting the background tasks it started after the time limit in Settings. {minutes} is that limit." }), { minutes: taskMinutes() }) : null
          setStatus(st, stopped)
          st.unseen = true
          this.notify(st.projectPath, withValues(M.finished, { agent: this.label(st) }), stopped ?? msg({ id: 'session.notice.tasksEnded', defaultMessage: 'Its background tasks have ended.', description: "The notification that an agent finished once the background tasks it started ended." }), 'finished', st.agentName, st.agentId)
        }
        changed = true
      } else if (st.status === 'finished' && l.tasks?.size) {
        // A task the turn started, read after its end was handled.
        st.status = 'background'
        st.unseen = false
        changed = true
      } else if (woke && st.status === 'background') {
        // One of several ended (subagents a turn started together, #1584): its CLI begins a turn for it while the others
        // run on, so that wake may open a turn too (turnLedger rule 1).
        l.woke = true
      }
    }
    if (changed) this.emitState(st)
  }

  /** Forgets the background tasks (the CLI moved to another conversation, or the session ended). */
  private clearTasks(l: LiveSession): void {
    l.tasks?.clear()
    l.tasksEnded?.clear()
    l.tasksOffset = 0
    l.tasksMemo = undefined
    l.state.backgroundTasks = undefined
  }

  /**
   * The running conversation's transcript size, for the footer (shown in 0.1 MB steps), and a warning once it
   * passes Settings → Sessions → Warn when a transcript is over: a long one slows the CLI and Combwork, and only a
   * new conversation (a handover) makes it short again, since compacting keeps the whole history in the file.
   */
  private noteTranscriptSize(l: LiveSession, bytes: number): void {
    const st = l.state
    const step = (b: number | undefined): number => (b === undefined ? -1 : Math.floor(b / (100 * 1024)))
    const changed = step(st.transcriptBytes) !== step(bytes)
    st.transcriptBytes = bytes
    if (changed) this.emitState(st)
    const project = workspaceOf(st.projectPath).info()?.projects.find((x) => x.path.toLowerCase() === st.projectPath.toLowerCase())
    const limitMB = transcriptWarnLimit(project?.config, Number(config.settings.sessions.transcriptWarnMB) || 0)
    if (!limitMB || bytes < limitMB * 1024 * 1024 || !st.sessionId || l.sizeWarned === st.sessionId) return
    const assistant = workspace.isAssistantHome(st.projectPath)
    // In a turn, the notice waits for its end (HI-1695, Darren's option 1): a transcript grows only in a turn, so it is
    // nearly always crossed then, and the notice made then had no Hand Over to…, never offered again. The look at the
    // turn's end (or the next one) makes it, once, with the button when the agent may hand over then.
    if (!assistant && (st.status === 'working' || st.status === 'starting' || st.status === 'waiting')) return
    l.sizeWarned = st.sessionId
    const label = this.label(st)
    log.info(`${userText(label)}: transcript is ${(bytes / 1024 ** 2).toFixed(1)} MB, over ${limitMB} MB`)
    // What it can do (#1057): told, not pushed. Hand Over to… only while it may hand over now (checked again when it is
    // clicked, and by the hand-over); else that it can when it has finished.
    void (assistant ? Promise.resolve(false) : this.handOverAllowed(st.projectPath, st.agentId).catch(() => false)).then((now) => {
      const values = { size: formatSize(bytes), limit: limitMB, when: assistant ? 'assistant' : now ? 'now' : 'other' }
      const actions: ToastAction[] | undefined = now ? [{ label: tr(msg({ id: 'session.long.handOver', defaultMessage: 'Hand Over to…', description: "A notice's button: hands the agent's work over to a new conversation (the Hand Over to… command)." })), command: 'session.handOverLongConversation', args: [st.projectPath, st.agentId, st.sessionId] }] : undefined
      // Told once (HI-2320: a toast and a routed copy before), its Hand Over to… live while this conversation is.
      tell({ kind: 'transcript', title: tr(M.longConversation, { agent: label }), message: tr(HAND_OVER_TEXT.notice, values), ...(actions ? { actions, offer: `transcript:${liveId(st.projectPath, st.agentId)}#${st.sessionId}` } : {}), projectPath: st.projectPath, agentId: st.agentId, target: { kind: 'agent', projectPath: st.projectPath, agentId: st.agentId, name: label, project: basename(st.projectPath) } })
    })
  }

  /**
   * The agent's parts in its project's running lanes (HI-2049: its launch's side of the workflow): set by launchSides.ts,
   * which knows the lanes, at startup before any launch.
   */
  laneParts: (projectPath: string, agentId: string) => Promise<('builder' | 'reviewer')[]> = async () => []

  /**
   * The tools a project's workflow makes unusable now (HI-2694), its config given or the workspace's copy: set by
   * workflowTools.ts at startup. Until set (unit tests of the sessions alone): none.
   */
  workflowHiddenOf: (projectPath: string, cfg?: Pick<ProjectConfig, 'workflow'>) => string[] = () => []

  /**
   * The side of the workflow of an agent's launch `runId` (HI-2049), for what its combwork server reports: `unknown` once
   * that launch has ended or another has taken its place, so a late report never takes the next launch's side.
   */
  launchSide(projectPath: string, agentId: string, runId: string | null): LaunchWorkflow | 'unknown' {
    const l = this.live.get(liveId(projectPath, agentId))
    return l && runId && l.state.runId === runId && l.workflow ? l.workflow : 'unknown'
  }

  /** The CLI of an agent's launch `runId` (HI-2553), for the tool list its combwork server reports; null once it has ended or another took its place. */
  launchProvider(projectPath: string, agentId: string, runId: string | null): ProviderId | null {
    const l = this.live.get(liveId(projectPath, agentId))
    return l && runId && l.state.runId === runId ? l.state.provider : null
  }

  /** Whether the agent may hand over to a new conversation of its own now (#1057): set by handOverCheck.ts, which knows the lanes. */
  handOverAllowed: (projectPath: string, agentId: string, turnOver?: boolean) => Promise<boolean> = async (projectPath, agentId, turnOver) => {
    const st = this.liveFor(projectPath, agentId)
    return handOverNow(turnOver && st ? { ...st, status: 'finished', backgroundTasks: 0 } : st, false)
  }

  /**
   * The language Combwork shows changed (#797): what a live session's state says in Combwork's words (where its
   * auto-compaction setting comes from) is said again in it.
   */
  relabel(): void {
    for (const l of this.live.values()) {
      if (!l.autoCompactFor) continue
      const autoCompact = l.autoCompactFor(l.state.modelId ?? undefined)
      if (JSON.stringify(autoCompact) === JSON.stringify(l.state.autoCompact)) continue
      l.state.autoCompact = autoCompact
      this.emitState(l.state)
    }
  }

  private emitState(state: LiveSessionState): void {
    // Its input as Combwork holds it now (#648): a line typed or given up since the last report.
    const l = state.projectPath ? this.live.get(liveId(state.projectPath, state.agentId)) : undefined
    if (l?.state === state) this.recheckOffers(l)
    if (l?.state === state) this.fact(state, { composer: this.composerOf(l) })
    // A launch with its task on its command line: when it first became ready, before a watch shows that as watching (#721).
    if (l?.state === state && l.launchTask && l.launchReadyAt === undefined && (state.status === 'ready' || state.status === 'watching' || state.status === 'finished')) l.launchReadyAt = Date.now()
    // And any launch: its Combwork tools' bound runs from then (#865), which a wait for them looks at again.
    if (l?.state === state && l.readyAt === undefined && (state.status === 'ready' || state.status === 'watching' || state.status === 'finished')) {
      l.readyAt = Date.now()
      this.recheckTools(liveId(state.projectPath, state.agentId))
    }
    // A wake-on-change watch (#128): an agent whose turn has ended waits on its cards (watching), never idle; without
    // the watch, it is just finished again (not newly: nothing to look at, nothing to notify).
    const watch = this.watchFor(state.projectPath, state.agentId)
    state.watch = watch ?? undefined
    if (watch && (state.status === 'ready' || state.status === 'finished')) {
      state.status = 'watching'
      state.unseen = false
    } else if (!watch && state.status === 'watching') state.status = 'finished'
    // Working or watching again, or a background task of its own will wake it (#521): no longer waiting with no watch (#376).
    if ((state.status !== 'ready' && state.status !== 'finished') || tasksWillWake(state)) state.notWatching = undefined
    const was = this.statusSent.get(state)
    if (was !== state.status) {
      // HI-2312: its next turn has started (working, starting or waiting again after its turn's end): a finish of its not
      // told yet is about a turn that's over, so it isn't told, whatever the new turn ends as (finished, watching).
      if (was && !BUSY.has(was) && BUSY.has(state.status)) this.dropFinishes(state, state.status)
      this.statusSent.set(state, state.status)
      state.statusSince = new Date().toISOString()
    }
    this.refreshSize(state)
    emit({ type: 'session-status', state: { ...state } })
  }

  /**
   * A CLI whose full-screen interface a resize while it starts can leave drawn at the wrong width (Copilot): a size
   * refresh, as resizing the window by hand gives, once it has started (its first status: ready, or a question at
   * start) and once it is ready (#486); also after Combwork switches its mode live (setPermissionMode).
   */
  private refreshSize(state: LiveSessionState): void {
    const l = this.live.get(liveId(state.projectPath, state.agentId))
    if (!l || l.state !== state || !l.adapter.descriptor.capabilities.startupSizeRefresh || state.settingUp || state.status === 'starting' || l.sizeRefreshed === 'ready') return
    const ready = state.status !== 'waiting'
    if (l.sizeRefreshed === 'started' && !ready) return
    l.sizeRefreshed = ready ? 'ready' : 'started'
    this.refreshSizeSoon(l)
  }

  /** A size refresh a moment from now, so the CLI has drawn what it shows by then, for a CLI that needs it (refreshSize). */
  private refreshSizeSoon(l: LiveSession): void {
    if (!l.adapter.descriptor.capabilities.startupSizeRefresh) return
    const { projectPath, agentId } = l.state
    setTimeout(() => {
      if (this.live.get(liveId(projectPath, agentId)) === l) refreshPty(this.key(projectPath, agentId))
    }, SIZE_REFRESH_DELAY_MS)
  }

  /**
   * A CLI refused an agent's sign-in: told once for this expiry, with every agent of its scope it has stopped by then.
   * A connection's (HI-1755) is checked again through its own folder (checkAccount), never the CLI's own home.
   */
  private signInLost(st: LiveSessionState): void {
    const scope = authScope(st)
    if (this.signedOut.has(scope)) return
    const conn = st.launchedConnection?.id
    const recheck = (): void => {
      if (conn) void checkAccount(conn).catch(() => undefined)
      else void providerService.refresh(st.provider, false).catch(() => undefined)
    }
    const out: { gather?: ReturnType<typeof setTimeout>; recheck?: ReturnType<typeof setInterval> } = {}
    this.signedOut.set(scope, out)
    out.gather = setTimeout(() => this.tellSignedOut(scope), SIGNED_OUT_GATHER_MS)
    // Provider Setup (or the connection's row) shows it signed out, and the next check that finds it signed in again ends
    // this (providerService's, or the connection's: onConnectionSignedIn).
    recheck()
    out.recheck = setInterval(() => {
      // Kept until it is shown signed in again: only when no agent it stopped runs any more (they exited) is there
      // nothing left to tell or carry on, and it ends quietly. An agent trying again (working) still counts.
      if (!this.liveStates().some((s) => authScope(s) === scope && s.signIn)) return void this.endSignedOut(scope)
      recheck()
    }, SIGN_IN_RECHECK_MS)
  }

  private tellSignedOut(scope: string): void {
    const waiting = this.liveStates().filter((s) => authScope(s) === scope && s.status === 'signin')
    if (!waiting.length) return
    const provider = waiting[0].provider
    const d = providerAdapter(provider).descriptor
    const first = waiting[0]
    const title =
      waiting.length === 1
        ? withValues(msg({ id: 'session.signIn.one', defaultMessage: '{agent} needs you to sign in to {provider}', description: "A notification's title: an agent's CLI sign-in has expired. {agent} is the agent, {provider} the coding agent's name." }), { agent: this.label(first), provider: d.name })
        : withValues(msg({ id: 'session.signIn.many', defaultMessage: '{n, plural, other {# agents need you to sign in to {provider}}}', description: "A notification's title: the CLI sign-in of several agents has expired. {n} is how many (2 or more), {provider} the coding agent's name." }), { n: waiting.length, provider: d.name })
    log.info(`${d.name}: sign-in refused for ${waiting.length} agent(s)`)
    // A server connection's (HI-1772): its key was refused, replaced in Settings → Accounts & Connections; no sign-in.
    const server = first.launchedConnection?.server ? first.launchedConnection.name : null
    if (server) {
      const keyTitle = withValues(msg({ id: 'session.keyRefused.title', defaultMessage: "{n, plural, one {{agent} stopped: {name}'s key was refused} other {# agents stopped: {name}'s key was refused}}", description: "A notification's title: the server of a server connection ({name}) refused its API key, so agents on it stopped. {n} is how many agents, {agent} the first one's name." }), { n: waiting.length, agent: this.label(first), name: server })
      this.notify(first.projectPath, keyTitle, withValues(msg({ id: 'session.keyRefused.body', defaultMessage: "Replace {name}'s key in Settings → Accounts & Connections, then Resume in the project's header carries them on.", description: "The notification that a server connection's ({name}) API key was refused. Settings → Accounts & Connections names a section; Resume is a button in the project's header." }), { name: server }), 'waiting', undefined, first.agentId)
      return
    }
    this.notify(first.projectPath, title, withValues(msg({ id: 'session.signIn.expired', defaultMessage: "{provider}'s sign-in has expired. {help}", description: "The notification that a CLI's sign-in has expired. {provider} is the coding agent's name; {help} says how to sign in again (a sentence or two)." }), { provider: d.name, help: d.text?.signInHelp ?? d.signInHelp }), 'waiting', undefined, first.agentId)
  }

  private endSignedOut(scope: string): boolean {
    const out = this.signedOut.get(scope)
    if (!out) return false
    clearTimeout(out.gather)
    clearInterval(out.recheck)
    this.signedOut.delete(scope)
    return true
  }

  /**
   * The CLI is signed in again (an agent of it works, its check says so, its Sign in task ended well): agents it
   * stopped are idle again, and Resume (n) carries them on (they keep LiveSessionState.signIn until they do).
   */
  signedInAgain(scope: string, checked = false): void {
    if (!this.endSignedOut(scope)) return
    const provider = scope.split(':')[0] as ProviderId
    // Provider Setup (and its banner) learn it too, unless its own check is what said so; a connection's is its own.
    if (!checked && !scope.includes(':')) void providerService.refresh(provider, false).catch(() => undefined)
    const stopped = this.liveStates().filter((s) => authScope(s) === scope && s.status === 'signin')
    for (const st of stopped) {
      this.fact(st, { lifecycle: 'running', attention: null })
      st.status = 'ready'
      setStatus(st, SIGNED_IN_AGAIN)
      this.emitState(st)
    }
    const name = providerAdapter(provider).descriptor.name
    log.info(`${name}: signed in again; ${stopped.length} agent(s) stopped meanwhile`)
    if (stopped.length)
      toast(
        'info',
        tr(msg({ id: 'session.signIn.again', defaultMessage: 'Signed in to {provider} again', description: "A notice's title: a coding agent's CLI is signed in again. {provider} is its name." }), { provider: name }),
        stopped.length === 1
          ? tr(msg({ id: 'session.signIn.againOne', defaultMessage: "{agent} stopped while it was signed out: Resume in the project's header carries it on.", description: "The notice that a CLI is signed in again. {agent} is the agent whose turn stopped; Resume is a button in the project's header." }), { agent: this.label(stopped[0]) })
          : tr(msg({ id: 'session.signIn.againMany', defaultMessage: "{n, plural, other {# agents stopped while it was signed out: Resume in the project's header carries them on.}}", description: "The notice that a CLI is signed in again. {n} is how many agents' turns stopped (2 or more); Resume is a button in the project's header." }), { n: stopped.length }),
        undefined,
        stopped[0].projectPath
      )
  }

  /**
   * Types a short "carry on" into an agent whose turn a refused sign-in stopped (Resume (n), #309): only while it is
   * still idle and hasn't carried on by itself.
   */
  async carryOn(projectPath: string, agentId: string): Promise<void> {
    const stalled = (): LiveSessionState | null => {
      const st = this.liveFor(projectPath, agentId)
      return st?.signIn && (st.status === 'ready' || st.status === 'finished' || st.status === 'signin') ? st : null
    }
    const st = stalled()
    if (!st) throw combworkError(msg({ id: 'session.carryOn.already', defaultMessage: 'It has already carried on.', description: 'Resume is refused for an agent whose turn a refused sign-in stopped: it carried on by itself meanwhile.' }), undefined, { kind: 'conflict' })
    // A control notice for this launch (#649), given now or not at all: never once it has carried on by itself.
    await this.delivery().now(projectPath, { agentId, kind: 'control', from: CW_SENDER, body: inDefaultDialect(() => say(CARRY_ON_PROMPT)), source: 'carry-on', ref: st.runId, need: 'stalled', forRun: st.runId }, () => !!stalled())
  }

  /**
   * An agent whose turn a dropped connection ended, while Combwork waits for the connection (HI-1612, outageResume.ts): its
   * status says what the wait is doing; null puts back the failed turn's own. Only for that launch, still stopped there.
   */
  connectionWait(projectPath: string, agentId: string, runId: string, text: TextPart | null): void {
    const st = this.liveFor(projectPath, agentId)
    if (!st || st.runId !== runId || !st.failedTurn) return
    const failed = failedTurnStep(st.failedTurn.message)
    // agent-text: failedTurnStep (and the callers' messages: outageResume.ts marks them)
    setStatus(st, text ?? failed.messageText ?? failed.message ?? null)
    this.emitState(st)
  }

  /** An agent's name as notices show it ("demo", or "demo · HB2" in a project with several). */
  agentLabel(projectPath: string, agentId: string): string {
    const st = this.liveFor(projectPath, agentId)
    return st ? this.label(st) : agentId
  }

  /** The launch a hook call belongs to: named by its run id, else (older launch folders) by session id. */
  /** A hook's occurrence identity (HI-2777: hookTwins), as its launch's CLI gives one; null when it gives none. */
  hookOccurrence(runId: string, body: Record<string, any>): HookOccurrence | null {
    const l = this.findLaunch(runId, body.session_id)?.[1]
    return l?.adapter.hookOccurrence?.(body) ?? null
  }

  /**
   * A launch's hooks arrive twice (HI-2777): its CLI ran Combwork's handler and a differing one of the admin snippet's
   * (a timeout changed since it was pasted, an older snippet). Each occurrence with an identity is handled once; the
   * others twice. Logged, and the user told once a run to copy the snippet again.
   */
  hooksDoubled(runId: string): void {
    const found = this.findLaunch(runId, null)
    if (!found) return
    const st = found[1].state
    const label = this.label(st)
    log.warn(`${userText(label)}: its hooks arrive twice (Combwork's and a managed snippet's that differs); tool calls and prompts are handled once, other hooks twice`)
    hookJournal(`run=${st.runId} hooks doubled`)
    st.hooksDoubled = true
    this.emitState(st)
    toast('warning', tr(msg({ id: 'session.notice.hooksDoubledTitle', defaultMessage: "{agent}'s hooks arrive twice", description: "A notification's title: an agent's coding agent sends Combwork each of its hooks twice (the calls that tell Combwork what it is doing). {agent} is the agent." }), { agent: label }), tr(HOOKS_DOUBLED_NOTE, { provider: found[1].adapter.descriptor.name }), undefined, st.projectPath, agentTarget(st.projectPath, st.agentId, label))
  }

  private findLaunch(runId: string | null, sessionId: unknown): [string, LiveSession] | null {
    if (runId) {
      const id = this.runs.get(runId)
      const l = id ? this.live.get(id) : undefined
      return id && l && !l.state.settingUp ? [id, l] : null
    }
    if (typeof sessionId !== 'string' || !sessionId) return null
    for (const e of this.live.entries()) if (e[1].state.sessionId === sessionId && !e[1].state.settingUp) return e
    return null
  }

  /** "demo" for a project with one agent, "demo · Agent 2" when it has several. */
  /** The running agent a developer console source is, or null (#698: the flight recorder's pattern trigger finds it here). */
  flightAgent(source: string): { projectPath: string; agentId: string; provider: string; label: () => string } | null {
    for (const l of this.live.values()) if (sessionSourceId(l.state.projectPath, l.state.agentId) === source) return { projectPath: l.state.projectPath, agentId: l.state.agentId, provider: l.state.provider, label: () => this.label(l.state) }
    return null
  }

  private label(st: LiveSessionState): string {
    if (workspace.isAssistantHome(st.projectPath)) return ASSISTANT_NAME
    const project = basename(st.projectPath)
    const count = workspaceOf(st.projectPath).info()?.projects.find((p) => p.path.toLowerCase() === st.projectPath.toLowerCase())?.agents.length ?? 1
    // agent-protocol: a fallback name, never seen (every launch has its agent's name)
    return count > 1 ? `${project} · ${st.agentName ?? 'Agent'}` : project // i18n-ignore: a fallback name, never seen (every launch has its agent's name)
  }

  /**
   * Live details a provider's own reader found for a launch outside its hooks and transcript (HI-2762: OpenCode's history,
   * read from its server): its cost, its plan's limits. Taken as a status line's are; nothing for a launch that ended.
   */
  reportDetails(runId: string, d: LiveDetails): void {
    const id = this.runs.get(runId)
    const l = id ? this.live.get(id) : undefined
    if (!l || l.state.runId !== runId) return
    this.applyDetails(l, d)
  }

  /**
   * A launch's own report that its connection has no plan limits now (HI-2762: OpenCode's server says its account isn't
   * signed in to a service with any): what was kept for that connection goes. Not for a launch that ended, nor one on no
   * connection (its provider's limits are other launches' too).
   */
  clearPlanUsage(runId: string): void {
    const id = this.runs.get(runId)
    const l = id ? this.live.get(id) : undefined
    if (!l || l.state.runId !== runId || !l.state.launchedConnection) return
    forgetConnectionUsage(l.state.launchedConnection.id)
  }

  /** A provider's status report (Claude Code's status line): the session's model, effort and cost, and the plan's limits. */
  handleStatusLine(runId: string | null, body: Record<string, any>): void {
    const found = this.findLaunch(runId, body.session_id)
    if (!found?.[1].adapter.statusLine) return
    const l = found[1]
    const d = l.adapter.statusLine!(body)
    // i18n-ignore: the developer console's event data, recorded like a log, stays English (#1104)
    devConsole.capture([sessionSourceId(l.state.projectPath, l.state.agentId)], () => ({ kind: 'statusline', name: 'status line', provider: l.state.provider, raw: body, made: d, safe: { raw: STATUSLINE_FIELDS, made: DETAILS_FIELDS }, summary: statusLineSummary(d) }))
    flightRecorder.arrived(l.state, () => this.label(l.state), 'statusline', body)
    this.applyDetails(l, d)
    // A CLI that names its conversation only after it starts (HI-2544: the Antigravity CLI), in its status line: this
    // launch's (its run id and token), taken while it has none; a known conversation is never replaced by another.
    const conv = l.adapter.statusLineSession?.(body) ?? null
    // Only the current launch's own status line (a stale one of an earlier run of this agent never names this one's).
    if (conv && runId !== l.state.runId) log.warn(`${userText(this.label(l.state))}: a status line of run ${runId ?? 'none'} named conversation ${conv}: not this launch's (${l.state.runId}), ignored`)
    else if (conv && !l.state.sessionId) void this.adoptSessionId(l, conv, 'status line') // i18n-ignore: a log line's words
    else if (conv && conv !== l.state.sessionId) log.warn(`${userText(this.label(l.state))}: its status line named conversation ${conv}, not ${l.state.sessionId}: kept ${l.state.sessionId}`)
    // A CLI whose first hook waits for its first prompt (agy 1.5.0: SessionStart comes with it), started with none: its
    // status line saying idle is its prompt showing (HI-2548; recorded: authenticating, initializing, then idle before
    // any prompt). The current launch's only, in hook order, while it is still starting and asked nothing at its start.
    if (runId === l.state.runId && l.state.status === 'starting' && l.adapter.statusLineIdle?.(body)) {
      const id = liveId(l.state.projectPath, l.state.agentId)
      void this.inHookOrder(l.state.runId, () => {
        if (this.live.get(id) !== l || l.state.runId !== runId || l.state.status !== 'starting' || l.askedAtStart) return
        this.fact(l.state, { lifecycle: 'running' })
        l.state.status = 'ready'
        this.emitState(l.state)
      })
    }
    // What only the status line tells of (HI-2545, agy): its permission prompt and a turn ended with no hook. The current
    // launch's own only, about the conversation it runs, applied in hook order and only to a turn that runs then.
    if ((l.adapter.statusLineAsk || l.adapter.statusLineIdle) && runId === l.state.runId) {
      const id = liveId(l.state.projectPath, l.state.agentId)
      const ask = l.adapter.statusLineAsk?.(body) ?? null
      const idle = !!l.adapter.statusLineIdle?.(body)
      // Derived in one place, never tracked at the door (the Assistant's note on HI-2545, after HR1's and HR2's rounds):
      // every report is queued in hook order as it comes, unfiltered, and only there validated: still this launch, about
      // the conversation it runs, and the turn running as it arrived still the running one. applyStatus then owns all
      // that the status line says: the prompt showing, the idle period and its grace. So reports applied in any arrival
      // order end as the last valid one says. Nothing is done as a report arrives: a grace's end is queued in the same order,
      // so a report that came before it is applied first.
      const turn = l.ledger?.active?.state === 'running' ? l.ledger.active.id : null
      const session = l.state.sessionId
      void this.inHookOrder(l.state.runId, () => {
        const now = l.ledger?.active
        if (this.live.get(id) !== l || !turn || !session || l.state.sessionId !== session || (conv && conv !== session) || now?.id !== turn || now.state !== 'running') return
        const scope = { turn, session }
        const grace = l.idleGrace
        const { next, actions } = applyStatus(l.statusState ?? NO_STATUS, { ask: !!ask, idle, scope }, !!grace && grace.turn === turn && grace.sessionId === session, l.state.status === 'waiting')
        l.statusState = next
        for (const a of actions) {
          if (a === 'ask' && ask) this.carryOut(id, l, hookStep({ kind: 'ask', ask }, this.statusInput(l)), 'statusline', { kind: 'ask', ask })
          else if (a === 'answer') this.carryOut(id, l, hookStep({ kind: 'toolEnd' }, this.statusInput(l)), 'statusline', { kind: 'toolEnd' })
          else if (a === 'startGrace') this.startIdleGrace(id, l, turn)
          else if (a === 'cancelGrace') this.cancelIdleGrace(l)
        }
      })
    }
  }

  /**
   * A running turn its status line says is over with no hook saying so (HI-2545: agy's cancelled permission prompt): the
   * turn is interrupted once idleGraceMs passes with nothing more heard of the launch. Bound to the launch's run, session
   * and turn now; at its end it looks again, in hook order: the same launch, session and turn, still running, and the
   * status line still idle. Cancelled by any hook or other status of the launch, and by its end. `turnId`: the turn the idle
 * report was about as it arrived, which must still be the running one.
   */
  private startIdleGrace(id: string, l: LiveSession, turnId: string): void {
    const turn = l.ledger?.active
    if (!turn || turn.id !== turnId || turn.state !== 'running' || !l.state.sessionId) return
    // One grace at a time: a new idle period's replaces any other.
    this.cancelIdleGrace(l)
    const grace = { runId: l.state.runId, sessionId: l.state.sessionId, turn: turn.id } as Omit<NonNullable<LiveSession['idleGrace']>, 'timer'>
    const timer = setTimeout(() => {
      void this.inHookOrder(grace.runId, () => {
        if (l.idleGrace?.timer !== timer) return
        l.idleGrace = undefined
        const now = l.ledger?.active
        if (this.live.get(id) !== l || l.state.runId !== grace.runId || l.state.sessionId !== grace.sessionId || !idleNow(l.statusState ?? NO_STATUS, { turn: grace.turn, session: grace.sessionId }) || now?.id !== grace.turn || now.state !== 'running') return
        endRunning(l.ledger!, 'interrupt')
        this.carryOut(id, l, hookStep({ kind: 'interrupt' }, this.statusInput(l)), 'statusline', { kind: 'interrupt' })
        this.noteTurn(l)
      })
    }, l.adapter.idleGraceMs?.() ?? 3000)
    timer.unref?.()
    l.idleGrace = { ...grace, timer }
  }

  /** Ends a launch's idle grace, if any (something was heard of it, or it ended). */
  private cancelIdleGrace(l: LiveSession): void {
    if (!l.idleGrace) return
    clearTimeout(l.idleGrace.timer)
    l.idleGrace = undefined
  }

  /** A launch's conversation id, learned after it started (`from`: what said it, for the log): recorded as its session. */
  private async adoptSessionId(l: LiveSession, id: string, from: string): Promise<void> {
    const st = l.state
    const current = (): boolean => this.live.get(liveId(st.projectPath, st.agentId)) === l
    try {
      st.sessionId = assertSessionId(id)
      const { agent } = await this.agentDef(st.projectPath, st.agentId)
      if (!current()) return
      await this.recordSession(st.projectPath, agent, l)
      if (!current()) return
      this.emitState(st)
      workspaceOf(st.projectPath).scheduleRefresh()
      log.info(`${userText(this.label(st))}: its conversation is ${id} (from its ${from})`)
    } catch (e) {
      if (!current()) return
      log.warn(`${userText(this.label(st))}: could not record session ${id}`, e)
    }
  }

  /** `hooks`: details read from the transcript, as it was when the launch had had that many hooks (readDetails). */
  private applyDetails(l: LiveSession, d: ReturnType<NonNullable<ProviderAdapter['statusLine']>>, hooks?: number): void {
    // The session's log says a turn ended on a refused sign-in (Codex, which sends no hook then): as a hook would, in
    // order with the launch's hooks.
    // A conversation's log read from its start (a resumed one) may end on an older refusal: only this launch's count.
    // Not after a hook that came once the read began (the next prompt, after signing in again): that one is newer.
    const refused = d.signIn && !(d.signInAt && Date.parse(d.signInAt) < Date.parse(l.state.startedAt)) ? d.signIn : null
    if (refused) {
      const id = liveId(l.state.projectPath, l.state.agentId)
      void this.inHookOrder(l.state.runId, () => {
        if (this.live.get(id) !== l || (hooks !== undefined && (l.hooksSeen ?? 0) !== hooks)) return
        if (l.ledger) endRunning(l.ledger, 'signIn')
        this.carryOut(id, l, hookStep({ kind: 'signIn', message: refused }, this.statusInput(l)), 'transcript', { kind: 'signIn', message: refused })
        this.noteTurn(l)
      })
    }
    // A turn the log says ended on an error (#1632, Codex, whose Stop says nothing of it): of this launch, settled in
    // order with the hooks by the turn it names, never by whichever turn is current (settleFailure). A read that hooks
    // overtook is no reason to drop it: the turn it names decides.
    const at = d.turnFailed !== undefined && d.turnFailedAt ? Date.parse(d.turnFailedAt) : NaN
    if (at >= Date.parse(l.state.startedAt)) {
      const rec = { key: `${d.turnFailedTurn ?? ''}@${d.turnFailedAt}`, turn: d.turnFailedTurn ?? null, at, words: d.turnFailed ?? '' }
      const id = liveId(l.state.projectPath, l.state.agentId)
      void this.inHookOrder(l.state.runId, () => {
        if (this.live.get(id) !== l || rec.key === l.failureDone) return
        l.failure = rec
        // A CLI that sends no Stop after a failed turn (Copilot, HI-1960): its record ends the running turn, failed, as
        // that Stop would (failedIfRecorded gives it the CLI's words).
        if (l.adapter.descriptor.capabilities.failureEndsTurn && l.ledger && failureTurn(l.ledger, rec) === 'running') return this.endTurnFrom(id, l, 'transcript', `${l.adapter.descriptor.name} recorded its turn failed at ${d.turnFailedAt}`) // i18n-ignore: the log and the hook journal (English)
        this.settleFailure(id, l)
      })
    }
    // A turn interrupted without a hook (Copilot): as the interrupt hook would, once per recorded interrupt of this launch.
    // Not after a hook that came once the read began (the CLI carried on, its Stop, a new prompt): that one is newer.
    const interrupted = d.interruptedAt && Date.parse(d.interruptedAt) >= Date.parse(l.state.startedAt) && d.interruptedAt !== l.interruptedAt ? d.interruptedAt : null
    if (interrupted) {
      l.interruptedAt = interrupted
      const id = liveId(l.state.projectPath, l.state.agentId)
      void this.inHookOrder(l.state.runId, () => {
        if (this.live.get(id) !== l || (hooks !== undefined && (l.hooksSeen ?? 0) !== hooks)) return
        if (l.ledger) endRunning(l.ledger, 'interrupt')
        this.carryOut(id, l, hookStep({ kind: 'interrupt' }, this.statusInput(l)), 'transcript', { kind: 'interrupt' })
        this.noteTurn(l)
      })
    }
    // A compaction's end the CLI sends no hook for (Copilot, #454): as the end hook would, once per recorded end of this
    // launch, and only while Combwork thinks it compacting (a /compact's end read later, with nothing under way, is history).
    // Not after a hook that came once the read began (a newer PreCompact, a prompt), nor for a compaction that began after
    // it ended (Copilot's clock is this machine's): this end is then an older compaction's.
    const compacted = d.compactedAt && Date.parse(d.compactedAt) >= Date.parse(l.state.startedAt) && (!l.compactedAt || d.compactedAt > l.compactedAt) ? d.compactedAt : null
    if (compacted) {
      l.compactedAt = compacted
      const id = liveId(l.state.projectPath, l.state.agentId)
      void this.inHookOrder(l.state.runId, () => {
        if (this.live.get(id) !== l || (hooks !== undefined && (l.hooksSeen ?? 0) !== hooks) || !(l.compacting || isCompacting(l.state))) return
        if (l.state.statusSince && Date.parse(compacted) < Date.parse(l.state.statusSince)) return
        this.carryOut(id, l, hookStep({ kind: 'compactEnd' }, this.statusInput(l)), 'transcript', { kind: 'compactEnd' })
      })
    }
    // The CLI's own record that its latest turn is over (#648): kept, and acted on if Combwork missed that turn's Stop. And,
    // for a CLI whose records don't name turns, when its Stops were answered (this launch's only, the latest kept).
    if (d.turnEnded !== undefined) l.turnRecord = d.turnEnded
    const started = Date.parse(l.state.startedAt)
    const answered = (d.stopsAnswered ?? []).map(Date.parse).filter((t) => t >= started)
    if (answered.length) l.stopsAnswered = [...(l.stopsAnswered ?? []), ...answered].slice(-STOPS_KEPT)
    if (d.turnEnded || answered.length) this.reconcileTurn(l)
    // The connection it launched on (HI-1756): its usage is that login's.
    if (d.planUsage) reportPlanUsage(l.state.provider, d.planUsage, l.state.agentName ?? l.state.agentId, l.state.launchedConnection)
    const learn = l.defaultEffort
    const learnModel = d.modelId ?? learn?.model
    if (learn && d.effort && learnModel) {
      providerService.observeDefaultEffort(l.state.provider, learnModel, d.effort)
      l.defaultEffort = undefined
    }
    const st = l.state
    // Running another model than expected: its own auto-compact window, if its settings give it one (#242).
    const autoCompact = d.modelId && d.modelId !== st.modelId && l.autoCompactFor ? l.autoCompactFor(d.modelId) : st.autoCompact
    // The CLI's report is kept; it is shown unless the user chose their prices (#436), and then it isn't an estimate.
    // On a server connection (HI-1772) never: it prices the server's model as a Claude model.
    const onServer = !!st.launchedConnection?.server
    if (d.costUsd != null && !onServer) l.reportedCost = d.costUsd
    const reported = d.costUsd != null && !onServer && !usesOwnPrices(st.provider, config.settings)
    const modelSwitch = this.modelSwitchOf(l, d)
    // A window is the model's that reported it (HI-2682, HR1 round 1): another model reported without one has none yet.
    const window = d.contextWindow ?? (d.modelId && st.modelId && d.modelId !== st.modelId ? undefined : st.contextWindow)
    const next = { autoCompact, effort: d.effort ?? st.effort, modelName: d.modelName ?? st.modelName, modelId: d.modelId ?? st.modelId, modelSwitch, costUsd: reported ? d.costUsd : st.costUsd, costEstimated: reported ? false : st.costEstimated, planMode: d.planMode ?? st.planMode, permissionMode: d.permissionMode && !isCliOwnMode(l.launchMode) ? d.permissionMode : st.permissionMode, contextWindow: window }
    if (
      next.effort === st.effort &&
      next.modelName === st.modelName &&
      next.modelId === st.modelId &&
      next.modelSwitch === st.modelSwitch &&
      JSON.stringify(next.autoCompact) === JSON.stringify(st.autoCompact) &&
      next.costUsd === st.costUsd &&
      !!next.costEstimated === !!st.costEstimated &&
      next.planMode === st.planMode &&
      next.permissionMode === st.permissionMode &&
      (!d.permissionMode || d.permissionMode === st.modeObserved) &&
      next.contextWindow === st.contextWindow
    )
      return
    const windowChanged = next.contextWindow !== st.contextWindow
    const switched = next.modelSwitch && next.modelSwitch !== st.modelSwitch ? next.modelSwitch : null
    Object.assign(st, next)
    if (!next.modelSwitch) delete st.modelSwitch
    if (d.permissionMode) st.modeObserved = d.permissionMode
    this.emitState(st)
    if (switched) this.modelSwitchTold(l, switched)
    // Usage shown in the renderer carries the window: have it read again.
    if (windowChanged && st.sessionId) emit({ type: 'usage-changed', projectPath: st.projectPath, sessionId: st.sessionId })
  }

  /** Its CLI's models as its launch's account offers them (HI-2852: a sign-in account's own; a server's, the CLI's). */
  private launchedInfo(st: LiveSessionState): AgentInstallInfo {
    const info = providerService.info(st.provider)
    const c = st.launchedConnection
    return (c ? accountInfo(info, { id: c.id, kind: c.server ? 'server' : 'signIn' }) : info) ?? info
  }

  /**
   * Whether the session runs another model than its launch gave it, after a report (HI-2609, modelSwitched): the same
   * object while that stands unchanged (so nothing is sent again), a new one when it starts or the model changes again,
   * undefined while it runs its own. A report recorded before this launch (a resumed rollout's earlier turns) decides
   * nothing, nor does one on a server connection, whose CLI names the Claude model the server's stands in for (HI-1772).
   */
  private modelSwitchOf(l: LiveSession, d: LiveDetails): LiveSessionState['modelSwitch'] {
    const st = l.state
    if (!d.modelId || st.launchedConnection?.server) return st.modelSwitch
    if (d.modelAt && Date.parse(d.modelAt) < Date.parse(st.startedAt)) return st.modelSwitch
    const s = modelSwitched(st.provider, st.launchedWith, d.modelId, this.launchedInfo(st))
    if (!s) return undefined
    const was = st.modelSwitch
    return was && was.launched === s.launched && was.running === s.running ? was : { ...s, since: new Date().toISOString() }
  }

  /**
   * A session seen on another model than its launch gave it (HI-2609): logged, and the user told once a launch (a notice,
   * kept in Notifications, that opens the agent); the footer and Activity show it for as long as it lasts.
   */
  private modelSwitchTold(l: LiveSession, s: ModelSwitch): void {
    const st = l.state
    const label = st.agentName ?? this.label(st)
    log.warn(`${userText(label)}: its CLI reports model ${s.running}, not ${s.launched} as launched`)
    if (l.modelSwitchTold) return
    l.modelSwitchTold = true
    const info = this.launchedInfo(st)
    const values = { agent: label, cli: l.adapter.descriptor.name, launched: modelIdName(st.provider, s.launched, info), running: modelIdName(st.provider, s.running, info) }
    toast('warning', tr(M.modelSwitchTitle, values), tr(M.modelSwitch, values), undefined, st.projectPath, agentTarget(st.projectPath, st.agentId, label))
  }

  // -------------------------------------------------------------------------
  // File locks
  // -------------------------------------------------------------------------

  /**
   * The project's file locks (its workflow option, HI-1766), as its workspace last read it: Combwork's, the workspace's or its
   * own. The Assistant's home isn't a project and shares no folder: off.
   */
  private lockMode(projectPath: string): FileLockMode {
    const ws = workspaceOf(projectPath)
    if (ws.isAssistantHome(projectPath)) return 'off'
    return projectPreferences(ws, projectPath).fileLocks
  }

  /**
   * The reply to a hook that is about to edit files (PreToolUse). The first agent to edit a file claims
   * it; another agent's edit of the same file is then blocked, sent to the user, or allowed with a
   * warning, depending on the lock mode. Claims are released when the holder's turn ends. Returns the
   * hook's reply, or null to let the edit go ahead as usual.
   */
  preToolUse(runId: string | null, body: Record<string, any>): Record<string, unknown> | null {
    const found = this.findLaunch(runId, body.session_id)
    if (!found) return null
    const [id, l] = found
    const hook = l.adapter.normalizeHook(body)
    // Any tool call of its own ends the block its last edit had (HI-982): it went on with something, or tries again.
    if (hook.event.kind === 'toolStart' && !hook.ids.sub) l.hookBlock = undefined
    if (hook.event.kind !== 'toolStart' || !hook.editedPaths.length) return null
    const obs = this.hookObs.get(body)
    // Its decision, as the launch's Hooks dialog shows it, and the block it leaves (Activity, while it stands).
    const decided = (response: HookFired['response'], why?: string, block?: Omit<HookBlock, 'runId' | 'toolUseId' | 'at'>): void => {
      if (obs) Object.assign(obs.fired, { response }, why ? { why: clip(why, HOOK_SHORT_MAX).text } : {})
      if (block) l.hookBlock = { ...block, runId: l.state.runId, toolUseId: hook.ids.call, at: Date.now() }
    }
    const mode = this.lockMode(l.state.projectPath)
    const base = typeof body.cwd === 'string' && body.cwd ? body.cwd : l.state.cwd
    const files = hook.editedPaths.map((f) => resolve(isAbsolute(f) ? f : join(base, f)))
    // The folder's write log (#1214): a check running there meanwhile doesn't count, whatever the lock mode.
    observer.markEdits(files)
    // Without Combwork's tools, or Independent now (HI-2670): no lock reply ever reaches its context; its edits are
    // still claimed, so another agent's are warned or held as before.
    if (mode === 'off' || l.policy?.tools === false || this.keepsOut(l.state.projectPath, l.state.agentId) === 'independent') {
      decided('allowed')
      return this.editAccepted(id, files, null)
    }
    const now = Date.now()
    // Each file's identity resolved once (HI-1909: a realpath on main's thread each, three times a file before).
    const keys = new Map(files.map((abs) => [abs, lockKey(abs)]))
    for (const abs of files) {
      const held = this.locks.get(keys.get(abs)!)
      const holder = held && held.liveId !== id ? this.live.get(held.liveId) : undefined
      if (!holder || now - held!.at >= LOCK_TTL_MS) continue
      const rel = placeRelative(holder.state.cwd, abs) || basename(abs)
      const who = holder.state.agentName ?? say(SESSION.lock.anotherAgent)
      log.info(`Lock: ${userText(l.state.agentName)} → ${userText(rel)} held by ${userText(who)} (${mode})`)
      const block = { key: keys.get(abs)!, file: abs, holderLiveId: held!.liveId, holderRunId: holder.state.runId }
      if (mode === 'warn') {
        decided('warned', who)
        return this.editAccepted(id, files, l.adapter.lockReply({ kind: 'warn', context: say(SESSION.lock.warn, { holder: who, file: rel }) }), keys)
      }
      if (mode === 'ask' && !l.adapter.descriptor.capabilities.lockAsk) {
        // The CLI can't show its own approval for this, so Combwork asks the user and the agent waits.
        const key = `${id}|${keys.get(abs)!}`
        // Allowed against this claim (HI-2386: an Allow given against another claim of the file allows nothing here, and
        // goes, so the user can be asked about this one).
        if (this.lockAllowed.has(key) && this.lockAllowedClaim.get(key) === held!.claim) continue
        this.dropAllowance(key)
        // An open question about another claim answers nothing about this one: it goes, and the user is asked about this.
        if (this.lockAsked.has(key) && this.lockAskClaim.get(key) !== held!.claim) this.closeAsk(key)
        if (!this.lockAsked.has(key)) {
          this.lockAsked.set(key, ++this.lockSeq)
          this.lockAskClaim.set(key, held!.claim)
          toast(
            'warning',
            tr(msg({ id: 'session.lock.title', defaultMessage: '{agent} wants to edit {file}', description: "A notice's title: an agent wants to edit a file another agent is editing (Combwork's file locks, Ask me). {agent} is the agent, {file} the file's path in the project." }), { agent: this.label(l.state), file: rel }),
            tr(msg({ id: 'session.lock.body', defaultMessage: '{holder} is editing it right now. Allow {agent} to edit it too?', description: "The notice that an agent wants to edit a file another agent is editing. {holder} is the agent editing it, {agent} the agent asking." }), { holder: holder.state.agentName ?? tr(msg({ id: 'session.lock.anotherAgent', defaultMessage: 'Another agent', description: "Stands for an agent whose name isn't known, at the start of a sentence (\"Another agent is editing it right now.\")." })), agent: l.state.agentName ?? tr(msg({ id: 'session.lock.theAgent', defaultMessage: 'the agent', description: "Stands for an agent whose name isn't known, in the middle of a sentence (\"Allow the agent to edit it too?\")." })) }),
            [{ label: tr(msg({ id: 'session.lock.allow', defaultMessage: 'Allow', description: "A notice's button: lets the agent edit the file another agent is editing." })), command: 'session.allowLockedEdit', args: [l.state.projectPath, l.state.agentId, abs, `lock:${key}#${this.lockAsked.get(key)}`] }],
            l.state.projectPath,
            { kind: 'agent', projectPath: l.state.projectPath, agentId: l.state.agentId, name: this.label(l.state), project: basename(l.state.projectPath) },
            { offer: `lock:${key}#${this.lockAsked.get(key)}` }
          )
        }
        const asked = say(SESSION.lock.asked, { holder: who, file: rel })
        decided('asked', asked, { ...block, kind: 'asked' })
        return l.adapter.lockReply({ kind: 'deny', reason: asked })
      }
      // The lock's reply to the agent, or its CLI's own question.
      const reason = say(SESSION.lock.blocked, { holder: who, file: rel })
      decided(mode === 'ask' ? 'asked' : 'blocked', reason, { ...block, kind: mode === 'ask' ? 'asked' : 'blocked' })
      return l.adapter.lockReply({ kind: mode === 'ask' ? 'ask' : 'deny', reason })
    }
    let fresh = false
    // Claims taken over from another holder (an allowed edit, or a holder whose claim had expired) end here, as a
    // release ends them (HI-2386).
    const replaced = new Map<string, FileLock>()
    for (const abs of files) {
      const key = keys.get(abs)!
      const old = this.claimFile(key, id, abs, now)
      if (old === 'kept') continue
      fresh = true
      if (old) replaced.set(key, old)
    }
    if (fresh) this.publishLocks(id)
    if (replaced.size) {
      for (const holder of new Set([...replaced.values()].map((v) => v.liveId))) this.publishLocks(holder)
      this.claimsEnded(replaced, id)
    }
    decided('allowed')
    return this.editAccepted(id, files, null, keys)
  }

  /**
   * An edit going ahead (every file in it): the files need no go-ahead any more, whoever held them meanwhile (the
   * holder may have finished before the retry). Returns `reply`.
   */
  private editAccepted<T>(id: string, files: string[], reply: T, keys?: ReadonlyMap<string, string>): T {
    // None waiting (nearly always): no file's identity to resolve.
    if (this.lockGoAhead.size) for (const abs of files) this.lockGoAhead.delete(`${id}|${keys?.get(abs) ?? lockKey(abs)}`)
    // Nor an answer to an ask still open for them (HI-2386: kept past its turn's end): its notice's Allow goes. Nor the
    // Allows it was given for them: they were against claims its edit has ended (it holds the files now, or edits past a
    // warning or with locks off), and a later claim of another agent's is asked about anew.
    if (this.lockAsked.size || this.lockAllowed.size)
      for (const abs of files) {
        const key = `${id}|${keys?.get(abs) ?? lockKey(abs)}`
        this.closeAsk(key)
        this.dropAllowance(key)
      }
    return reply
  }

  private dropAllowance(key: string): void {
    this.lockAllowed.delete(key)
    this.lockAllowedClaim.delete(key)
  }

  /** An "Ask me" question no longer open (answered, or no longer applying): its notice's Allow goes, saying so. */
  private closeAsk(key: string): void {
    const seq = this.lockAsked.get(key)
    this.lockAskClaim.delete(key)
    if (seq === undefined) return
    this.lockAsked.delete(key)
    resolveOffer(`lock:${key}#${seq}`, tr(OUTCOME.noLongerAsked))
  }

  /**
   * The one way a file is claimed (HI-2386; releaseLocks the one way a claim is let go): `id` holds the file now. Its own
   * claim kept goes on ('kept', the same claim id); a new one gets a new id. Returns the claim it replaced (another
   * holder's: the caller ends it with claimsEnded), or undefined when the file was free.
   */
  private claimFile(key: string, id: string, path: string, now: number): FileLock | 'kept' | undefined {
    const held = this.locks.get(key)
    const kept = held?.liveId === id
    this.locks.set(key, { liveId: id, at: now, seq: ++this.lockSeq, path, claim: kept ? held!.claim : ++this.claimSeq })
    return kept ? 'kept' : held
  }

  /**
   * Claims ended (`ended`, by lock key: released, or replaced by `taker`'s): what was asked or allowed about each was about
   * that claim alone (HI-2386). Its questions go, and the Allows given against it (another claim needs its own); each
   * agent waiting on it is told the file is free to try again, when its turn has ended, unless its Allow was already
   * typed (it is trying now). The next try claims the file, or asks the user about the claim it then finds. `taker`'s own
   * edit settles its asks and go-aheads (editAccepted).
   */
  private claimsEnded(ended: ReadonlyMap<string, FileLock>, taker?: string): void {
    const told = new Set<string>()
    const others = (key: string): boolean => taker === undefined || !key.startsWith(`${taker}|`)
    for (const [k, lock] of ended) {
      const ending = `|${k}`
      for (const key of [...this.lockAsked.keys()]) {
        if (!key.endsWith(ending) || !others(key) || this.lockAskClaim.get(key) !== lock.claim) continue
        this.closeAsk(key)
        this.lockGoAhead.set(key, { path: lock.path })
        told.add(key.slice(0, -ending.length))
      }
      for (const key of [...this.lockAllowedClaim.keys()]) {
        if (!key.endsWith(ending) || !others(key) || this.lockAllowedClaim.get(key) !== lock.claim) continue
        this.lockAllowed.delete(key)
        this.lockAllowedClaim.delete(key)
      }
      for (const [key, g] of [...this.lockGoAhead]) {
        if (!key.endsWith(ending) || !others(key) || g.allowed !== lock.claim) continue
        this.lockGoAhead.set(key, { path: g.path })
        told.add(key.slice(0, -ending.length))
      }
    }
    for (const id of told) {
      const l = this.live.get(id)
      if (l) this.sendGoAheads(id, l)
    }
  }

  /**
   * "Allow" on an "Ask me" lock notification: lets the agent edit the file, and tells it to go ahead (sendGoAheads):
   * now if it is idle, else when its turn ends (the toast shows while the blocked agent is still replying, and that
   * turn's end would otherwise drop the allowance with nothing typed).
   */
  async allowLockedEdit(projectPath: string, agentId: string, path: string, offer?: string): Promise<void> {
    projectPath = workspace.assertSessionHost(projectPath)
    const id = liveId(projectPath, agentId)
    const l = this.live.get(id)
    if (!l) return
    const file = lockKey(resolve(path))
    const key = `${id}|${file}`
    // Checked again (HI-2320, HR2's round 1): only the ask its notice offered (`offer`, its sequence), while it is still
    // open, is answered; an older notice's Allow answers nothing newer, and says it no longer applies. So does one whose
    // claim isn't the file's claim now (HI-2386: let go or replaced, however that happened).
    const asked = this.lockAsked.get(key)
    const current = asked === undefined ? null : `lock:${key}#${asked}`
    const claim = this.lockAskClaim.get(key)
    const stale = claim !== undefined && this.locks.get(file)?.claim !== claim
    // Already allowed against this claim (HI-2386, HR1's round 3: one given against another claim doesn't count).
    const allowed = this.lockAllowed.has(key) && (claim === undefined || this.lockAllowedClaim.get(key) === claim)
    if (!current || allowed || (offer !== undefined && offer !== current) || stale) {
      // i18n-ignore: the log (English)
      log.info(`Lock: Allow for ${userText(this.label(l.state))} → ${userText(basename(path))} answered nothing (${!current ? 'no open ask' : allowed ? 'already allowed' : offer !== undefined && offer !== current ? 'an older notice' : 'its claim has ended'})`)
      // A question about a claim that has ended is closed whichever notice was pressed.
      if (stale) this.closeAsk(key)
      if (offer !== undefined) resolveOffer(offer, tr(OUTCOME.noLongerAsked))
      else resolveOffers((o) => o.startsWith(`lock:${key}#`), tr(OUTCOME.noLongerAsked))
      return
    }
    resolveOffer(current, tr(OUTCOME.allowed))
    log.info(`Lock: ${userText(this.label(l.state))} allowed to edit ${userText(basename(path))} (${l.state.status})`)
    // Answered: no longer open (HI-2386: asks outlive the turn's end, so a later block asks again rather than waiting on
    // this one).
    this.lockAsked.delete(key)
    this.lockAskClaim.delete(key)
    // The user's answer ends the block it asked about (HI-982).
    if (l.hookBlock && `${id}|${l.hookBlock.key}` === key) l.hookBlock = undefined
    // Against the claim it asked about only (HI-2386).
    const against = claim ?? this.locks.get(file)?.claim ?? 0
    this.lockAllowed.set(key, ++this.lockSeq)
    this.lockAllowedClaim.set(key, against)
    this.lockGoAhead.set(key, { path, allowed: against })
    this.sendGoAheads(id, l)
  }

  /**
   * Gives the agent one go-ahead for its allowed files (and those whose claim it waited on ended, HI-2386) once its turn
   * has ended: a delivery (#649: a control notice for this launch) the delivery service offers as any line of Combwork's is,
   * only while it is free and the user isn't writing in its terminal (Pause after you type), checked again until Enter,
   * so the user's input is never added to or sent. The allowed files are allowed again for the turn it starts. Not typed
   * yet, it waits (the user's own prompt, or a wake, went first; the files stay allowed for it, and the next turn's end
   * gives it again).
   */
  private sendGoAheads(id: string, l: LiveSession): void {
    const { projectPath, agentId, runId } = l.state
    const keys = [...this.lockGoAhead.keys()].filter((k) => k.startsWith(`${id}|`))
    if (!keys.length || (l.state.status !== 'ready' && l.state.status !== 'finished') || this.live.get(id) !== l) return
    const given = keys.map((k) => this.lockGoAhead.get(k)!)
    keys.forEach((k, i) => {
      const against = given[i].allowed
      if (against === undefined) return
      this.lockAllowed.set(k, ++this.lockSeq)
      this.lockAllowedClaim.set(k, against)
    })
    // This delivery's go-aheads, still wanted: an interrupt, the edit going ahead, or the session ending or moving
    // (dropGoAheads, editAccepted) cancels it, even part-way; so does one changed since (claimsEnded).
    const current = (): boolean => this.live.get(id) === l && keys.every((k, i) => this.lockGoAhead.get(k) === given[i])
    this.delivery()
      .give(projectPath, { agentId, kind: 'control', from: CW_SENDER, body: goAheadPrompt(l.state.cwd, given), source: 'go-ahead', ref: runId, replace: true, need: 'free', forRun: runId }, {
        holds: current,
        received: () => keys.forEach((k, i) => this.lockGoAhead.get(k) === given[i] && this.lockGoAhead.delete(k))
      })
      .catch((e: Error) => log.info(`${userText(this.label(l.state))}: go-ahead for a locked edit not given: ${e.message}`))
  }

  /**
   * Releases an agent's file locks, approvals and questions: all of them, or (`before`, a lockSeq) those from
   * before then, so a turn's end handled late keeps what the next turn has claimed since. A turn's end keeps the
   * questions (HI-2386): the agent blocked by one ends its turn within seconds to wait for the user's answer, and its
   * notice's Allow stays open for that answer until the user gives it, the edit goes ahead (editAccepted), the claim
   * it asked about ends (claimsEnded), or the session ends or moves.
   */
  private releaseLocks(id: string, before = Infinity): void {
    for (const [k, seq] of this.lockAllowed)
      if (k.startsWith(`${id}|`) && seq <= before) {
        this.lockAllowed.delete(k)
        this.lockAllowedClaim.delete(k)
      }
    // An ask let go unanswered (the session ended or moved): its notice's Allow goes (HI-2320).
    if (before === Infinity) for (const k of [...this.lockAsked.keys()]) if (k.startsWith(`${id}|`)) this.closeAsk(k)
    // A go-ahead waits for the turn's end, so only releasing everything (the session ended or moved) drops it.
    if (before === Infinity) this.dropGoAheads(id)
    const ended = new Map<string, FileLock>()
    for (const [k, v] of this.locks) {
      if (v.liveId === id && v.seq <= before) {
        this.locks.delete(k)
        ended.set(k, v)
      }
    }
    if (ended.size) {
      this.publishLocks(id)
      this.claimsEnded(ended)
    }
  }

  private dropGoAheads(id: string): void {
    let had = false
    for (const k of this.lockGoAhead.keys())
      if (k.startsWith(`${id}|`)) {
        this.lockGoAhead.delete(k)
        had = true
      }
    // Its delivery, if it was given one, no longer holds: cancelled now, rather than at its next try.
    const l = this.live.get(id)
    // A delivery's record, which agents and the log read: stored, said in the Default.
    if (had && l) void this.deliveries?.cancel(l.state.projectPath, 'go-ahead', l.state.runId, inDefaultDialect(() => say(SESSION.lock.goAheadDropped))).catch(() => undefined)
  }

  private publishLocks(id: string): void {
    const l = this.live.get(id)
    if (!l) return
    const files: string[] = []
    for (const v of this.locks.values()) if (v.liveId === id) files.push(placeRelative(l.state.cwd, v.path).replace(/\\/g, '/'))
    l.state.lockedFiles = files.length ? files : undefined
    this.emitState(l.state)
  }

  /** Each launch's hooks (and its title's changes: watchTitle), handled one at a time in the order they came. */
  private hookQueues = new Map<string, Promise<void>>()

  /**
   * The notice for what the agent has unread (#650, inboxNotices.ts): Combwork's fixed text, or null when there is nothing
   * to tell. At a checkpoint (a tool call of the agent's own ended) or its turn's end (the drain: a reply that carries
   * the turn on). The turn ledger counts a turn's end only from a Stop answered with nothing, as continuations fire no
   * prompt (#648).
   */
  inboxNotice: ((state: LiveSessionState, at: 'checkpoint' | 'drain') => Promise<NoticeDraft | string | null> | NoticeDraft | string | null) | null = null

  /**
   * What Combwork answers a hook call with (the hook server sends it, then calls handleHook with the same body): a
   * PreToolUse's file-lock decision (made at once, before anything is awaited: it claims locks in the order hooks came);
   * for a hook that may carry a notice (a tool's end, a Stop: noticeReply), a reply decided in the launch's hook order by
   * handleHookNow, once the turn ledger has the hooks before it (#650: the ledger's verdict and turn, never a view of its
   * own); else nothing.
   */
  hookReply(runId: string | null, body: Record<string, any>): Promise<Record<string, unknown> | null> {
    // What a hook's reply says is said to its session, in its pinned chain (HI-2443).
    return this.inLaunchDialect(runId, body.session_id, () => this.hookReplyHere(runId, body))
  }

  /** Runs fn in the dialect of the launch a hook comes from (HI-2443); a hook of no running launch, as it is. */
  private inLaunchDialect<T>(runId: string | null, sessionId: unknown, fn: () => T): T {
    const st = this.findLaunch(runId, sessionId)?.[1].state
    return st ? inDialectOf({ projectPath: st.projectPath, agentId: st.agentId }, fn) : fn()
  }

  private hookReplyHere(runId: string | null, body: Record<string, any>): Promise<Record<string, unknown> | null> {
    // A CLI whose start context goes into its session (HI-2771): its start step answers once it is done (or out of time).
    const intoSession = this.sessionContextStep(runId, body)
    if (intoSession) return intoSession
    if (body.hook_event_name === 'SessionStart') return this.startReply(runId, body)
    const afterCompaction = this.compactionContextReply(runId, body)
    if (afterCompaction) return afterCompaction
    if (body.hook_event_name === 'PreToolUse') {
      const lock = this.preToolUse(runId, body)
      // A CLI that takes no answer as a denial (HI-2545: agy) gets its own allow for a tool Combwork doesn't refuse.
      return Promise.resolve(lock ?? this.findLaunch(runId, body.session_id)?.[1]?.adapter.preToolUseDefault?.() ?? null)
    }
    if (!this.inboxNotice) return Promise.resolve(null)
    const l = this.findLaunch(runId, body.session_id)?.[1]
    if (!l) return Promise.resolve(null)
    const raw = String(body.hook_event_name ?? '')
    // A CLI whose events say what they are only once prepared (HI-2545: agy's PreInvocation and Stop): its reply is
    // decided in the launch's order (noticeIn, after prepareHook), and always settled there.
    if (l.adapter.noticeEvents?.includes(raw)) return new Promise((settle) => this.noticeReplies.set(body, settle))
    const hook = l.adapter.normalizeHook(body)
    const ev = hook.event
    // Never a sub-agent's (its context isn't the agent's), nor a Stop that follows a continuation (stop_hook_active).
    if (hook.ids.sub || !(ev.kind === 'toolEnd' || (ev.kind === 'stop' && !ev.failed && !hook.ids.continued))) return Promise.resolve(null)
    // An event this CLI can't carry a notice on is never asked about.
    if (!l.adapter.noticeReply(String(body.hook_event_name ?? ''), NOTICE_PREFIX)) return Promise.resolve(null)
    return new Promise((settle) => this.noticeReplies.set(body, settle))
  }

  /**
   * Context for a session as it starts, resumes or comes back from a compaction (#1032: the Assistant's state view), or
   * null for none. Given the launch's state and the start's source (startup, resume, clear, compact).
   */
  startContext: ((state: LiveSessionState, source: string | null) => Promise<string | null>) | null = null

  /** A SessionStart's reply: the start context, where the CLI can carry it (startContextReply); never a sub-agent's. */
  private async startReply(runId: string | null, body: Record<string, any>): Promise<Record<string, unknown> | null> {
    const l = this.findLaunch(runId, body.session_id)?.[1]
    if (!l || !this.startContext || !l.adapter.startContextReply) return null
    // A CLI whose hooks say what they are only once prepared (HI-2545: agy's SessionStart, unprepared, is nothing): its
    // reply is decided in the launch's order, after prepareHook (handleHookIn), and always settled there (HI-2548).
    if (l.adapter.prepareHook) return new Promise((settle) => this.noticeReplies.set(body, settle))
    const hook = l.adapter.normalizeHook(body)
    if (hook.ids.sub || hook.event.kind !== 'start') return null
    return this.startContextFor(l, hook.event.source)
  }

  /** Launches whose start context is due with their next prompt: compacted, on a CLI that starts no session then. */
  private contextDue = new WeakSet<LiveSession>()

  /**
   * On a CLI that starts no session after a compaction (startContextAfterCompaction 'prompt': Copilot, #1065), its
   * compaction makes the start context due, and the next prompt hook's reply carries it, once (source compact). Null
   * for any other hook, which hookReply then answers as usual.
   */
  private compactionContextReply(runId: string | null, body: Record<string, any>): Promise<Record<string, unknown> | null> | null {
    if (!this.startContext) return null
    const l = this.findLaunch(runId, body.session_id)?.[1]
    if (!l || l.adapter.startContextAfterCompaction !== 'prompt') return null
    const hook = l.adapter.normalizeHook(body)
    if (hook.ids.sub) return null
    if (hook.event.kind === 'compactStart') this.contextDue.add(l)
    else if (hook.event.kind === 'prompt' && this.contextDue.delete(l)) return this.startContextFor(l, 'compact')
    return null
  }

  /** The whole start step's budget (HI-2771): building the view and putting it, well inside the launcher's 5 s wait. */
  static readonly SESSION_CONTEXT_MS = 2500
  /** Each launch's start context in its session (HI-2771): its start step taken, compactions refreshed, its queue, its generation. */
  private sessionContexts = new WeakMap<LiveSession, { started: boolean; compactions: Set<string>; chain: Promise<void>; gen: number }>()
  /** The post that was its launch's start (its first baseline): its own expanded hooks are history the start's view covers. */
  private startPosts = new WeakSet<object>()

  private sessionContextOf(l: LiveSession): { started: boolean; compactions: Set<string>; chain: Promise<void>; gen: number } {
    const s = this.sessionContexts.get(l) ?? { started: false, compactions: new Set<string>(), chain: Promise.resolve(), gen: 0 }
    this.sessionContexts.set(l, s)
    return s
  }

  /**
   * On a CLI whose start context goes into its session (startContextTrigger): at its launch's start (its first baseline,
   * before its TUI takes input) the step that puts or removes it, answered once done or out of time. Null for any other
   * post (a compaction's refresh comes from its hooks, compactionIntoSession).
   */
  private sessionContextStep(runId: string | null, body: Record<string, any>): Promise<null> | null {
    const l = this.findLaunch(runId, body.session_id)?.[1]
    const trigger = l?.adapter.deliverStartContext ? l.adapter.startContextTrigger?.(body) : null
    if (!l || trigger?.source !== 'start') return null
    const s = this.sessionContextOf(l)
    if (s.started) return null
    s.started = true
    this.startPosts.add(body)
    return this.deliverSessionContext(l, s, l.resumed ? 'resume' : 'startup')
  }

  /**
   * A compaction's end, as the CLI's hooks have it (HI-2771: OpenCode's tracker makes compactEnd of a live event, or of a
   * resync's snapshot that finds one completed while the stream was down): the view refreshed in its session, each
   * compaction once by its identity (its turn), queued behind the launch's deliveries. Not one the start's own post
   * brings (closed history the start's view already covers), nor a sub-agent's.
   */
  private compactionIntoSession(l: LiveSession, post: Record<string, any>, hook: NormalizedHook): void {
    if (!l.adapter.deliverStartContext || hook.event.kind !== 'compactEnd' || hook.ids.sub || this.startPosts.has(post)) return
    const s = this.sessionContextOf(l)
    const id = hook.ids.turn ?? ''
    if (s.compactions.has(id)) return
    s.compactions.add(id)
    void this.deliverSessionContext(l, s, 'compact')
  }

  /**
   * One delivery, queued behind the launch's last (one at a time, so an older view never lands after a newer one), within
   * SESSION_CONTEXT_MS: the view built and put (the Assistant's, its journal on, guidance on, not kept out), else Combwork's
   * entry removed. Dropped before it sends when a newer delivery was asked for, the launch is no longer this agent's
   * running one, or its session changed; its request cut off at the deadline is uncertain, never taken as delivered.
   */
  private deliverSessionContext(l: LiveSession, s: { chain: Promise<void>; gen: number }, source: string): Promise<null> {
    const gen = ++s.gen
    const sessionId = l.state.sessionId
    const current = (signal: AbortSignal): boolean => !signal.aborted && gen === s.gen && this.live.get(liveId(l.state.projectPath, l.state.agentId)) === l && l.state.sessionId === sessionId
    const barred = (): boolean => l.policy?.guidance === false || !!this.keepsOut(l.state.projectPath, l.state.agentId)
    const run = s.chain.then(async () => {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), SessionManager.SESSION_CONTEXT_MS)
      try {
        if (!current(ac.signal) || !sessionId) return
        const built = !barred() && this.startContext ? this.startContext(l.state, source).catch(() => null) : Promise.resolve(null)
        const text = await Promise.race([built, new Promise<null>((done) => ac.signal.addEventListener('abort', () => done(null), { once: true }))])
        // Asked again once it is made (as startContextFor): out of time, superseded, or barred meanwhile, nothing is sent.
        if (!current(ac.signal)) return
        const outcome = await l.adapter.deliverStartContext!(l.state.runId, sessionId, text && !barred() ? text : null, ac.signal)
        log.info(`start context into ${l.state.agentId}'s session (${source}): ${outcome}`)
      } catch (e) {
        log.warn('start context into a session', e)
      } finally {
        clearTimeout(timer)
      }
    })
    s.chain = run.catch(() => undefined)
    return run.then(() => null, () => null)
  }

  /** The start context for a launch, in its CLI's reply form, or null (none, or it couldn't be made). */
  private async startContextFor(l: LiveSession, source: string | null): Promise<Record<string, unknown> | null> {
    if (!this.startContext || !l.adapter.startContextReply) return null
    // Context of Combwork's (HI-2670): never without its guidance, nor into an agent Combwork keeps out of.
    const barred = (): boolean => l.policy?.guidance === false || !!this.keepsOut(l.state.projectPath, l.state.agentId)
    if (barred()) return null
    try {
      const text = await this.startContext(l.state, source)
      // Asked again once it is made (HR1 on s44): made Independent meanwhile, it gets none.
      return text && !barred() ? l.adapter.startContextReply(text) : null
    } catch (e) {
      log.warn('start context', e)
      return null
    }
  }

  /** What Combwork observes of each hook it handles (HI-982), by its body, while it handles it. */
  private hookObs = new WeakMap<object, HookObservation>()

  /**
   * A hook arriving on its launch's own authenticated route (the hook server, HI-982): its observation, which its lock
   * decision and the turn ledger fill in, for the launch's Hooks dialog; null when no launch of Combwork's has it.
   */
  observeHook(runId: string | null, body: Record<string, any>): HookObservation | null {
    const l = this.findLaunch(runId, body.session_id)?.[1]
    if (!l?.hookHistory) return null
    const event = clip(typeof body.hook_event_name === 'string' ? body.hook_event_name : '?', HOOK_SHORT_MAX).text
    ;(l.heard ??= new Set()).add(event)
    const obs: HookObservation = { l, started: performance.now(), fired: { at: Date.now(), event, receiver: l.hooks?.receivers[event] ?? 'combwork', response: 'none', ledger: 'none', ms: 0 } }
    this.hookObs.set(body, obs)
    return obs
  }

  /**
   * A hook handled (HI-982): its reply (context, where its lock decision said nothing) or its error, and how long Combwork
   * took, kept in its launch's history (the newest HOOK_FIRED_MAX). Never logged: the history is the dialog's alone.
   */
  hookHandled(obs: HookObservation, reply: unknown, error?: { step: string; error: unknown }): void {
    const f = obs.fired
    if (error) Object.assign(f, { response: 'error', why: clip(`${error.step}: ${error.error instanceof Error ? error.error.message : String(error.error)}`, HOOK_SHORT_MAX).text })
    else if (f.response === 'none' && reply && typeof reply === 'object' && Object.keys(reply).length) f.response = 'context'
    f.ms = Math.round(performance.now() - obs.started)
    const history = obs.l.hookHistory
    if (!history) return
    history.push(f)
    if (history.length > HOOK_FIRED_MAX) history.splice(0, history.length - HOOK_FIRED_MAX)
  }

  /**
   * An agent's hooks for its Hooks dialog (HI-982): its launch's (runId), what it has (listed again: the CLI asked now, or
   * its files compared with the launch's) and what Combwork received, newest first. Null when it isn't running.
   */
  async sessionHooks(projectPath: string, agentId: string): Promise<SessionHooks | null> {
    const l = this.live.get(liveId(projectPath, agentId))
    if (!l?.hooks || !l.hookHistory) return null
    const { runId, provider } = l.state
    const listing = l.hooks.now ? await l.hooks.now().catch((e: Error) => ({ ...l.hooks!.listing, notes: [...l.hooks!.listing.notes, { kind: 'cliUnknown' as const, why: clip(e.message, HOOK_SHORT_MAX).text }] })) : l.hooks.listing
    return { runId, provider, listing, fired: [...l.hookHistory].reverse() }
  }

  /**
   * The project's lock blocks standing now (HI-982, Activity): each agent's latest blocked (or asked) edit while the
   * holder whose lock blocked it, in that launch, still holds the file and the blocked launch hasn't moved on since
   * (another tool call, the call's end, its turn's end, the user's answer: those drop it). The holder is named only when
   * it is in the same project.
   */
  hookBlocks(projectPath: string): ActivityHookBlock[] {
    return this.projectStates(projectPath).flatMap((state): ActivityHookBlock[] => {
      const l = this.live.get(liveId(projectPath, state.agentId))
      const b = l?.hookBlock
      if (!l || !b || b.runId !== state.runId) return []
      const held = this.locks.get(b.key)
      const holder = held?.liveId === b.holderLiveId ? this.live.get(b.holderLiveId) : undefined
      if (!holder || holder.state.runId !== b.holderRunId || Date.now() - held!.at >= LOCK_TTL_MS) return []
      const file = (placeRelative(state.cwd, b.file) || basename(b.file)).replace(/\\/g, '/')
      const same = holder.state.projectPath.toLowerCase() === projectPath.toLowerCase()
      return [{ key: `${b.runId}|${b.toolUseId ?? ''}|${b.key}|${b.holderRunId}`, agentId: state.agentId, file, holder: same ? (holder.state.agentName ?? holder.state.agentId) : null, kind: b.kind, at: b.at }]
    })
  }

  /** Hook calls whose reply waits for its place in the launch's hook order (hookReply), by their body. */
  private noticeReplies = new WeakMap<object, (reply: Record<string, unknown> | null) => void>()

  /**
   * Whether no notice of Combwork's may go into a launch's context now (HI-2670): launched without Combwork's typing or
   * tools, or its agent Independent now. Asked before a notice is worked out and again once it is, before it is given.
   */
  private noticeBarred(l: LiveSession): boolean {
    return l.policy?.typing === false || l.policy?.tools === false || !!this.keepsOut(l.state.projectPath, l.state.agentId)
  }

  /**
   * The notice for a hook in the launch's order (#650), with the turn ledger as it is just before it (nothing else of the
   * launch is handled while this is worked out): none for a hook the ledger finds stale; a checkpoint after the agent's
   * own tool call; the drain at a Stop of the running turn that Combwork hasn't carried on yet (the ledger's own count, so at
   * most once a turn, whatever a Stop says of it). Null when there is nothing to tell.
   */
  private async noticeIn(runId: string | null, l: LiveSession, ledger: TurnLedger, body: Record<string, any>, woke: boolean, typed: boolean, at: number): Promise<Record<string, unknown> | null> {
    if (!this.inboxNotice) return null
    // Never into a launch without Combwork's typing or tools, nor an agent Independent now (HI-2670): its hooks still
    // report its status, and add nothing to its context.
    if (this.noticeBarred(l)) return null
    const hook = l.adapter.normalizeHook(body)
    const ev = hook.event
    const raw = String(body.hook_event_name ?? '')
    // A notice event as prepared (HI-2545, agy): never a sub-agent's, a turn's start, or one its CLI says carries none (a
    // place that had one already).
    if (l.adapter.noticeEvents?.includes(raw)) {
      if (hook.ids.sub || ev.kind === 'prompt' || (ev.kind === 'stop' && (ev.failed || hook.ids.continued))) return null
      if (ev.kind !== 'stop' && ev.kind !== 'ignore') return null
      // A checkpoint between a turn's model calls: only in that very turn, while it runs (its id the active one).
      if (ev.kind === 'ignore' && (!hook.ids.turn || ledger.active?.id !== hook.ids.turn || ledger.active.state !== 'running')) return null
      if (l.adapter.noticeWanted && !l.adapter.noticeWanted(body, (l.hookMemo ??= {}))) return null
    }
    // What the ledger would make of it (a copy: it is admitted below, with what it was told).
    if (admit(structuredClone(ledger), ev, hook.ids, { woke, typed, now: at }).verdict === 'stale') return null
    const drain = ev.kind === 'stop'
    if (drain && !(ledger.active && ledger.active.state === 'running' && ledger.active.continued === 0)) return null
    const turn = ledger.active
    // Drafted, not yet told (HI-2545): its deliveries count as told only once a reply below carries it.
    const drafted = await this.inboxNotice(l.state, drain ? 'drain' : 'checkpoint')
    const text = typeof drafted === 'string' ? drafted : (drafted?.text ?? null)
    // Still that launch and that turn (the queue holds the rest of the launch's hooks, so only its end can change them),
    // and still one Combwork may add to (HR1 on s44: made Independent while the notice was worked out, it gets none).
    if (!text || this.findLaunch(runId, body.session_id)?.[1] !== l || ledger.active !== turn || this.noticeBarred(l)) return null
    // Past the time its CLI waits for this reply (HI-2545): the reply never reaches it, so the notice isn't given.
    const deadline = l.adapter.noticeDeadlineMs?.(raw)
    if (deadline != null && Date.now() - at >= deadline) return null
    const reply = l.adapter.noticeReply(raw, text)
    // A CLI that takes the drain as a new prompt: that prompt is Combwork's own, in the turn it carries on.
    if (reply && drain && l.adapter.drainIsPrompt) expectInjected(ledger, text)
    if (reply) {
      l.adapter.noticeGiven?.(body, (l.hookMemo ??= {}))
      if (drafted && typeof drafted === 'object') drafted.commit()
    }
    return reply
  }

  /**
   * Handles a hook call from an agent's CLI, answered with `reply` (hookReply's, which may still be on its way: it is
   * waited for in the launch's order). One launch's hooks run in order: an older one that awaits (recording the
   * session) must not land after a newer one's status.
   */
  handleHook(runId: string | null, body: Record<string, any>, reply: unknown = null): Promise<void> {
    // A turn's end releases only the locks claimed before it arrived: PreToolUse claims them at once, outside this queue.
    const arrived = this.lockSeq
    // When it reached Combwork, before it waits its turn: a turn begins then, for comparing with the CLI's records (#648).
    const at = Date.now()
    const launch = this.findLaunch(runId, body.session_id)?.[1]
    // The launch's hooks before this one: what the old conversation had seen, if this one switches conversations.
    const before = launch?.hooksSeen ?? 0
    if (launch) {
      launch.hooksSeen = before + 1
      launch.lastHookAt = at
    }
    // Its start is heard (#1336); whether it answers a prompt is the turn ledger's to say, in the launch's order.
    if (launch?.hooksWatch) hookSeen(launch.hooksWatch, at)
    // Handled in its session's pinned chain (HI-2443): what it tells the agent (a notice, a doorbell) is said in it.
    return this.inLaunchDialect(runId, body.session_id, () => this.inHookOrder(runId ?? `session:${String(body.session_id ?? '')}`, () => this.handleHookNow(runId, body, arrived, before, reply, at)))
  }

  /** Runs `fn` after what is queued for the launch (its hooks, its title), in the order they came. */
  private inHookOrder(key: string, fn: () => Promise<void> | void): Promise<void> {
    const run = (this.hookQueues.get(key) ?? Promise.resolve()).then(fn)
    const tail = run.catch(() => undefined)
    this.hookQueues.set(key, tail)
    void tail.then(() => {
      if (this.hookQueues.get(key) === tail) this.hookQueues.delete(key)
    })
    return run
  }

  private async handleHookNow(runId: string | null, body: Record<string, any>, arrived: number, hooksBefore: number, replying: unknown = null, at = Date.now()): Promise<void> {
    // A reply decided here, in the launch's order (#650: a notice), is sent as soon as it is known, and always at the end.
    const pending = this.noticeReplies.get(body)
    this.noticeReplies.delete(body)
    let reply: unknown = pending ? null : await Promise.resolve(replying).catch(() => null)
    try {
      await this.handleHookIn(runId, body, arrived, hooksBefore, at, reply, pending ? (r) => {
        reply = r
        pending(r)
      } : null)
    } finally {
      pending?.((reply as Record<string, unknown> | null) ?? null)
    }
  }

  private async handleHookIn(runId: string | null, body: Record<string, any>, arrived: number, hooksBefore: number, at: number, given: unknown, decide: ((reply: Record<string, unknown> | null) => void) | null): Promise<void> {
    let reply = given
    const found = this.findLaunch(runId, body.session_id)
    if (!found) return
    const [id, l] = found
    const st = l.state
    // What the hook needs from the CLI's own records first (HI-2545: the Antigravity CLI's user prompt), in this order.
    // Any hook of the launch is news of it: a status line's idle no longer stands for a silent end (idleGrace).
    this.cancelIdleGrace(l)
    if (l.adapter.prepareHook) {
      await l.adapter.prepareHook(body, { agentId: st.agentId, workspacePath: workspaceOf(st.projectPath).path!, sessionId: st.sessionId, memo: (l.hookMemo ??= {}), alive: () => this.live.get(id) === l }).catch((e) => log.warn(`${userText(this.label(st))}: could not read what its hook needs`, e))
      if (this.live.get(id) !== l) return
    }
    // A body that stands for several hooks (HI-2760: OpenCode's forwarded events and snapshots, which its prepareHook
    // turns into zero or more): each is handled in turn, in this same place in the launch's order, as a hook of its own.
    if (Array.isArray(body.combworkExpanded)) {
      for (const sub of body.combworkExpanded as Record<string, any>[]) {
        if (this.live.get(id) !== l) return
        // A compaction's end among them (live, or recovered by a resync): the start context refreshed in the session (HI-2771).
        if (l.adapter.deliverStartContext) this.compactionIntoSession(l, body, l.adapter.normalizeHook(sub))
        await this.handleHookIn(runId, sub, arrived, hooksBefore, at, null, null)
      }
      return
    }
    const hook = l.adapter.normalizeHook(body)
    const label = this.label(st)
    flightRecorder.arrived(st, () => label, 'hook', body)
    // Still this launch after each wait below (#650): one stopped or started again meanwhile gets nothing more of this
    // hook (no reply, status, actions or notification of the old one over the new).
    const current = (): boolean => this.live.get(id) === l
    // The user started or opened another conversation in the CLI (/clear, /new, /resume): follow it. Only a
    // prompt switches, since helpers the CLI runs for itself (subagents) can report other session ids.
    if (hook.event.kind === 'prompt' && st.sessionId && hook.sessionId && hook.sessionId !== st.sessionId && isSessionId(hook.sessionId)) {
      await this.switchSession(l, hook.sessionId, hook.transcriptPath, hooksBefore)
      if (!current()) return
    } else if (hook.transcriptPath && hook.transcriptPath !== l.transcriptPath) l.transcriptPath = hook.transcriptPath
    // Providers that choose their own session id report it here (the first hook of the launch).
    if (!st.sessionId && hook.sessionId) {
      try {
        st.sessionId = assertSessionId(hook.sessionId)
        const { agent } = await this.agentDef(st.projectPath, st.agentId)
        if (!current()) return
        await this.recordSession(st.projectPath, agent, l)
        if (!current()) return
        this.emitState(st)
        workspaceOf(st.projectPath).scheduleRefresh()
      } catch (e) {
        if (!current()) return
        log.warn(`${userText(label)}: could not record session ${hook.sessionId}`, e)
      }
    }
    if (hook.mode && (hook.mode !== st.permissionMode || hook.mode !== st.modeObserved)) {
      this.observeMode(l, hook.mode)
      this.emitState(st)
    }
    // The turn ledger first (#648): a hook about a turn that is over is old news, and a Stop Combwork carried on isn't an end.
    const ledger = (l.ledger ??= newLedger())
    const ids = hook.ids
    // The transcript turn it names is heard (#1371), whatever the ledger makes of it and whether or not an alarm stands:
    // it answers that turn and those placed before it (the one transition, hooksHealth's hookTurn).
    const answered = !!l.hooksWatch && hookTurn(l.hooksWatch, at, ids.turn, hook.event.kind === 'prompt' ? (hook.event.text ?? null) : null)
    const before = st.status
    // A CLI that wakes when its background tasks end begins that turn itself: while its transcript says one just ended
    // (never merely because one runs), a tool call it never saw may open that turn should its prompt hook be lost
    // (turnLedger rule 1).
    const woke = l.adapter.descriptor.capabilities.backgroundWakes && !!l.woke
    // A CLI that may begin the turn the user's typing starts with no prompt hook (HI-2673, Claude Code's `!` command): while
    // the user's Enter into the idle pane waits for its hook, a new tool call of a turn never seen may open that turn.
    const typed = l.adapter.descriptor.capabilities.typedTurnsWithoutPrompt && typedPending(l.hooksWatch)
    // Its notice (#650), from the ledger as it is now, before it is admitted with what it was told.
    if (decide) {
      // A SessionStart whose CLI says what it is only once prepared (HI-2548: agy's, startReply): its start context, the
      // launch's own start only, never a sub-agent's.
      const starting = body.hook_event_name === 'SessionStart'
      reply = await (starting ? (hook.ids.sub || hook.event.kind !== 'start' ? Promise.resolve(null) : this.startContextFor(l, hook.event.source)) : this.noticeIn(runId, l, ledger, body, woke, typed, at)).catch((e) => {
        log.warn(`${userText(label)}: ${starting ? 'no start context' : 'no inbox notice'}`, e)
        return null
      })
      if (!current()) return
      decide(reply as Record<string, unknown> | null)
    }
    const continued = hook.event.kind === 'stop' && !hook.event.failed && !!reply && typeof reply === 'object' && l.adapter.stopContinues(reply as Record<string, unknown>)
    const was = ledger.active
    const took = admit(ledger, hook.event, ids, { combworkContinued: continued, woke, typed, now: at })
    if (ledger.active !== was) l.woke = false
    // Its CLI tries a failed model request again (HI-1973: Copilot's recoverable error): the turn's wait, kept from try to
    // try while nothing else is heard (its first try's time, the tries counted). The CLI says neither when it tries again
    // nor how often it will: both unknown, never made up.
    if (took.verdict !== 'stale' && hook.event.kind === 'retry') {
      const turn = ledger.active
      if (turn?.state === 'running') {
        const prev = l.retryTurn === turn ? st.retryWait : undefined
        const told = new Date(at).toISOString()
        st.retryWait = { at: told, since: prev?.since ?? told, retryAt: null, attempt: (prev?.attempt ?? 0) + 1, max: null, status: hook.event.status, ...(hook.event.network ? { network: true as const } : {}) }
        l.retryTurn = turn
        this.emitState(st)
      }
    }
    // Its CLI is heard from again (HI-1972): whatever it waited to retry has gone on.
    else if (took.verdict !== 'stale' && st.retryWait) {
      endRetryWait(st, at)
      this.emitState(st)
    }
    // What the ledger made of it, for the Hooks dialog (HI-982), apart from Combwork's reply: an ignored hook may have had one.
    const obs = this.hookObs.get(body)
    if (obs) Object.assign(obs.fired, took.verdict === 'stale' ? { ledger: 'ignored', ledgerWhy: clip(took.why, HOOK_SHORT_MAX).text } : { ledger: took.verdict === 'apply' ? 'applied' : 'continued' })
    // What ends a lock block's decision (HI-982): the blocked call's end, or its turn's (a new prompt, a stop, the end).
    const b = l.hookBlock
    const kind = hook.event.kind
    if (b && ((kind === 'toolEnd' && !!b.toolUseId && ids.call === b.toolUseId) || (took.verdict !== 'stale' && ['prompt', 'stop', 'signIn', 'interrupt', 'end'].includes(kind)))) l.hookBlock = undefined
    // A current turn's hook (#1336): the prompt watched is answered, and missing hooks are back. A late hook of a turn
    // that is over says nothing of a prompt sent since. While the user's typed prompt waits (HI-2673), a hook of a turn
    // never seen (the ledger's `unseen`: no earlier turn's, none let go past its bound, no sub-agent's) can't be late
    // news: its turn is the one that prompt began, with no prompt hook, so it answers the prompt too.
    if (l.hooksWatch) {
      const accepted = took.verdict === 'stale' && typed && !!took.unseen
      // Remembered once accepted (HR2's round 1): the same turn's hook again is an earlier turn's, never a later prompt's.
      if (accepted && ids.turn) acceptTurn(ledger, ids.turn)
      const ofPrompt = took.verdict !== 'stale' || accepted
      if (ofPrompt) turnHeard(l.hooksWatch)
      // A flag a transcript turn raised (#1371) is answered only by that turn's hooks or a newer turn's, by identity (above):
      // the ledger's current turn may be older than it (its hooks are what went missing), so the ledger's verdict doesn't count.
      const back = st.hooksMissing?.after === 'transcript' ? answered : !!st.hooksMissing && ofPrompt
      if (back) this.hooksBack(l)
    }
    let actions: readonly string[] = [took.verdict === 'stale' ? 'stale' : 'continued']
    // Combwork went on with a turn that had been marked failed (#1658): it carries on, so it needs the user no more.
    if (took.verdict === 'continued' && st.failedTurn) this.carryOut(id, l, { next: null, failed: null, message: null, actions: [] }, 'continued')
    // A prompt about a safeguard stop says why (#606): told so now if the screen shows it, else when it draws it.
    const guard = this.guardCandidate(l, hook.event)
    if (took.verdict === 'apply') {
      let ev = took.event
      if (guard && ev.kind === 'ask') {
        if (this.guardShown(l, ev.ask)) ev = { ...ev, ask: await this.safeguardPrompt(l, ev.ask, at) }
        else l.guardAsk = { ask: ev.ask, at, applied: true }
      }
      // Hooks are handled in order, so the next one waits for this read: a turn's end counts the tasks it started.
      if (ev.kind === 'stop') await this.beforeTurnEnd(l, ev.lastMessage)
      if (!current()) return
      const step = hookStep(this.failedIfRecorded(l, ev), this.statusInput(l))
      if (ev.kind !== 'stop') this.settleFailure(id, l)
      this.carryOut(id, l, step, String(body.hook_event_name ?? ''), ev, arrived)
      actions = step.actions
      if (ev.kind !== 'ignore') (l.recentHooks ??= []).push({ kind: ev.kind, at: Date.now(), status: st.status })
      if ((l.recentHooks?.length ?? 0) > RECENT_HOOKS) l.recentHooks!.shift()
    } else if (guard && hook.event.kind === 'ask') {
      // Claude Code asks about a safeguard stop after its turn's Stop (HB3, 11 Oct), which the ledger finds stale: it is
      // put to the user anyway once its screen shows it is that prompt (at once, or as the screen draws it).
      const ask = hook.event.ask
      if (this.guardShown(l, ask)) {
        const ev: HookEvent = { kind: 'ask', ask: await this.safeguardPrompt(l, ask, at) }
        if (!current()) return
        const step = hookStep(ev, this.statusInput(l))
        this.carryOut(id, l, step, String(body.hook_event_name ?? ''), ev, arrived)
        actions = step.actions
      } else l.guardAsk = { ask, at, applied: false }
    }
    // The developer console (#636): the hook as it came, next to what Combwork made of it (with the turn ledger's verdict).
    const made = took.verdict === 'apply' ? took.event : hook.event
    devConsole.capture([sessionSourceId(st.projectPath, st.agentId)], () => {
      const name = safeWord(body.hook_event_name) || '(unnamed)'
      return { kind: 'hook', name, provider: st.provider, raw: body, made: { event: made, status: st.status, actions, ...(reply ? { reply } : {}) }, safe: { raw: HOOK_FIELDS, made: HOOK_MADE_FIELDS }, summary: hookSummary(name, body.tool_name, made.kind, st.status, [...actions], !!reply) }
    })
    this.noteTurn(l)
    if (hook.event.kind !== 'ignore' || ids.turn) {
      // i18n-ignore: the log and the hook journal (English)
      const verdict = took.verdict === 'apply' ? (took.note ?? '') : took.verdict === 'stale' ? `stale: ${took.why}` : 'carried on by Combwork'
      hookJournal(`run=${st.runId} seq=${ledger.seq} ${String(body.hook_event_name ?? '?').slice(0, 40)} turn=${ids.turn ?? '-'} call=${ids.call ?? '-'}${ids.sub ? ` sub=${ids.sub}` : ''}${ids.continued ? ' continued' : ''} ${before}→${st.status}${verdict ? ` (${verdict})` : ''}`)
    }
  }

  /** What a turn's end reads first (its Stop, or the CLI's own record of it): the folder, its background tasks, its reply. */
  private async beforeTurnEnd(l: LiveSession, lastMessage: string | null): Promise<void> {
    this.checkFolder(l.state.projectPath, l.state.cwd)
    await this.refreshBackground(l)
    this.sweepTasks(l)
    if (lastMessage) {
      l.lastReply = lastMessage.slice(0, 2000)
      // Its tile's last lines (#976), sent with the turn's end.
      l.state.replyStart = replyStart(lastMessage)
    }
  }

  /** The agent's turn as its ledger has it (LiveSessionState.turn), sent when it changed. `unknown`: its state is unknown. */
  private noteTurn(l: LiveSession, unknown?: { since: number }): void {
    const st = l.state
    const a = l.ledger?.active
    // A new turn: when it began, kept for a hand-over to itself to tell work begun after its handover was written.
    if (a && a !== l.turnSeen) {
      l.turnSeen = a
      l.turnStarts = [...(l.turnStarts ?? []), a.startedAt].slice(-20)
    }
    const turn: LiveSessionState['turn'] = !a ? undefined : unknown ? { state: 'unknown', ...(a.id ? { id: a.id } : {}), silentSince: new Date(unknown.since).toISOString() } : { state: a.state === 'running' ? 'running' : 'over', ...(a.id ? { id: a.id } : {}) }
    // A retry wait (HI-1972) is its turn's: gone with it, when it ends or another begins.
    const retryGone = !!st.retryWait && (!a || a !== l.retryTurn || a.state !== 'running')
    if (retryGone) endRetryWait(st)
    if (!retryGone && JSON.stringify(turn) === JSON.stringify(st.turn)) return
    st.turn = turn
    this.emitState(st)
  }

  /**
   * What the CLI's own records say ended the turn Combwork has running (#648), for the log; null when they don't: its record
   * of that turn by id (Codex), or of a Stop of it Combwork never got (Copilot, by when its Stops were answered).
   */
  private recordEnds(l: LiveSession): string | null {
    if (!l.ledger) return null
    const rec = l.turnRecord
    // i18n-ignore: the log and the hook journal (English)
    if (rec && reconciles(l.ledger, rec.turn, Date.parse(rec.at))) return `${l.adapter.descriptor.name} recorded the end of turn ${rec.turn} at ${rec.at}`
    // i18n-ignore: the log and the hook journal (English)
    if (unheardStop(l.ledger, l.stopsAnswered ?? [])) return `${l.adapter.descriptor.name} recorded a Stop of its running turn answered at ${new Date(l.stopsAnswered!.at(-1)!).toISOString()} that never reached Combwork`
    return null
  }

  /**
   * A turn's end as Combwork applies it (#1632), once the turn ledger has it over: the Stop of the turn a recorded failure
   * names ends it failed, with the CLI's words; a record of an older turn is dropped.
   */
  private failedIfRecorded(l: LiveSession, ev: HookEvent): HookEvent {
    const rec = l.failure
    if (ev.kind !== 'stop' || !rec || !l.ledger) return ev
    const where = failureTurn(l.ledger, rec)
    if (where === 'unknown' || where === 'running') return ev
    l.failure = undefined
    l.failureDone = rec.key
    if (where === 'older' || ev.failed) return ev
    return { kind: 'stop', lastMessage: rec.words || null, failed: true }
  }

  /**
   * Settles a recorded failure (#1632) by the turn it names (failureTurn): that turn over, it is marked failed now; a
   * newer turn begun, it is dropped; that turn running, its Stop ends it failed (failedIfRecorded); its turn unknown, it
   * waits. Run in hook order: when it is read, and after each hook. With no turn ledger yet (no hook heard), it waits.
   */
  private settleFailure(id: string, l: LiveSession): void {
    const rec = l.failure
    if (!rec) return
    const where = l.ledger ? failureTurn(l.ledger, rec) : 'unknown'
    if (where === 'unknown' || where === 'running') return
    l.failure = undefined
    l.failureDone = rec.key
    if (where === 'over') this.carryOut(id, l, { next: null, ...failedTurnStep(rec.words), actions: [] }, 'transcript')
  }

  /** The CLI recorded the end of the turn Combwork has running, whose Stop never came (#642): over, as that Stop would end it, in order with the hooks. */
  private reconcileTurn(l: LiveSession): void {
    const id = liveId(l.state.projectPath, l.state.agentId)
    void this.inHookOrder(l.state.runId, async () => {
      const why = this.live.get(id) === l ? this.recordEnds(l) : null
      if (why) await this.endTurnFrom(id, l, 'transcript', why)
    })
  }

  /** Ends the running turn on other evidence than its Stop (the CLI's record, its screen), as that Stop would; logged with what Combwork saw before. */
  private async endTurnFrom(id: string, l: LiveSession, by: 'transcript' | 'screen', why: string): Promise<void> {
    const st = l.state
    const before = st.status
    const turn = describeTurn(l.ledger!)
    endRunning(l.ledger!, by)
    const ev = this.failedIfRecorded(l, { kind: 'stop', lastMessage: null })
    await this.beforeTurnEnd(l, null)
    this.carryOut(id, l, hookStep(ev, this.statusInput(l)), by, ev)
    this.noteTurn(l)
    const seen = (l.recentHooks ?? []).map((h) => `${h.kind} ${new Date(h.at).toISOString().slice(11, 19)} → ${h.status}`).join(', ')
    log.info(`${userText(this.label(st))}: ${why}, and Combwork saw no Stop: its turn is over (${turn}; ${before} → ${st.status}; hooks before: ${seen || 'none'})`)
    hookJournal(`run=${st.runId} seq=${l.ledger!.seq} (no hook) turn over by ${by} ${before}→${st.status}`)
  }

  /** What the launch's CLI shows of its turn on screen (ProviderAdapter.turnScreen), null when it isn't read or isn't sure. */
  private screenTurn(l: LiveSession): ScreenReading {
    const screen = l.turnScreen ? l.screen?.text() : null
    return screen ? l.turnScreen!(screen) : null
  }

  /**
   * Whether its CLI is waiting to retry its model request (HI-1972: Codex after a 429 shows only "Working" for minutes):
   * once a running turn has had no hook for the adapter's while, its records are looked at, at most every
   * RETRY_LOOK_EVERY_MS and one look at a time. What a look finds is applied in hook order, only if the same launch and
   * turn still run and no hook came while it looked (a hook says something newer), and only a newer wait than the one
   * shown. It turns an unknown turn back to running (its state is known); an expired wait is cleared here, so it never
   * holds silence handling back.
   */
  private checkRetry(projectPath: string, agentId: string): void {
    const id = liveId(projectPath, agentId)
    const l = this.live.get(id)
    if (!l?.ledger) return
    const st = l.state
    const now = Date.now()
    // A wait past (a pushed one too: HI-1973's Copilot, whose adapter has nothing to look at) is cleared here.
    if (st.retryWait && !retryWaitCurrent(st.retryWait, now)) {
      endRetryWait(st, now)
      this.emitState(st)
    }
    if (!l.adapter.retryWait || !l.launchEnv) return
    const turn = l.ledger.active
    const sessionId = st.sessionId
    if (!sessionId || !turn || turn.state !== 'running' || st.status !== 'working' || l.retryLooking) return
    const lastHook = Math.max(l.lastHookAt ?? 0, turn.startedAt)
    if (now - lastHook < (l.adapter.retryLookAfterMs?.() ?? DEFAULT_RETRY_LOOK_AFTER_MS)) return
    if (l.retryLookedAt !== undefined && now - l.retryLookedAt < RETRY_LOOK_EVERY_MS) return
    l.retryLookedAt = now
    l.retryLooking = true
    const seen = l.hooksSeen ?? 0
    void l.adapter
      .retryWait({ sessionId, env: l.launchEnv, transcriptPath: l.transcriptPath, since: lastHook })
      .catch((e: unknown) => {
        log.warn(`${userText(this.label(st))}: could not look for a retry wait`, e)
        return null
      })
      .then((wait) =>
        this.inHookOrder(st.runId, () => {
          if (!wait || this.live.get(id) !== l || l.ledger?.active !== turn || turn.state !== 'running' || (l.hooksSeen ?? 0) !== seen || !retryWaitCurrent(wait)) return
          const prev = l.retryTurn === turn ? st.retryWait : undefined
          if (prev && Date.parse(wait.at) <= Date.parse(prev.at)) return
          st.retryWait = { ...wait, since: prev?.since ?? wait.since }
          l.retryTurn = turn
          // Known again: waiting to retry, not silent.
          if (st.turn?.state === 'unknown') {
            heard(l.ledger)
            this.noteTurn(l)
          }
          this.emitState(st)
          // i18n-ignore: the log (English)
          log.info(`${userText(this.label(st))}: ${l.adapter.descriptor.name} is waiting to retry its model request (${wait.status ?? 'no status'}, try ${wait.attempt}${wait.max ? `/${wait.max}` : ''}) until ${wait.retryAt ?? 'it says'}`)
        })
      )
      .finally(() => {
        l.retryLooking = false
      })
  }

  /**
   * Who is told of a retry wait that goes on (HI-1973): retryNotice.ts sets it, telling the Assistant. Null: nobody.
   */
  retryOverdue: ((st: LiveSessionState) => void) | null = null

  /**
   * A retry wait that has gone on past Settings → Advanced's while (HI-1973, `cw.retry.tellAssistantAfterSeconds`; 0:
   * never), counted from the turn's first retry: told once a turn (retryOverdue). One that ends sooner tells nothing, and
   * a later turn's is told again.
   */
  private checkRetryNotice(projectPath: string, agentId: string, now = Date.now()): void {
    const l = this.live.get(liveId(projectPath, agentId))
    const w = l?.state.retryWait
    const after = advanced.number('cw.retry.tellAssistantAfterSeconds') * 1000
    if (!l || !w || !after || !l.retryTurn || l.retryTold === l.retryTurn || !retryWaitCurrent(w, now)) return
    if (now - Date.parse(w.since) < after) return
    l.retryTold = l.retryTurn
    this.retryOverdue?.(l.state)
  }

  /**
   * A running turn Combwork has heard nothing of for a while (silentMs): its end, if the CLI's record or its screen shows it,
   * open tool calls or not (their ends may be lost too); else, after the longer silence an open call allows (a test run
   * can take long), its state is unknown (#648). Unknown isn't idle: nothing is typed into it, and the user can Mark
   * idle. Never a turn's end on the time alone.
   */
  private checkSilence(projectPath: string, agentId: string): void {
    const id = liveId(projectPath, agentId)
    const l = this.live.get(id)
    if (!l?.ledger) return
    const quiet = (): boolean => {
      const st = l.state
      const silent = silentFor(l.ledger!)
      // Its CLI says it waits to retry (HI-1972): its state is known, while that wait is current.
      if (st.retryWait && retryWaitCurrent(st.retryWait)) return false
      return silent !== null && silent >= silentMs() && st.status === 'working' && !l.compacting && !isCompacting(st)
    }
    if (!quiet()) return
    void this.inHookOrder(l.state.runId, async () => {
      if (this.live.get(id) !== l || !quiet()) return
      const st = l.state
      const recorded = this.recordEnds(l)
      if (recorded) return this.endTurnFrom(id, l, 'transcript', recorded)
      const shown = this.screenTurn(l)
      // i18n-ignore: the log and the hook journal (English)
      if (shown === 'idle') return this.endTurnFrom(id, l, 'screen', `${l.adapter.descriptor.name} is idle at its prompt on screen after ${howLong(silentFor(l.ledger!)!)} of silence${openCalls(l.ledger!) ? ' (a tool call still open)' : ''}`)
      // Visibly at work (a long reply, a long think, a tool running): heard, so not silent.
      if (shown === 'working') {
        heard(l.ledger!)
        if (st.turn?.state === 'unknown') this.noteTurn(l)
        return
      }
      if (st.turn?.state === 'unknown') return
      // A tool call still open may really be running long; only a longer silence makes its state unknown.
      if (openCalls(l.ledger!) && silentFor(l.ledger!)! < silentMs() * OPEN_CALL_SILENCE) return
      this.noteTurn(l, { since: l.ledger!.heard })
      flightRecorder.stalled(st, () => this.label(st), silentFor(l.ledger!))
      const seen = (l.recentHooks ?? []).map((h) => `${h.kind} ${new Date(h.at).toISOString().slice(11, 19)} → ${h.status}`).join(', ')
      log.info(`${userText(this.label(st))}: silent for ${howLong(silentFor(l.ledger!)!)} with no sign of its turn's end: state unknown (${describeTurn(l.ledger!)}; hooks before: ${seen || 'none'})`)
    })
  }

  /**
   * The user says an agent whose state is unknown is idle (Mark idle, #648): its turn is over. Only while its state is
   * unknown; anything Combwork hears of it in the meantime says more.
   */
  markIdle(projectPath: string, agentId: string): Promise<void> {
    const id = liveId(projectPath, agentId)
    const l = this.live.get(id)
    if (!l || l.state.turn?.state !== 'unknown') return Promise.resolve()
    return this.inHookOrder(l.state.runId, () => {
      if (this.live.get(id) !== l || l.state.turn?.state !== 'unknown' || !l.ledger) return
      const before = l.state.status
      // The user's word supersedes what Combwork thought runs (their ends may be lost too): the turn and its open tool calls
      // (the ledger's), a compaction (markedIdle ends Combwork's own), a person asked.
      endRunning(l.ledger, 'user')
      this.fact(l.state, { maintenance: null, attention: null })
      this.carryOut(id, l, markedIdle(this.statusInput(l)), 'Mark idle') // i18n-ignore: the cause, for the log
      this.noteTurn(l)
      log.info(`${userText(this.label(l.state))}: marked idle by the user (${before} → ${l.state.status})`)
      hookJournal(`run=${l.state.runId} seq=${l.ledger.seq} (no hook) marked idle by the user ${before}→${l.state.status}`)
    })
  }

  /** What the status rules need to know of a running agent. */
  private statusInput(l: LiveSession): HookStatusInput {
    const st = l.state
    return {
      status: st.status,
      statusMessage: st.statusMessage,
      askedAtStart: !!l.askedAtStart,
      compacting: l.compacting ? (l.compacting.started ? 'started' : 'requested') : null,
      backgroundWakes: l.adapter.descriptor.capabilities.backgroundWakes,
      tasks: l.tasks?.size ?? 0,
      attention: l.titleAttention ? 'title' : 'hooks',
      // The mode the CLI is in: on the CLI's own setting, the one it showed (#1284).
      reviewed: !!l.adapter.descriptor.permissionModes.find((m) => m.value === modeInEffect(st))?.reviewed,
      titleAsks: !!l.titleAsks,
      open: l.open ?? [],
      waitingOn: l.waitingOn ?? null,
      question: !!st.question,
      reviewing: !!st.review,
      safeguardPrompt: this.guardAnswerable(l),
      failedTurn: !!st.failedTurn
    }
  }

  /**
   * Carries out a status step (from a hook, or the CLI's title: `cause` says which, for the log): its actions,
   * then its status, message and question.
   */
  private carryOut(id: string, l: LiveSession, step: HookStep, cause: string, ev: HookEvent | null = null, arrived = this.lockSeq): void {
    const st = l.state
    const label = this.label(st)
    // A request that worked (a tool call, a turn that ended well). Not a prompt (sent, not yet answered), an interrupt
    // or a turn that failed on something else (a rate limit): none of those shows the CLI is signed in.
    const worked = ev?.kind === 'toolStart' || ev?.kind === 'toolEnd' || (ev?.kind === 'stop' && !ev.failed)
    // An agent a refused sign-in stopped tries again (its own prompt, Resume's) and doesn't get through (interrupted, or
    // failed on something else) while the sign-in is still expired: it needs sign-in again, not told as finished.
    if (st.signIn && this.signedOut.has(authScope(st)) && (ev?.kind === 'interrupt' || (ev?.kind === 'stop' && ev.failed)))
      step = { ...step, next: 'signin', message: null, actions: step.actions.filter((a) => a !== 'notifyFinished') }
    // Its CLI moved by itself (HI-2191: a prompt taken, a tool, a turn's end, a question of its own): its input is no
    // longer blocked, and the ask it waited on goes, a newer question's kept.
    const unblocked = l.inputBlocked && l.inputBlocked.runId === st.runId && ev && cause !== 'screen' && MOVES_INPUT.has(ev.kind) && !(ev.kind === 'prompt' && ev.injected) ? l.inputBlocked : null
    if (unblocked) {
      l.inputBlocked = undefined
      l.unanswered = 0
      st.inputBlocked = undefined
      log.info(`${userText(label)}: its input takes keys again (its CLI sent ${ev!.kind})`) // i18n-ignore: for the log
    }
    if (step.open !== undefined) l.open = step.open
    if (step.waitingOn !== undefined) l.waitingOn = step.waitingOn
    if (unblocked) l.open = l.open?.filter((a) => a !== unblocked.ask)
    for (const action of step.actions) {
      switch (action) {
        case 'answered':
          this.startupAnswered(l)
          break
        case 'prompted':
          l.prompts = (l.prompts ?? 0) + 1
          if (workspace.isAssistantHome(st.projectPath)) this.onAssistantPrompt(st.projectPath)
          // A turn its CLI started by itself (HI-2410) is never the user's reply, whatever Enter they pressed before it.
          if (ev?.kind === 'prompt' && !ev.cli) this.noteUserReply(l, ev.text)
          if (l.state.untakenLine) this.clearUntaken(l, 'its CLI took a prompt') // i18n-ignore: for the log
          break
        case 'compactBegan':
          l.compacting?.begin()
          break
        case 'compactEnded':
          l.compacting?.end()
          l.compacting = undefined
          break
        case 'autoCompact':
          // Compaction Combwork started is already shown as "Compacting…".
          toast(
            'info',
            tr(msg({ id: 'session.autoCompact.title', defaultMessage: '{agent}: compacting conversation', description: "A notice's title: an agent's CLI compacts its conversation by itself. {agent} is the agent." }), { agent: label }),
            tr(msg({ id: 'session.autoCompact.body', defaultMessage: '{provider} is summarising the context to free up space.', description: "The notice that an agent's CLI compacts its conversation by itself. {provider} is the coding agent's name." }), { provider: l.adapter.descriptor.name }),
            undefined,
            st.projectPath,
            agentTarget(st.projectPath, st.agentId, label)
          )
          break
        case 'autoCompactIdle':
          this.watchAutoCompaction(id, l)
          break
        case 'notifyWaiting':
          this.notify(st.projectPath, withValues(M.needsInput, { agent: label }), step.messageText ?? (step.message || msg({ id: 'session.notice.waitingForInput', defaultMessage: 'Waiting for your input', description: "The notification that an agent waits for the user, when its CLI didn't say what for." })), 'waiting', undefined, st.agentId)
          break
        case 'notifyQuestion':
          this.notify(st.projectPath, withValues(msg({ id: 'session.notice.question', defaultMessage: '{agent} has a question for you', description: "A notification's title: an agent asks something without stopping for it. {agent} is the agent." }), { agent: label }), step.question || msg({ id: 'session.notice.questionBody', defaultMessage: 'It carries on working meanwhile.', description: "The notification that an agent asks a question it doesn't stop for, when its CLI didn't say what." }), 'waiting', undefined, st.agentId)
          break
        case 'notifyFinished':
          // Watching its cards isn't finished: nothing for the user to look at.
          if (this.watchFor(st.projectPath, st.agentId)) break
          this.notify(st.projectPath, withValues(M.finished, { agent: label }), (ev?.kind === 'stop' && ev.lastMessage?.slice(0, 180)) || msg({ id: 'session.notice.finishedBody', defaultMessage: 'The agent has finished its task.', description: "The notification that an agent finished, when it left no last message to show." }), 'finished', st.agentName, st.agentId)
          break
        case 'releaseLocks':
          this.releaseLocks(id, arrived)
          break
        case 'releaseAllLocks':
          this.releaseLocks(id)
          break
        case 'clearTasks':
          this.clearTasks(l)
          break
        case 'idleAgain': {
          // Combwork missed how its last turn ended (#612): what it saw before, so the next time says why. Hook kinds and
          // statuses only, no user text.
          const seen = (l.recentHooks ?? []).map((h) => `${h.kind} ${new Date(h.at).toISOString().slice(11, 19)} → ${h.status}`).join(', ')
          log.info(`${userText(label)}: ${l.adapter.descriptor.name} is idle at its prompt while Combwork showed it working; idle again (hooks before: ${seen || 'none'})`)
          break
        }
        case 'signedOut':
          {
            const said = ev?.kind === 'signIn' && ev.message?.slice(0, 500)
            // The CLI's own message, or Combwork's (its English for agents, its text for the window).
            const combwork = said ? null : withValues(msg({ id: 'session.signIn.notSignedIn', defaultMessage: "{provider} isn't signed in.", description: "Why an agent's turn stopped, when its CLI didn't say: its sign-in was refused. {provider} is the coding agent's name." }), { provider: l.adapter.descriptor.name })
            // agent-stored: agentField says it for each agent where the status is sent (servers.ts statusMessageOf)
            st.signIn = { message: said || englishText(combwork!), since: new Date().toISOString(), ...(combwork ? { messageText: combwork } : {}) }
          }
          this.signInLost(st)
          break
        case 'turnEnded':
          // Not awaited: a prompt arriving meanwhile must not be overwritten by this older Stop.
          if (st.sessionId) void workspace.upsertSession(st.projectPath, { id: st.sessionId, lastActiveAt: new Date().toISOString() }).catch(() => undefined)
          void this.backup(st.projectPath, st.agentId, true).catch((e) => log.warn('transcript look failed', e))
          break
      }
    }
    // An agent stopped by a refused sign-in has carried on once a request of its own works (it keeps its mark through a
    // retry that doesn't, so Resume (n) still counts it).
    const carriedOn = !!st.signIn && worked
    if (carriedOn) st.signIn = undefined
    const needed = asksYou(st)
    // HI-2754: a prompt starts a new turn: a stop before it no longer says the latest turn was stopped.
    let turnStarted = false
    if (ev?.kind === 'prompt') {
      l.promptAt = Date.now()
      const fresh = newTurn(st.safeguard)
      if (fresh !== st.safeguard) {
        st.safeguard = fresh
        turnStarted = true
      }
    }
    const facts = this.fact(st, this.factsOf(l, step, ev, carriedOn))
    const stepped = applyStep(st, step)
    const guarded = this.settleSafeguard(l)
    // A turn's end is reported even when the status stays (its background task count may have changed).
    if (stepped || step.actions.includes('turnEnded') || carriedOn || facts || guarded || turnStarted) this.emitState(st)
    // At its prompt now: its screen looked at once for its question by itself (HI-2191), which its CLI may have drawn
    // before this hook was carried out, with nothing drawn since to look at it by.
    if (stepped && cause !== 'screen' && AT_PROMPT.has(st.status)) this.idleScreenDrawn(id, l)
    // The CLI is signed in again, for its other agents too (this one's status is already set).
    if (worked) this.signedInAgain(authScope(st))
    // A turn's end types the go-ahead for an Allow given during it; an interrupt (the user stopping it) drops it.
    if (step.actions.includes('turnEnded')) this.sendGoAheads(id, l)
    else if (step.actions.includes('releaseLocks')) this.dropGoAheads(id)
    // Why you were told an agent needs you, and when it no longer does (Help → Copy Diagnostics): never what was asked.
    // i18n-ignore: the log (English)
    const told = step.actions.includes('notifyWaiting') ? 'waits for you' : step.actions.includes('notifyQuestion') ? 'asks a question' : needed && !asksYou(st) ? 'no longer needs you' : null
    if (told) log.debug(`${userText(label)}: ${told} (${cause})`)
    // Still waiting on the block a hook ended (one that moves no status): idle again; else its new status is shown.
    if (unblocked && st.status === 'waiting' && l.waitingOn === unblocked.ask) this.carryOut(id, l, idleQuestionGone(this.statusInput(l)), 'screen')
    else if (unblocked && !stepped) this.emitState(st)
  }

  /**
   * A safeguard prompt is over once the agent no longer waits (#606): answered (idle, ready for a nudge, until it is given
   * something to do) or carried on. True when the note changed.
   */
  private settleSafeguard(l: LiveSession): boolean {
    const st = l.state
    const n = st.safeguard
    if (!n || (!n.prompt && !n.idle)) return false
    const prompt = !!n.prompt && st.status === 'waiting'
    const idle = !prompt && st.status === 'ready' && st.statusMessage === SAFEGUARD_IDLE_MESSAGE
    if (!!n.prompt === prompt && !!n.idle === idle) return false
    const { prompt: _p, idle: _i, ...rest } = n
    st.safeguard = { ...rest, ...(prompt ? { prompt } : {}), ...(idle ? { idle } : {}) }
    if (!prompt) l.guardPromptAt = undefined
    return true
  }

  /**
   * The runtime facts a hook (or the title, or the user) tells and a status step decides (#648), each from its own
   * source: the CLI is up once it reports anything; it compacts from PreCompact (mid-turn too) until PostCompact, the
   * turn's end or a prompt starting a new turn; a person is asked when the step makes it wait (until a step moves it on),
   * or a question waits beside its work; a refused sign-in until a request of its own works; stopped at SessionEnd.
   */
  private factsOf(l: LiveSession, step: HookStep, ev: HookEvent | null, carriedOn: boolean): Partial<RuntimeFacts> {
    const st = l.state
    const now = st.runtime ?? { lifecycle: 'starting', maintenance: null, attention: null, composer: 'free' }
    const out: Partial<RuntimeFacts> = {}
    if (ev?.kind === 'end') out.lifecycle = 'stopped'
    else if (step.actions.includes('signedOut')) out.lifecycle = 'signin'
    else if (carriedOn || (now.lifecycle === 'starting' && ev && ev.kind !== 'ignore' && !l.askedAtStart)) out.lifecycle = 'running'
    if (ev?.kind === 'compactStart') out.maintenance = 'compacting'
    else if (ev && (ev.kind === 'compactEnd' || ev.kind === 'stop' || ev.kind === 'interrupt' || ev.kind === 'idle' || ev.kind === 'signIn' || ev.kind === 'end')) out.maintenance = null
    // A prompt starts a turn once a compaction has begun; before Combwork's own begins, it may be the /compact Combwork typed.
    else if (ev?.kind === 'prompt' && !ev.injected && !(l.compacting && !l.compacting.started)) out.maintenance = null
    if (step.actions.includes('compactEnded')) out.maintenance = null
    const waits = step.next === 'waiting' ? true : step.next ? false : now.attention === 'waiting'
    const question = step.question !== undefined ? step.question !== null : !!st.question
    out.attention = waits ? 'waiting' : question ? 'question' : null
    return out
  }

  /**
   * Moves a running agent to the conversation the CLI switched to: the old one is backed up, the new one recorded.
   * `hooksBefore`: the launch's hooks before the prompt that switched. What the old conversation's last read finds (an
   * interrupt without a hook, #475) is older than that prompt, so it is read as of then and doesn't undo it (#517).
   */
  private async switchSession(l: LiveSession, sessionId: string, transcriptPath: string | null, hooksBefore: number): Promise<void> {
    const st = l.state
    const old = st.sessionId
    await this.backup(st.projectPath, st.agentId, true, hooksBefore).catch(() => undefined)
    await workspace.upsertSession(st.projectPath, { id: old, lastActiveAt: new Date().toISOString() }).catch(() => undefined)
    // The old conversation's backup and record are history; the move itself only while this is still the agent's launch
    // (#650: one started again meanwhile keeps its own locks, state and session to resume).
    if (!this.owns(l)) return
    log.info(`${userText(this.label(st))}: the CLI moved from session ${old} to ${sessionId}`)
    // The old conversation's long-conversation notice no longer applies (HI-2320).
    resolveOffers((o) => o.startsWith(`transcript:${liveId(st.projectPath, st.agentId)}#`), tr(OUTCOME.conversationMoved))
    try {
      const { agent, count } = await this.agentDef(st.projectPath, st.agentId)
      const existing = (await workspace.sessionsFile(st.projectPath)).sessions.find((s) => s.id === sessionId)
      if (!this.owns(l)) return
      st.sessionId = sessionId
      l.name = existing?.name || autoName(st.projectPath, agent, count)
      st.sessionName = l.name
      st.titleAtRename = existing?.titleAtRename
      st.sessionCreatedAt = existing?.createdAt ?? new Date().toISOString()
      l.transcriptPath = transcriptPath ?? existing?.transcriptPath
      l.transcriptMtime = ''
      l.detailsOffset = 0
      l.detailsMemo = undefined
      l.guardOffset = 0
      l.guardMemo = undefined
      l.guardAsk = undefined
      l.guardTurns = undefined
      // What the old conversation's records said of its turns is no record of the new one's (#648).
      l.turnRecord = undefined
      l.stopsAnswered = undefined
      // Its turns are read from the new conversation's file (#1371): the old one's are let go.
      l.turnsRead = undefined
      if (l.hooksWatch) this.turnsReset(l, l.hooksWatch)
      st.transcriptBytes = undefined
      this.clearTasks(l)
      l.lastBackupAt = undefined
      st.costUsd = undefined
      st.costEstimated = undefined
      // Free is the new conversation's to say (HI-1772): not until its record does (recordSession, below).
      st.costFree = undefined
      l.costFree = false
      l.reportedCost = undefined
      l.costAt = undefined
      this.releaseLocks(liveId(st.projectPath, st.agentId))
      await this.recordSession(st.projectPath, agent, l)
    } catch (e) {
      log.warn(`${userText(this.label(st))}: could not record session ${sessionId}`, e)
    }
    if (!this.owns(l)) return
    this.emitState(st)
    workspaceOf(st.projectPath).scheduleRefresh()
  }

  /**
   * Tells the user (and for finished/waiting, the chime), through tell() (main/notify.ts, HI-2320): a pop-up in the
   * window they are using (kept in its bell), else a Windows notification, as shared/notify.ts's table says. A waiting
   * agent's entry is its ask's offer, resolved once the agent no longer asks; a notice ('work') needs no sound. Its title
   * and body are formatted in the language Combwork shows; the Agent API's stream gets the title in English (`apiTitle`,
   * #796), and never the body.
   */
  private notify(projectPath: string, titleText: Text, bodyText: TextPart, kind: 'finished' | 'waiting' | 'notice', agentName?: string, agentId?: string, action?: { label: Text; command: string; args?: unknown[] }): void {
    const title = shownText(titleText)
    // agent-stored: agentField says the events stream's title again in each caller's dialect, from apiTitleText (apiEvents.ts, HI-2465)
    const apiTitle = englishText(titleText)
    const body = shownText(bodyText)
    if (kind !== 'notice') {
      // The window plays at most one chime every 2 seconds, so agents finishing together chime once.
      void this.effective(projectPath)
        .then((eff) => {
          if (!eff.chime) return
          // A quiet test copy records the chime and the window counts it without playing a sound.
          testNotifyLog({ kind: 'chime', projectPath })
          emit({ type: 'chime', projectPath, ...(testQuiet() ? { silent: true } : {}) })
        })
        .catch((e) => log.warn('chime: settings unavailable', e))
    }
    const notifyKind = NOTIFY_KIND[kind]
    // Finishes that come together are told in one notice ("3 agents finished in demo"); a question is told at once.
    if (kind === 'finished') {
      const { route, why } = this.routeWhy(projectPath, notifyKind)
      if (route === 'none') {
        // i18n-ignore: the log (English)
        log.info(`Notice finished not told: ${why} (${userText(title)})`)
        return
      }
      const assistant = workspace.isAssistantHome(projectPath)
      // i18n-ignore: a fallback name, never seen (every agent that finishes has its name)
      this.finishes.add({ projectPath, project: assistant ? ASSISTANT_NAME : basename(projectPath), agent: assistant ? ASSISTANT_NAME : (agentName ?? 'Agent'), ...(agentId ? { agentId } : {}), title, apiTitle, apiTitleText: titleText, body }) // agent-protocol: a fallback name, never seen
      return
    }
    this.deliver(projectPath, title, body, notifyKind, agentId, agentName, apiTitle, action && { label: shownText(action.label), command: action.command, ...(action.args ? { args: action.args } : {}) }, { apiTitleText: titleText })
  }

  /**
   * A notice about a project's work that no one agent gives (#1266: a card's request for the user, a lane's events), told
   * as every notice is (notify). `action`: its button (#1437: Start Fresh (Idle Agents)), a command of the window's,
   * shown in its pop-up and bell row while `offer` is open; `kind`: needsYou for a card that needs you (HI-2320), else
   * work. `target`: what a click opens (a card), else the project.
   */
  notice(projectPath: string, title: Text, body: TextPart, action?: { label: Text; command: string; args?: unknown[] }, extra?: { kind?: 'needsYou' | 'work'; offer?: string; target?: ToastTarget }): void {
    if (!extra?.kind && !extra?.offer && !extra?.target) return this.notify(projectPath, title, body, 'notice', undefined, undefined, action)
    // agent-stored: agentField says the events stream's title again in each caller's dialect, from apiTitleText (apiEvents.ts, HI-2465)
    this.deliver(projectPath, shownText(title), shownText(body), extra.kind ?? 'work', undefined, undefined, englishText(title), action && { label: shownText(action.label), command: action.command, ...(action.args ? { args: action.args } : {}) }, { ...extra, apiTitleText: title })
  }

  /** Where a notice about this project goes now: the settings, and the Combwork window the user is using (notifyRoute), with why for the log. */
  private routeWhy(projectPath: string, kind: NotifyKind): { route: NotifyRoute; why: string } {
    return notifyRoute(config.settings.notifications, kind, focusedCombwork(), { workspacePath: workspaceOf(projectPath)?.path ?? null, projectPath })
  }

  /**
   * Told by tell() as things are now (HI-2320). A waiting agent's is registered as its ask (askOffer), so the agent no
   * longer asking resolves it; its link is the agent's pane, or the project. `apiTitle`: its title in English, when
   * `title` is translated.
   */
  private deliver(projectPath: string, title: string, body: string, kind: NotifyKind, agentId?: string, agentName?: string, apiTitle?: string, action?: ToastAction, extra?: { offer?: string; target?: ToastTarget; apiTitleText?: TextPart }): void {
    const assistant = workspace.isAssistantHome(projectPath)
    const target: ToastTarget | undefined = extra?.target ?? (agentId ? { kind: 'agent', projectPath, agentId, name: assistant ? ASSISTANT_NAME : (agentName ?? this.agentName(projectPath, agentId)), project: assistant ? ASSISTANT_NAME : basename(projectPath) } : undefined)
    const offer = extra?.offer ?? (kind === 'needsYou' && agentId ? askOffer(projectPath, agentId) : undefined)
    tell({
      kind,
      title,
      message: body,
      apiTitle,
      ...(extra?.apiTitleText !== undefined ? { apiTitleText: extra.apiTitleText } : {}),
      projectPath,
      ...(agentId ? { agentId } : {}),
      ...(target ? { target } : {}),
      ...(action ? { actions: [action] } : {}),
      ...(offer ? { offer } : {}),
      // A Windows notification's click shows what it is about, in the window that has its project.
      onWindowsClick: () => {
        const w = this.getWindow(projectPath)
        if (!w) return
        presentWindow(w)
        if (target) emitTo(w, { type: 'menu-command', command: 'notice.openTarget', args: [target] })
        else emitTo(w, { type: 'menu-command', command: 'project.focus', args: [projectPath] })
      }
    })
  }

  /**
   * Whether a long-conversation notice's Hand Over to… is for the agent's conversation now (HI-2320): not, its notice
   * says the agent has a new conversation, and nothing is done.
   */
  handOverOfferCurrent(projectPath: string, agentId: string, sessionId: string): boolean {
    if (this.live.get(liveId(projectPath, agentId))?.state.sessionId === sessionId) return true
    resolveOffer(`transcript:${liveId(projectPath, agentId)}#${sessionId}`, tr(OUTCOME.conversationMoved))
    return false
  }

  /**
   * An agent running again (its conversation open here, or another): a Stop It and Resume offered for it no longer
   * applies (HI-2320, the Assistant's scope for round 3: that session over, the entry resolves; no other live checks).
   */
  private recheckOffers(l: LiveSession): void {
    const st = l.state
    if (st.status === 'starting' || st.status === 'stopped') return
    const id = liveId(st.projectPath, st.agentId)
    const mine = (o: string): boolean => o.startsWith(`bg:${id}#`) && !this.bgSettling.has(o)
    resolveOffers((o) => mine(o) && !o.endsWith(`#${st.sessionId}`), tr(OUTCOME.runsAnother))
    if (st.sessionId) resolveOffers((o) => mine(o) && o.endsWith(`#${st.sessionId}`), tr(OUTCOME.openHereAgain))
  }

  /** An agent's name as Combwork shows it, for a notice's link (its id when it has gone). */
  private agentName(projectPath: string, agentId: string): string {
    return this.live.get(liveId(projectPath, agentId))?.state.agentName ?? agentId
  }

  /**
   * Finishes collected by `finishes`, in one notice: those that may still be told (notifications turned off
   * meanwhile), counted and opened from what is left, as a pop-up or a Windows notification as things are when it is
   * shown (HI-2320: the focus then picks its window).
   */
  private readonly finishes = new FinishBatcher(
    (all) => {
      const items = all.filter((i) => {
        const { route, why } = this.routeWhy(i.projectPath, 'finished')
        // i18n-ignore: the log (English)
        if (route === 'none') log.info(`Notice finished not told: ${why} (${userText(i.title)})`)
        return route !== 'none'
      })
      // Those the pop-up scope leaves out go to the bell as a group of their own, never inside another's pop-up (HI-2320).
      const quiet = items.filter((i) => this.routeWhy(i.projectPath, 'finished').route === 'bell')
      for (const group of [items.filter((i) => !quiet.includes(i)), quiet]) {
        if (!group.length) continue
        const { title, body } = finishedNotice(group)
        const one = group.length === 1 ? group[0] : null
        const apiTitleText = finishedApiTitleText(group)
        this.deliver(group[0].projectPath, title, body, 'finished', one?.agentId, one?.agent, finishedApiTitle(group), undefined, apiTitleText !== undefined ? { apiTitleText } : undefined)
      }
    },
    Date.now,
    (n) => notifyPending(n)
  )

  /**
   * An agent started its next turn while its finish waited to be told (HI-2312: a Combwork delivery typed at its turn's end,
   * a wake, the user typing): it isn't told. Told then, the notice would arrive as the agent works again, with the last
   * turn's message, and stand where its next need (a permission prompt) should; its next end is told as any is.
   */
  private dropFinishes(st: LiveSessionState, now: SessionStatus): void {
    const pathKey = st.projectPath.toLowerCase()
    for (const f of this.finishes.drop((i) => i.agentId === st.agentId && i.projectPath.toLowerCase() === pathKey)) {
      // i18n-ignore: the log (English)
      log.info(`Notice finished not told: ${userText(f.agent)} started its next turn first (${now}) (${userText(f.title)})`)
    }
  }

  /** The window showed these agents (all of the project's when none are named). */
  markSeen(projectPath: string, agentIds?: string[]): void {
    for (const st of this.projectStates(projectPath)) {
      if (agentIds && !agentIds.includes(st.agentId)) continue
      // A model switch after a safeguard stop (#606) leaves the attention inbox once its pane was seen too.
      const guard = st.safeguard?.unseen
      if (!st.unseen && !guard) continue
      st.unseen = false
      if (guard) {
        const { unseen: _u, ...rest } = st.safeguard!
        st.safeguard = rest
      }
      this.emitState(st)
    }
  }

  /**
   * A transcript's usage so far, read by the usage worker (#1147), so a long transcript never holds up main: from where
   * its last read stopped, or (not read in this run: a session resumed after a restart) from its session's saved state in
   * the history of `projectPath`, its host. Unchanged since main last had it, answered here without asking the worker.
   */
  /**
   * Whether a session is marked as on a server connection (HI-1772, HI-1829): by a live run of it (any host: a session
   * can move between agents), or kept as one whose record couldn't be saved (serverMarks.ts).
   */
  private serverMarked(projectPath: string, sessionId: string): boolean {
    for (const l of this.live.values()) if (l.serverSids?.has(sessionId)) return true
    return !!this.serverEnding.get(sessionId) || serverMarks.ignoresReports(projectPath, sessionId)
  }

  /**
   * A run ending (HI-1829), at once as its process exits, before anything awaits or takes it out of live: its markers
   * that its record doesn't say yet are held (`serverEnding`, by id: a count, for two runs of one conversation ending
   * together) until serverRunEnded has saved or kept each, so no read between sees one without them. Those its record
   * says go now.
   */
  private serverRunEnding(l: LiveSession): { unsaved: string[]; started: Set<string> } {
    const unsaved = [...(l.serverSids ?? [])].filter((sid) => !l.serverSaved?.has(sid))
    const started = l.serverRecorded ?? new Set<string>()
    for (const sid of unsaved) this.serverEnding.set(sid, (this.serverEnding.get(sid) ?? 0) + 1)
    l.serverSids = l.serverSaved = l.serverRecorded = undefined
    return { unsaved, started }
  }

  /**
   * A run ended (HI-1829): each marker held for it is saved now: one the CLI started gets a record if its own write
   * failed; one it never started (marked before the spawn) only if it has a record from an earlier run. One that can't be
   * saved is kept (serverMarks.ts) before its hold goes, so it is never read without one.
   */
  private async serverRunEnded(projectPath: string, ending: { unsaved: string[]; started: Set<string> }): Promise<void> {
    for (const sid of ending.unsaved) {
      try {
        if ((await this.saveServerRan(projectPath, sid, ending.started.has(sid))) === 'failed') serverMarks.add(projectPath, sid)
      } finally {
        const n = (this.serverEnding.get(sid) ?? 1) - 1
        if (n > 0) this.serverEnding.set(sid, n)
        else this.serverEnding.delete(sid)
      }
    }
  }

  /** A host's sessions whose server record couldn't be saved, tried again a few at a time; each saved is let go. */
  private async saveServerMarks(projectPath: string): Promise<void> {
    for (const sid of serverMarks.pending(projectPath).slice(0, 4)) if ((await this.saveServerRan(projectPath, sid, true)) === 'saved') serverMarks.saved(projectPath, sid)
  }

  /** Writes `serverRan` into a session's record (made, with `create`, if it has none): none when it has none to write. */
  private async saveServerRan(projectPath: string, sessionId: string, create: boolean): Promise<'saved' | 'none' | 'failed'> {
    try {
      const had = await workspace.mutateSessions(projectPath, (f) => {
        const rec = f.sessions.find((x) => x.id === sessionId)
        if (rec && !rec.serverRan) rec.serverRan = true
        return !!rec
      })
      if (had) return 'saved'
      if (!create) return 'none'
      await workspace.upsertSession(projectPath, { id: sessionId, serverRan: true })
      return 'saved'
    } catch (e) {
      log.warn(`Could not save that ${sessionId} ran on a server connection`, e)
      return 'failed'
    }
  }

  /** A running session's cost policy (HI-1772): on a server connection now, or its record says it ran on one. */
  private costPolicy(l: LiveSession): { reportsIgnored: boolean; costFree: boolean } {
    return { reportsIgnored: !!l.state.launchedConnection?.server || (!!l.state.sessionId && this.serverMarked(l.state.projectPath, l.state.sessionId)), costFree: !!l.costFree }
  }

  private async usageFor(projectPath: string, path: string, sessionId: string, provider: ProviderId, o: { noWait?: boolean; reportsIgnored?: boolean; costFree?: boolean } = {}): Promise<SessionUsage | null> {
    const costFree = !!o.costFree
    // A session that ran on a server connection (HI-1772): read without its CLI's cost reports.
    const reportsIgnored = !!o.reportsIgnored || this.serverMarked(projectPath, sessionId)
    try {
      const s = await stat(path)
      const seen = usageSeen.get(path)
      if (seen && seen.mtime === s.mtimeMs && seen.size === s.size && seen.sessionId === sessionId && seen.provider === provider && seen.reportsIgnored === reportsIgnored && seen.costFree === costFree) {
        // Most recently used last: the oldest go first when there are too many.
        usageSeen.delete(path)
        usageSeen.set(path, seen)
        // Unchanged since it was read: priced again after a price change, not read.
        return (seen.usage ??= this.priced(seen.raw, costFree, seen.rows))
      }
      const r = await usageHistory.read(projectPath, path, sessionId, provider, { noWait: o.noWait, reportsIgnored: reportsIgnored || costFree })
      if (!r) return null
      this.checkUnderstood(provider, r.usage, r.size)
      // The title the CLI's own index gives it (Codex's, Copilot's), which the worker's parsers can't read.
      const raw = this.titled(r.usage)
      const c: UsageSeen = { sessionId, provider, size: r.size, mtime: r.mtime, raw, ...(r.rows ? { rows: r.rows } : {}), usage: this.priced(raw, costFree, r.rows), reportsIgnored, costFree }
      usageSeen.delete(path)
      usageSeen.set(path, c)
      if (usageSeen.size > MAX_USAGE_SEEN) usageSeen.delete(usageSeen.keys().next().value!)
      return c.usage
    } catch {
      return null
    }
  }

  /** Providers and versions already warned about (see checkUnderstood). */
  private warnedFormats = new Set<string>()
  /** Folder warnings shown (folderWarning), by provider and folder: shown again only once the folder was fine. */
  private folderWarnings = new Set<string>()

  /**
   * Warns of what in a folder agents work in stops a turned-on provider's CLI there (#509: a stray .codex folder, which
   * any agent may have made): checked as each agent starts and at each turn's end, so one that appears is told soon.
   */
  private checkFolder(projectPath: string, folder: string): void {
    for (const a of allProviders()) {
      if (!a.folderWarning || !isProviderEnabled(config.settings, a.id)) continue
      const key = `${a.id}\n${resolve(folder).toLowerCase()}`
      const w = a.folderWarning(folder)
      if (!w) this.folderWarnings.delete(key)
      else if (!this.folderWarnings.has(key)) {
        this.folderWarnings.add(key)
        log.warn(`${a.descriptor.name}: ${w.title} (${userText(folder)})`)
        toast('warning', w.title, w.message, undefined, projectPath)
      }
    }
  }

  /** Launch notices already shown (launchNotice), by agent, folder and notice: once each while Combwork runs. */
  private launchNotices = new Set<string>()

  /**
   * A large transcript in which Combwork found no requests at all most likely means the CLI changed its
   * format: say so once per provider version, rather than quietly showing zeros.
   */
  private checkUnderstood(provider: ProviderId, usage: SessionUsage, size: number): void {
    if (usage.requests > 0 || size < 200_000) return
    const key = `${provider}|${usage.cliVersion ?? '?'}`
    if (this.warnedFormats.has(key)) return
    this.warnedFormats.add(key)
    const name = providerDescriptor(provider).name
    log.warn(`${name} ${usage.cliVersion ?? ''}: a ${Math.round(size / 1024)} KB transcript showed no usage (${usage.sessionId})`)
    toast(
      'warning',
      tr(msg({ id: 'session.format.title', defaultMessage: 'Combwork may not fully understand this {provider} version', description: "A notice's title: a coding agent's transcripts show no token use, so its format probably changed. {provider} is the coding agent's name." }), { provider: name }),
      usage.cliVersion
        ? tr(msg({ id: 'session.format.bodyVersion', defaultMessage: 'A {provider} {version} session with activity showed no token use, so the Overview and costs may be incomplete. A Combwork update will fix it.', description: "The notice that a coding agent's transcripts show no token use. {provider} is the coding agent's name, {version} its version (\"2.1.299\")." }), { provider: name, version: usage.cliVersion })
        : tr(msg({ id: 'session.format.body', defaultMessage: 'A {provider} session with activity showed no token use, so the Overview and costs may be incomplete. A Combwork update will fix it.', description: "The notice that a coding agent's transcripts show no token use. {provider} is the coding agent's name." }), { provider: name })
    )
  }

  /**
   * Saves the clipboard's image for the running session in its attachments folder (<host>/.combwork/attachments/<sessionId>)
   * and returns its path, which is pasted into the terminal so the transcript records which image was sent; null when the
   * clipboard holds no image.
   */
  async pasteImage(projectPath: string, agentId?: string): Promise<string | null> {
    projectPath = workspace.assertSessionHost(projectPath)
    const l = await this.attachTarget(projectPath, agentId)
    const item = (await clipboard.read()).find((i) => i.types.includes('image/png'))
    if (!item) return null
    const png = Buffer.from(await ((await item.getType('image/png')) as Blob).arrayBuffer())
    const dest = await this.attachmentFile(projectPath, l, null)
    // A new file only (wx): never one already there, or a link left in its place.
    await writeFile(dest, png, { flag: 'wx' })
    return dest
  }

  /**
   * How each file would be attached to the agent's running session (#387), changing nothing: a file from outside the
   * session's folder is copied into its attachments folder, and so is an image (kept with the session, for the
   * Attachments tab); a file in the session's folder, or already attached, goes as it is, by its path, as does a folder.
   */
  async planAttach(projectPath: string, sources: string[], agentId?: string): Promise<AttachmentPlan[]> {
    projectPath = workspace.assertSessionHost(projectPath)
    const l = await this.attachTarget(projectPath, agentId)
    const attachments = await attachmentsDir(projectPath)
    const out: AttachmentPlan[] = []
    for (const raw of (Array.isArray(sources) ? sources : []).slice(0, 100)) {
      if (typeof raw !== 'string' || !raw || !isAbsolute(raw)) continue
      const source = resolve(raw)
      const name = basename(source)
      const st = await stat(source).catch(() => null)
      const kind = attachmentKind(name)
      if (!st || st.isDirectory()) {
        out.push({ source, name, size: 0, kind, copy: false, folder: !!st })
        continue
      }
      const kept = existsSync(attachments) && insideReal(source, [attachments])
      const copy = !kept && st.isFile() && (kind === 'image' || !insideReal(source, [l.state.cwd]))
      out.push({ source, name, size: st.size, kind, copy, folder: false })
    }
    return out
  }

  /** Attaches files to the agent's running session as planAttach says: the copies made, and the paths to paste. */
  async attach(projectPath: string, sources: string[], agentId?: string): Promise<Attached[]> {
    projectPath = workspace.assertSessionHost(projectPath)
    const l = await this.attachTarget(projectPath, agentId)
    const out: Attached[] = []
    for (const p of await this.planAttach(projectPath, sources, agentId)) {
      if (!p.copy) {
        out.push({ source: p.source, path: p.source, name: p.name, kind: p.kind, copied: false })
        continue
      }
      const dest = await this.attachmentFile(projectPath, l, p.name)
      await copyFile(p.source, dest, fsConstants.COPYFILE_EXCL)
      out.push({ source: p.source, path: dest, name: p.name, kind: p.kind, copied: true })
    }
    return out
  }

  /** The agent's running session, which attachments go to (the sole agent when none is named). */
  private async attachTarget(projectPath: string, agentId?: string): Promise<LiveSession> {
    agentId ||= await this.soleAgent(projectPath)
    const l = this.live.get(liveId(projectPath, agentId))
    if (!l) throw combworkError(M.noSession, undefined, { kind: 'conflict' })
    return l
  }

  /**
   * A new file's path in the session's attachments folder: named by the time, then the file's own name (a clipboard
   * image has none), so they list in the order they came and the agent sees what each is. Until the provider reports
   * the session id, they go in a folder named after the launch.
   */
  private async attachmentFile(projectPath: string, l: LiveSession, name: string | null): Promise<string> {
    // A folder of the host's own all the way down, or it throws: an attachment is never written through a link.
    const dir = await ownAttachmentsFolder(projectPath, l.state.sessionId || `run-${l.state.runId}`)
    return freeName(dir, attachmentName(name), (i) => `-${i + 1}`)
  }

  /** Moves a launch's early attachments folder into its session's, when both are folders of the host's own. */
  private async moveEarlyAttachments(projectPath: string, launchFolder: string, sessionId: string): Promise<void> {
    const early = join(await attachmentsDir(projectPath), launchFolder)
    const st = await lstat(early).catch(() => null)
    if (!st) return
    if (st.isSymbolicLink() || !st.isDirectory() || !insideReal(early, [projectPath])) return log.warn(`${userText(early)} is a link or not a folder: its attachments stay`)
    const dest = await ownAttachmentsFolder(projectPath, sessionId)
    for (const f of await readdir(early).catch(() => [] as string[])) {
      const fst = await lstat(join(early, f)).catch(() => null)
      if (!fst || fst.isSymbolicLink() || !fst.isFile()) continue
      await rename(join(early, f), await freeName(dest, f, (i) => `-${i + 1}`)).catch((e) => log.warn(`Could not move ${userText(f)}`, e))
    }
    // Only once empty: what couldn't move stays.
    await rmdir(early).catch(() => undefined)
  }

  /** The provider's transcript, or Combwork's backup (active or archived) when the provider no longer has it. */
  async anyTranscript(projectPath: string, sessionId: string, ctx?: ListContext): Promise<string | null> {
    const t = await this.providerTranscript(projectPath, sessionId, ctx)
    if (t) return t.path
    for (const archived of [false, true]) {
      const b = this.backupCopy(projectPath, sessionId, archived)
      if (b) return b
    }
    return null
  }

  /**
   * Combwork's backup of a session in a folder (active or archived), as it is kept (#1110): its plain `.jsonl` while it runs
   * (and after a resume, the newer), else its compressed `.jsonl.gz`; null when it has neither.
   */
  backupCopy(projectPath: string, sessionId: string, archived = false): string | null {
    const plain = this.backupPath(projectPath, sessionId, archived)
    if (existsSync(plain)) return plain
    return existsSync(plain + GZ) ? plain + GZ : null
  }

  /**
   * The provider a conversation to resume ran in (#506): its record's, or for one Combwork has no record of (started
   * outside Combwork) the provider whose CLI has its transcript. Null when neither knows it: the agent's provider tries.
   */
  async resumeProvider(projectPath: string, sessionId: string, rec: SessionRecord | undefined): Promise<ProviderId | null> {
    if (rec) return recordProvider(rec)
    return (await this.providerTranscript(projectPath, sessionId).catch(() => null))?.provider ?? null
  }

  /** The provider a session of this project belongs to. */
  async sessionProvider(projectPath: string, sessionId: string, ctx?: ListContext): Promise<ProviderId> {
    const rec = (ctx?.records ?? (await workspace.sessionsFile(projectPath)).sessions).find((s) => s.id === sessionId)
    if (rec) return recordProvider(rec)
    const live = this.projectStates(projectPath).find((s) => s.sessionId === sessionId)
    if (live) return live.provider
    return (await this.providerTranscript(projectPath, sessionId, ctx))?.provider ?? 'claude-code'
  }

  /**
   * A session's usage. From the usage history (#1106), priced now; a running one's from its transcript as it grows, read
   * by the usage worker a piece at a time (#1147), in a list too (`ctx` with the history's sessions: the Sessions tab,
   * the project Overview; #1157: the history has it only from its last turn's end or tick, which missed a CLI /rename),
   * so main reads no transcript for either. One the history doesn't have yet (its import under way, a session adopted
   * since the last sweep) is read from its transcript as before and queued for the history; with no transcript left,
   * its kept usage, until the history has imported it.
   */
  /** `noWait`: a transcript the worker is busy with (the import ingesting it) isn't waited for: its kept usage, or none (#1177). */
  async usage(projectPath: string, sessionId: string, ctx?: ListContext, o: { noWait?: boolean } = {}): Promise<SessionUsage | null> {
    assertSessionId(sessionId)
    const records = ctx?.records ?? (await workspace.sessionsFile(projectPath)).sessions
    const rec = records.find((s) => s.id === sessionId)
    const running = this.projectStates(projectPath).some((s) => s.sessionId === sessionId)
    let usage: SessionUsage | null = null
    if (running && ctx?.stored) {
      // As its pane has it; unchanged since the last read, the worker isn't asked at all (usageFor).
      const p = await this.anyTranscript(projectPath, sessionId, ctx)
      if (p) usage = await this.usageFor(projectPath, p, sessionId, await this.sessionProvider(projectPath, sessionId, ctx), { reportsIgnored: !!rec?.serverRan, costFree: !!rec?.serverLocal && !rec?.notLocal })
    }
    if (!usage && (!running || ctx?.stored)) {
      const stored = (ctx?.stored ?? (await usageHistory.storedUsage(projectPath).catch(() => null)))?.get(sessionId)
      if (stored) usage = this.titled(stored.usage)
    }
    if (!usage && ctx?.stored) {
      // A list only reads the history (round 4): one it doesn't have yet (its import under way, a session just started) is
      // queued for the worker, which tells the window when it has it; meanwhile its kept usage, or none yet.
      if (rec) void usageHistory.ingest(projectPath, sessionId, { priority: 2, keepState: 'no' }).catch(() => undefined)
      return rec?.keptUsage ? withScreenStopsIn(rec.keptUsage, rec.screenStops) : null
    }
    if (!usage) {
      const p = await this.anyTranscript(projectPath, sessionId, ctx)
      if (!p) return rec?.keptUsage ?? null
      usage = await this.usageFor(projectPath, p, sessionId, await this.sessionProvider(projectPath, sessionId, ctx), { ...o, reportsIgnored: !!rec?.serverRan, costFree: !!rec?.serverLocal && !rec?.notLocal })
      if (usage && rec && !running) void usageHistory.ingest(projectPath, sessionId, { priority: 2, keepState: 'no' }).catch(() => undefined)
    }
    if (usage) usage = withScreenStopsIn(usage, rec?.screenStops)
    // A transcript without the context window (Claude Code's): the running session's status line has it.
    if (usage && !usage.contextWindow) {
      const window = [...this.live.values()].find((l) => l.state.sessionId === sessionId)?.state.contextWindow
      if (window) return { ...usage, contextWindow: window }
    }
    return usage
  }

  /** How long a resume waits for the worker's turn on its transcript (HI-2839): past it, the history's usage, or none. */
  resumeReadWaitMs = 3000

  /**
   * A stopped session's usage as its resume adopts a CLI /rename from it (HI-2839): the history's only while it has the
   * whole transcript (its size and time as read); behind it (the import queued as the launch ended hasn't run yet), the
   * transcript's, read by the worker from where it stopped. When the worker has the file's turn (that import under way),
   * waited for up to `resumeReadWaitMs` rather than never (#1177: a start never waits long on it). `known` false: neither
   * (that wait ran out, the read failed, the transcript couldn't be looked at), so the CLI's title now isn't known and the
   * usage given is none: the resume passes no --name rather than a name that may be older than the CLI's (review round 1).
   * No transcript: what the history or the record keeps, as `usage()` gives it (the CLI has nothing newer to resume from).
   */
  private async resumeUsage(projectPath: string, sessionId: string): Promise<{ usage: SessionUsage | null; known: boolean }> {
    const rec = (await workspace.sessionsFile(projectPath)).sessions.find((s) => s.id === sessionId)
    const p = await this.anyTranscript(projectPath, sessionId)
    if (!p) return { usage: await this.usage(projectPath, sessionId, undefined, { noWait: true }), known: true }
    const st = await stat(p).catch(() => null)
    if (!st) return { usage: null, known: false }
    const stored = (await usageHistory.storedUsage(projectPath).catch(() => null))?.get(sessionId)
    if (stored && stored.read.path?.toLowerCase() === p.toLowerCase() && stored.read.size === st.size && stored.read.mtime === st.mtimeMs) return { usage: withScreenStopsIn(this.titled(stored.usage), rec?.screenStops), known: true }
    const provider = await this.sessionProvider(projectPath, sessionId)
    const o = { reportsIgnored: !!rec?.serverRan, costFree: !!rec?.serverLocal && !rec?.notLocal }
    let usage = await this.usageFor(projectPath, p, sessionId, provider, { ...o, noWait: true })
    if (!usage) {
      let timer: NodeJS.Timeout | undefined
      const late = new Promise<null>((done) => (timer = setTimeout(() => done(null), this.resumeReadWaitMs)))
      try {
        usage = await Promise.race([this.usageFor(projectPath, p, sessionId, provider, o), late])
      } finally {
        clearTimeout(timer)
      }
    }
    return usage ? { usage: withScreenStopsIn(usage, rec?.screenStops), known: true } : { usage: null, known: false }
  }

  /** A usage from the history with the title its CLI gives the session now (Codex's and Copilot's own index), when it has none. */
  private titled(usage: SessionUsage): SessionUsage {
    if (usage.title) return usage
    let title: string | null = null
    try {
      title = providerAdapter(usage.provider).usageTitle?.(usage.sessionId) ?? null
    } catch {
      // A provider this version doesn't know.
    }
    return title ? { ...usage, title, customTitle: usage.customTitle ?? title } : usage
  }

  /** Listings of Combwork's own sessions under way, per host (#1646): see list(). */
  private listings = coalesced<SessionListItem[]>()
  /** The listing of Combwork's own sessions running now, per host, which `own` joins (HI-1681). */
  private ownRunning = new Map<string, Promise<SessionListItem[]>>()
  /** Listings of the other sessions under way, per host (HI-1681): see list(). */
  private others = joined<{ items: SessionListItem[]; folders: number }>()

  /**
   * A host's sessions, for its Overview, its Sessions tab and the Agent API: Combwork's own, from its records, and the other
   * sessions its CLIs keep for its folders, read at the same time. One listing of each per host at a time (#1646): a
   * listing stats each session's files and the CLIs' session folders, and the window asks again as sessions change, so
   * overlapping ones (61 at once, seen on a 400-session project) shared the disk's threads and each took minutes.
   * Asked while one runs, callers share one more listing of Combwork's sessions, started once it ends, so each gets its
   * records as they were after it asked; and the other sessions' listing under way (HI-1681): nothing tells Combwork when
   * those change, and one more after it only doubled the wait (19 s and then 10 s, seen while agents started).
   * `own`: Combwork's sessions alone, joining their listing under way, for a view that shows them before the rest.
   */
  list(projectPath: string, opts: { own?: boolean } = {}): Promise<SessionListItem[]> {
    projectPath = workspace.assertSessionHost(projectPath)
    const key = resolve(projectPath).toLowerCase()
    if (opts.own) return this.ownRunning.get(key) ?? this.ownListing(key, projectPath)
    return this.listNow(key, projectPath)
  }

  private ownListing(key: string, projectPath: string): Promise<SessionListItem[]> {
    return this.listings(key, () => {
      const p = this.listOwn(projectPath)
      this.ownRunning.set(key, p)
      const end = (): void => {
        if (this.ownRunning.get(key) === p) this.ownRunning.delete(key)
      }
      p.then(end, end)
      return p
    })
  }

  private async listNow(key: string, projectPath: string): Promise<SessionListItem[]> {
    const started = performance.now()
    let ownMs = 0
    let othersMs = 0
    const [own, others] = await Promise.all([
      this.ownListing(key, projectPath).finally(() => (ownMs = performance.now() - started)),
      this.others(key, () => this.listOthers(projectPath)).finally(() => (othersMs = performance.now() - started))
    ])
    const ids = new Set(own.map((i) => i.id))
    // A session Combwork took on while the other sessions were read is listed once, as Combwork's.
    const items = [...own, ...others.items.filter((i) => !ids.has(i.id))]
    const ms = performance.now() - started
    if (ms > SLOW_LIST_MS) {
      const s = (x: number): string => `${(x / 1000).toFixed(1)} s`
      log.info(`listing the sessions of ${userText(projectPath)} took ${s(ms)}: Combwork's ${own.length} session(s) ${s(ownMs)}, the other sessions in ${others.folders} folder(s) ${s(othersMs)}, read at the same time`)
    }
    return items.sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''))
  }

  /** Combwork's own sessions, from its records. */
  private async listOwn(projectPath: string): Promise<SessionListItem[]> {
    const file = await workspace.sessionsFile(projectPath)
    // Read once for the whole list, not once per session.
    const ctx: ListContext = { records: file.sessions, cfg: await workspace.projectConfig(projectPath), stored: await usageHistory.storedUsage(projectPath).catch(() => new Map()) }
    const ttl = config.settings.sessions.cacheTtl
    // Which start fresh when resumed (HI-2540), by the rule the start reads: the window asks before, not afterwards.
    const moves = await this.folderMoves(projectPath)
    const items: SessionListItem[] = []
    // Records from before sub-sessions were told apart (a guardian review adopted then): found now, and kept on them.
    const found = new Map<string, SubSession>()
    // Combwork's backups, from its two folders' names (#1649): not four checks per session on main's thread.
    const backups = await this.backupNames(projectPath)
    // A few sessions at a time (#1649): each waits on its files, and one after another 400 took a second.
    const listed = await atMost(LIST_AT_ONCE, file.sessions, async (rec): Promise<SessionListItem> => {
      const provider = recordProvider(rec)
      let transcript: string | null = null
      try {
        transcript = await providerAdapter(provider).transcriptPath(rec.cwd ?? projectPath, rec.id, rec.transcriptPath)
      } catch {
        // A provider this version doesn't know.
      }
      const hasTranscript = !!transcript
      // Its size for the list (#671): a stat, never a read, taken each time the list is; the same stat for its
      // sub-session check (HI-1681). Null when it is missing or can't be read.
      const st = transcript ? await stat(transcript).catch(() => null) : null
      const hasBackup = backups.has(`${rec.id}.jsonl`.toLowerCase()) || backups.has(`${rec.id}.jsonl${GZ}`.toLowerCase())
      const usage = await this.usage(projectPath, rec.id, ctx)
      const { keptUsage: _kept, ...fields } = rec
      const sub = rec.sub ?? (await this.recordSub(projectPath, rec, transcript, st?.mtimeMs))
      if (sub && !rec.sub) found.set(rec.id, sub)
      const fresh = freshReasonOf(rec, moves)
      return {
        ...fields,
        ...(sub ? { sub } : {}),
        ...(fresh ? { fresh } : {}),
        provider,
        source: 'combwork',
        title: usage?.title ?? null,
        lastActivity: usage?.lastActivity ?? rec.lastActiveAt,
        hasTranscript,
        hasBackup,
        transcriptBytes: st?.size ?? null,
        ...(!ctx.stored?.has(rec.id) && (hasTranscript || hasBackup) ? { pending: true } : {}),
        usage,
        recache: usage && providerDescriptor(provider).capabilities.promptCacheTtl ? recacheEstimate(usage, ttl) : null
      }
    })
    items.push(...listed)
    if (found.size) await this.keepSubs(projectPath, found)
    // Each in a slot (#1434): which, and whether it may resume there now, by its agent (gone: no agent may).
    const facts = workspace.isAssistantHome(projectPath) ? null : await folderFacts(projectPath).catch(() => null)
    if (facts?.slots.length) {
      const agents = new Map(projectAgents(ctx.cfg).map((a) => [a.id, a]))
      for (const it of items) {
        const slot = it.cwd ? slotAt(facts, it.cwd) : null
        if (!slot) continue
        it.slot = slot.name
        const a = it.agentId ? agents.get(it.agentId) : undefined
        const hold = resumeHold(facts, a ? folderAgent(a) : { id: it.agentId ?? '', role: 'builder', legacy: null }, it)
        if (hold) it.hold = hold
      }
    }
    return items
  }

  /**
   * Sessions started outside Combwork in the project folder; and from the other folders its sessions ran in (agents'
   * worktrees, the Assistant's workspace folder), only the sub-sessions of sessions listed here. Combwork's own sessions'
   * files, the bulk of those folders, aren't looked at (HI-1681): each CLI leaves them out by id, and reads a folder's
   * names again only when the folder changed, so a listing opens only new transcripts and stats only the others.
   */
  private async listOthers(projectPath: string): Promise<{ items: SessionListItem[]; folders: number }> {
    const file = await workspace.sessionsFile(projectPath)
    const cfg = await workspace.projectConfig(projectPath)
    const stored: Map<string, StoredUsage> = await usageHistory.storedUsage(projectPath).catch(() => new Map())
    const ttl = config.settings.sessions.cacheTtl
    // Deleted sessions stay hidden, though the CLI still has their transcripts.
    const known = new Set([...file.sessions.map((s) => s.id), ...(file.deleted ?? [])])
    const skip = (id: string): boolean => known.has(id)
    // Whose sub-sessions are listed from the other folders: Combwork's sessions, and the other sessions listed before them.
    const listed = new Set(file.sessions.map((s) => s.id))
    const folders = this.sessionFolders(projectPath, file.sessions, cfg)
    const asks = allProviders().flatMap((adapter) => folders.map((folder, i) => ({ adapter, folder, i })))
    // A few folders at once: each waits on the disk.
    const found = await atMost(OTHER_FOLDERS_AT_ONCE, asks, (a) => a.adapter.listSessions(a.folder, skip).catch(() => [] as ExternalSession[]))
    const items: SessionListItem[] = []
    for (const [n, { adapter, i }] of asks.entries()) {
      for (const ext of found[n]) {
        if (known.has(ext.id) || (i > 0 && !(ext.sub?.parentId && listed.has(ext.sub.parentId)))) continue
        known.add(ext.id)
        listed.add(ext.id)
        // From the usage history only (#1106): one it doesn't have, or has from before its file changed, is queued for the
        // worker (the window is told when it has it), and shows as the history has it meanwhile, or not yet.
        const st = ext.bytes !== undefined && ext.mtimeMs !== undefined ? { size: ext.bytes, mtimeMs: ext.mtimeMs } : await stat(ext.transcriptPath).catch(() => null)
        const kept = stored.get(ext.id)
        const same = !!st && !!kept?.read.path && samePlace(kept.read.path, ext.transcriptPath) && kept.read.size === st.size && kept.read.mtime === st.mtimeMs
        const usage = kept ? this.titled(kept.usage) : null
        if (!same) void usageHistory.ingestExternal(projectPath, { id: ext.id, provider: adapter.id, transcriptPath: ext.transcriptPath }).catch(() => undefined)
        // Known to be empty: not listed. Not known yet: listed without figures until the worker has it. A sub-session is
        // listed under its session though it made no request of its own (an OpenCode fork holding only what it copied, HI-2774).
        if (usage && usage.requests === 0 && !ext.sub) continue
        items.push({
          id: ext.id,
          provider: adapter.id,
          source: 'external',
          title: usage?.title ?? null,
          lastActivity: usage?.lastActivity ?? ext.modified,
          hasTranscript: true,
          hasBackup: false,
          transcriptBytes: st?.size ?? null,
          ...(same ? {} : { pending: true }),
          usage,
          recache: usage && adapter.descriptor.capabilities.promptCacheTtl ? recacheEstimate(usage, ttl) : null,
          ...(ext.sub ? { sub: ext.sub } : {})
        })
      }
    }
    return { items, folders: folders.length }
  }

  /**
   * The folders a session host's sessions run in: the project folder first, then its agents' worktrees and the folders
   * its sessions recorded (the Assistant's: the workspace folder), each once.
   */
  private sessionFolders(projectPath: string, records: SessionRecord[], cfg: ProjectConfig): string[] {
    const out = new Map<string, string>([[resolve(projectPath).toLowerCase(), projectPath]])
    const add = (f: string | null | undefined): void => {
      if (f && !out.has(resolve(f).toLowerCase())) out.set(resolve(f).toLowerCase(), f)
    }
    if (workspace.isAssistantHome(projectPath)) add(workspaceOf(projectPath).path)
    for (const a of projectAgents(cfg)) add(legacyWorktree(a)?.path)
    for (const r of records) add(r.cwd)
    return [...out.values()]
  }

  /**
   * Whether one of Combwork's records is a sub-session, from its transcript's first line (the CLI's, else Combwork's copy).
   * `transcript`: the CLI's, when the caller has looked it up already (null: it has none), and `mtimeMs` its time, when
   * the caller has stat'd it.
   */
  private async recordSub(projectPath: string, rec: SessionRecord, transcript?: string | null, mtimeMs?: number): Promise<SubSession | null> {
    if (rec.sub) return rec.sub
    try {
      const adapter = providerAdapter(recordProvider(rec))
      const cli = transcript !== undefined ? transcript : await adapter.transcriptPath(rec.cwd ?? projectPath, rec.id, rec.transcriptPath).catch(() => null)
      const path = cli ?? this.backupCopy(projectPath, rec.id) ?? this.backupCopy(projectPath, rec.id, true)
      return path ? await adapter.subSessionOf(path, rec.id, path === cli ? mtimeMs : undefined) : null
    } catch {
      return null
    }
  }

  /** Keeps sub-sessions found on their records, so resume targets (liveInfo) never pick one. */
  private async keepSubs(projectPath: string, found: Map<string, SubSession>): Promise<void> {
    await workspace
      .mutateSessions(projectPath, (f) => {
        for (const r of f.sessions) if (!r.sub && found.has(r.id)) r.sub = found.get(r.id)
      })
      .catch((e) => log.warn(`Keeping sub-sessions in ${userText(projectPath)}`, e))
  }

  /** Projects whose records were checked for sub-sessions this run (once each: liveInfo asks often). */
  private subsChecked = new Set<string>()

  /** Checks a project's records for sub-sessions once per run, in the background, and keeps what it finds. */
  private checkSubsOnce(projectPath: string, records: SessionRecord[]): void {
    const k = projectPath.toLowerCase()
    if (this.subsChecked.has(k)) return
    this.subsChecked.add(k)
    void (async () => {
      const found = new Map<string, SubSession>()
      for (const r of records) {
        if (r.sub) continue
        const sub = await this.recordSub(projectPath, r)
        if (sub) found.set(r.id, sub)
      }
      if (!found.size) return
      await this.keepSubs(projectPath, found)
      workspaceOf(projectPath).scheduleRefresh()
    })().catch((e) => log.warn(`Checking ${userText(projectPath)}'s sessions for sub-sessions`, e))
  }

  /**
   * Archives or unarchives one of Combwork's sessions (its backup moves to or from .combwork/archive), all or nothing: with the
   * session reserved (nothing reads, resumes or moves it meanwhile) and nothing having it in use (assertFree), the new
   * archive is built aside, then each copy is moved; a failure at any step (a copy another program holds, the record
   * not saved) moves everything back, and the record changes only once the files have.
   */
  async archive(projectPath: string, sessionId: string, archived: boolean): Promise<void> {
    projectPath = workspace.assertSessionHost(projectPath)
    assertSessionId(sessionId)
    if (!(await workspace.sessionsFile(projectPath)).sessions.some((s) => s.id === sessionId)) throw combworkError(msg({ id: 'session.archive.notKept', defaultMessage: 'Only sessions Combwork keeps can be archived: adopt it first.', description: "Archiving a session is refused: it was started outside Combwork, so Combwork has no copy of it (Adopt keeps one)." }), undefined, { kind: 'conflict' })
    const action = archived ? 'archive' : 'unarchive'
    const active = this.backupPath(projectPath, sessionId)
    const arch = this.backupPath(projectPath, sessionId, true)
    await this.whileReserved(projectPath, sessionId, async () => {
      await this.assertFree(projectPath, sessionId, action)
      await mkdir(dirname(arch), { recursive: true })
      await mkdir(dirname(active), { recursive: true })
      const src = archived ? await this.providerTranscript(projectPath, sessionId) : null
      // Both copies locked (always the archive's first), so no backup or other move runs into the middle of this one.
      await withFileLock(arch, () =>
        withFileLock(active, async () => {
          this.assertNotLive(sessionId, action)
          // Compressed copies (#1110) moved as plain ones: decompressed first (a plain one beside it is the newer).
          await inUseOnFail(() => expandBackup(active))
          await inUseOnFail(() => expandBackup(arch))
          const moves = new Moves()
          // The archive, built aside: the backup brought up to date from the CLI's transcript, so it is complete.
          const fresh = src ? `${arch}.archiving` : null
          try {
            if (fresh && src) {
              await rm(fresh, { force: true })
              if (existsSync(active)) await inUseOnFail(() => copyFile(active, fresh))
              await inUseOnFail(() => syncCopyLocked(src.path, fresh))
            }
            if (archived) {
              if (existsSync(arch)) await moves.move(arch, `${arch}.previous`)
              if (fresh) {
                await moves.move(fresh, arch)
                if (existsSync(active)) await moves.move(active, `${active}.archived`)
              } else if (existsSync(active)) await moves.move(active, arch)
            } else if (existsSync(arch)) {
              if (existsSync(active)) await moves.move(active, `${active}.previous`)
              await moves.move(arch, active)
            }
            await workspace.upsertSession(projectPath, { id: sessionId, archived })
          } catch (e) {
            await moves.undo()
            if (fresh) await rm(fresh, { force: true }).catch(() => undefined)
            throw e
          }
          // Done: what was set aside is superseded (the archive holds all of it).
          await moves.discardAside()
        })
      )
    })
    // Compressed again, now it is settled (#1110).
    await this.compressBackups(projectPath, sessionId)
  }

  /**
   * Compresses a session's backups that aren't yet (#1110: active and archived, each `.jsonl` to `.jsonl.gz`), unless it
   * runs or is starting, or its files are moving (archive, delete, Clean Up): then it's left for its end. With its
   * backups locked, so no copy or move runs into the middle of it. Best effort: a failure leaves the plain file.
   */
  async compressBackups(projectPath: string, sessionId: string): Promise<void> {
    try {
      await this.withBackupsLocked(projectPath, sessionId, async () => {
        for (const archived of [false, true]) {
          const plain = this.backupPath(projectPath, sessionId, archived)
          if (!existsSync(plain) || this.liveAnywhere(sessionId) || this.reserved(projectPath, sessionId)) continue
          await compressFile(plain)
        }
      })
    } catch (e) {
      log.warn(`compressing the backup of ${sessionId}`, e)
    }
  }

  /**
   * Backup retention (#1110, Settings → Sessions → Keep transcript backups; off by default): Combwork's copies of a host's
   * sessions last active more than that many days ago go to the Recycle Bin (trash()), only where the CLI still has the
   * session's transcript (it can still be opened and resumed from there), and only once the usage history has what it
   * used. A session whose only copy is Combwork's is never touched (the Assistant for Darren, 20 Oct): deleting those stays
   * the user's (Delete, Clean Up). Running sessions and those whose files are moving are skipped; each is checked again
   * with its backups locked, just before they go. Returns how many sessions' copies went. `signal`: the workspace's
   * opening it runs in (background housekeeping), ending it when the workspace closes (#1379).
   */
  async applyRetention(projectPath: string, signal?: AbortSignal): Promise<number> {
    if (!retentionDays()) return 0
    const recs = (await workspace.sessionsFile(projectPath, signal).catch(() => null))?.sessions ?? []
    // Whether a session's copies may go, as things are now: the setting, its record's last activity, not running, with
    // backups, and the CLI still having it. Asked before, and again under its reservation and locks, then once more
    // after what it used is recorded (that waits), just before they go: any of it can change meanwhile.
    // The record is read last, and nothing is awaited between these checks and the copies going.
    const eligible = async (id: string): Promise<boolean> => {
      const cfg = await workspace.projectConfig(projectPath).catch(() => null)
      const records = cfg && (await workspace.sessionsFile(projectPath, signal).catch(() => null))?.sessions
      if (!cfg || !records || !(await this.providerTranscript(projectPath, id, { records, cfg }).catch(() => null))) return false
      const rec = (await workspace.sessionsFile(projectPath, signal).catch(() => null))?.sessions.find((r) => r.id === id)
      const days = retentionDays()
      return !!rec && !!days && Date.now() - Date.parse(rec.lastActiveAt) > days * 86_400_000 && !this.liveAnywhere(id) && this.backupFiles(projectPath, id).length > 0
    }
    let n = 0
    for (const rec of recs) {
      if (signal?.aborted) break
      const days = retentionDays()
      if (!days || Date.now() - Date.parse(rec.lastActiveAt) <= days * 86_400_000 || !(await eligible(rec.id))) continue
      try {
        const went = await this.whileCleaning(projectPath, rec.id, () =>
          this.withBackupsLocked(projectPath, rec.id, async () => {
            if (!(await eligible(rec.id))) return false
            if (!(await usageHistory.recordNow(projectPath, rec.id).catch(() => false))) return false
            if (!(await eligible(rec.id))) return false
            for (const b of this.backupFiles(projectPath, rec.id)) await trash(b)
            return true
          })
        )
        if (went) n++
      } catch (e) {
        log.warn(`backup retention: ${rec.id} kept`, e)
      }
    }
    if (n) log.info(`backup retention: the backups of ${n} session(s) in ${userText(projectPath)} went to the Recycle Bin`)
    return n
  }

  /**
   * Compresses the backups of a host's sessions that ended before this Combwork did it (#1110): one at a time, in the
   * background, the oldest first; those running or active in the last ten minutes are left for their end. `signal`: as
   * applyRetention's.
   */
  async compressIdleBackups(projectPath: string, signal?: AbortSignal): Promise<number> {
    const recs = (await workspace.sessionsFile(projectPath, signal).catch(() => null))?.sessions ?? []
    const idle = recs.filter((r) => Date.now() - Date.parse(r.lastActiveAt) > 10 * 60_000).sort((a, b) => (a.lastActiveAt < b.lastActiveAt ? -1 : 1))
    let n = 0
    for (const r of idle) {
      if (signal?.aborted) break
      if (![false, true].some((archived) => existsSync(this.backupPath(projectPath, r.id, archived)))) continue
      await this.compressBackups(projectPath, r.id)
      n++
    }
    return n
  }

  /** The session is running, or an agent is starting on it, in any project and window. */
  liveAnywhere(sessionId: string): boolean {
    const id = sessionId.toLowerCase()
    return [...this.live.values()].some((l) => l.state.sessionId?.toLowerCase() === id) || [...this.starting.values()].some((p) => p.resumeId?.toLowerCase() === id)
  }

  private assertNotLive(sessionId: string, action: 'archive' | 'unarchive' | 'delete'): void {
    if (this.liveAnywhere(sessionId)) throw new SessionInUse('live', withValues(M.stopFirst, { action }), 'conflict')
  }

  /** When Combwork saw each session's CLI exit (its own sessions): their transcripts are finished. At most 500, the oldest go. */
  private exitedAt = new Map<string, number>()

  private noteExit(sessionId: string | undefined): void {
    if (!sessionId) return
    this.exitedAt.delete(sessionId)
    this.exitedAt.set(sessionId, Date.now())
    if (this.exitedAt.size > 500) this.exitedAt.delete(this.exitedAt.keys().next().value!)
  }

  /**
   * Why a session's files can't be archived or deleted now, or null. Run with the session reserved, so no read,
   * resume or other move can start after it: it is running or starting (in any window); Combwork is reading its transcript
   * (a search, an export, the viewer loading it); its transcript is open in a Sessions view, in any window (the window
   * asking closes its own first, and says so); another program holds the CLI's transcript open (checked by opening it to
   * read, never changing it); or (`writing`) its CLI is still writing it: changed in the last SESSION_WRITING_MS and
   * not since Combwork saw that CLI exit (a session started outside Combwork, or a Codex guardian review, still going). A copy
   * of Combwork's another program holds is found when it is moved (inUseOnFail).
   */
  private async inUse(projectPath: string, sessionId: string, opts: { writing: boolean }): Promise<SessionInUse | null> {
    if (this.liveAnywhere(sessionId)) return new SessionInUse('live', msg({ id: 'session.inUse.running', defaultMessage: 'It is running. Stop it first.', description: 'A session is left alone (archive, delete): it is running.' }), 'conflict')
    if (beingRead(projectPath, sessionId)) return new SessionInUse('reading', msg({ id: 'session.inUse.reading', defaultMessage: 'Combwork is reading its transcript (an export or a search). Try again in a moment.', description: "A session is left alone (archive, delete) for a moment: Combwork is reading its transcript." }))
    if (viewingWindows(projectPath, sessionId).length) return new SessionInUse('open', msg({ id: 'session.inUse.open', defaultMessage: 'Its transcript is open in Combwork. Close it, then try again.', description: "A session is left alone (archive, delete): its transcript is open in Combwork's Sessions tab." }))
    const t = await this.providerTranscript(projectPath, sessionId).catch(() => null)
    if (!t) return null
    if (await heldOpen(t.path)) return new SessionInUse('in-use', M.inUseElsewhere)
    if (!opts.writing) return null
    const s = await stat(t.path).catch(() => null)
    if (s && Date.now() - s.mtimeMs < SESSION_WRITING_MS && !((this.exitedAt.get(sessionId) ?? 0) >= s.mtimeMs)) {
      return new SessionInUse('in-use', msg({ id: 'session.inUse.writing', defaultMessage: 'Its CLI is still writing its transcript. Try again in a moment.', description: "A session is left alone (archive, delete) for a moment: its coding agent is still writing its transcript." }))
    }
    return null
  }

  private async assertFree(projectPath: string, sessionId: string, action: 'archive' | 'unarchive' | 'delete'): Promise<void> {
    // Unarchiving moves only Combwork's copy back: the CLI still writing its own transcript doesn't matter to it.
    const why = await this.inUse(projectPath, sessionId, { writing: action !== 'unarchive' })
    if (why?.reason === 'live') throw new SessionInUse('live', withValues(M.stopFirst, { action }), 'conflict')
    if (why) throw why
  }

  /**
   * Archives, unarchives or deletes several sessions (a branch of the Sessions tab). Each is all or nothing, with the
   * same checks as one at a time; those in use, running, open in another window or started outside Combwork (nothing of
   * Combwork's to archive) are skipped and listed with why. The CLIs' own transcripts are never touched.
   */
  async bulk(projectPath: string, action: SessionBulkAction, sessionIds: string[]): Promise<SessionBulkResult> {
    projectPath = workspace.assertSessionHost(projectPath)
    // i18n-ignore: refusals no person sees (the window sends only these)
    if (action !== 'archive' && action !== 'unarchive' && action !== 'delete') throw new Error(`Unknown action: ${String(action)}`) // agent-protocol: a programming error nobody sees
    // agent-protocol: a programming error no person or agent sees (the window sends a list)
    if (!Array.isArray(sessionIds)) throw new Error('sessionIds: a list of session ids') // i18n-ignore: a refusal no person sees (the window sends a list)
    const ids = [...new Set(sessionIds)]
    // Combwork's own sessions, read once for the whole action (#1659), not once for each.
    const kept = new Set((await workspace.sessionsFile(projectPath)).sessions.map((s) => s.id))
    const progress = bulkProgress(projectPath, action, ids.length)
    let results: BulkOutcome[]
    try {
      // A few at a time (#1659): each waits mostly on its files, and one after another 300 took 8 s. Each is still all or
      // nothing, under its own reservation and locks.
      results = await atMost(BULK_AT_ONCE, ids, async (id) => {
        try {
          return await this.bulkOne(projectPath, action, id, kept)
        } finally {
          progress.step()
        }
      })
    } finally {
      progress.end()
    }
    const out: SessionBulkResult = { done: results.filter((r) => !r.reason).map((r) => r.id), skipped: results.filter((r): r is SessionBulkResult['skipped'][number] => !!r.reason) }
    log.info(`Sessions: ${action} ${out.done.length}, skipped ${out.skipped.length} (${[...new Set(out.skipped.map((s) => s.reason))].join(', ') || 'none'}) in ${userText(projectPath)}`)
    workspaceOf(projectPath).scheduleRefresh()
    return out
  }

  /** One session of a bulk action (see BulkOutcome). */
  private async bulkOne(projectPath: string, action: SessionBulkAction, id: string, kept: Set<string>): Promise<BulkOutcome> {
    if (!isSessionId(id)) return { id: String(id), reason: 'failed', message: tr(msg({ id: 'session.bulk.notAnId', defaultMessage: 'Not a session id.', description: "Why a session was left alone by Archive or Delete in the Sessions tab: its id isn't one." })) } // i18n-ignore: a reason's key
    try {
      if (action === 'delete') await this.deleteOne(projectPath, id)
      else if (!kept.has(id)) return { id, reason: 'external' } // i18n-ignore: a reason's key, which the window words
      else await this.archive(projectPath, id, action === 'archive')
      return { id }
    } catch (e) {
      // A failure's message in the window's language: bulk is the window's (session:bulk).
      return e instanceof SessionInUse ? { id, reason: e.reason } : { id, reason: 'failed', message: shownError(e) } // i18n-ignore: a reason's key
    }
  }

  /** Combwork's copies of a session's transcript that exist (the active backup, the archived one). */
  backupFiles(projectPath: string, sessionId: string): string[] {
    return [false, true].flatMap((archived) => [this.backupPath(projectPath, sessionId, archived), this.backupPath(projectPath, sessionId, archived) + GZ]).filter((b) => existsSync(b))
  }

  /** The names of Combwork's copies of a host's transcripts (active and archived), lower-cased: a listing's backupFiles. */
  private async backupNames(projectPath: string): Promise<Set<string>> {
    const names = await Promise.all([false, true].map((archived) => readdir(this.backupDir(projectPath, archived)).catch(() => [] as string[])))
    return new Set(names.flat().map((n) => n.toLowerCase()))
  }

  /**
   * Sessions reserved while their files move (`project|id`, lower-cased): Clean Up… removing them, or an archive or
   * delete. None of them starts, resumes or has its transcript read meanwhile.
   */
  private cleaning = new Set<string>()

  /** Archiving, deleting or Clean Up has the session's files (transcripts aren't read meanwhile). */
  reserved(projectPath: string, sessionId: string): boolean {
    return this.cleaning.has(`${projectPath.toLowerCase()}|${sessionId.toLowerCase()}`)
  }

  /** The session is running, or an agent is starting on it. */
  private sessionOpen(projectPath: string, sessionId: string): boolean {
    const id = sessionId.toLowerCase()
    return this.projectStates(projectPath).some((s) => s.sessionId.toLowerCase() === id) || [...this.starting.values()].some((p) => p.projectPath.toLowerCase() === projectPath.toLowerCase() && p.resumeId?.toLowerCase() === id)
  }

  /**
   * Runs fn (Clean Up… removing a session's files, or its image folder) with the session reserved: it isn't running
   * or starting now, and start() refuses to resume it until fn is done, so no session crosses the removal.
   */
  async whileCleaning<T>(projectPath: string, sessionId: string, fn: () => Promise<T>): Promise<T> {
    const k = `${projectPath.toLowerCase()}|${sessionId.toLowerCase()}`
    if (this.cleaning.has(k)) throw combworkError(msg({ id: 'session.cleanUp.already', defaultMessage: "Clean Up is already removing this session's files.", description: 'Clean Up… is refused for a session: it is removing its files already.' }))
    if (this.sessionOpen(projectPath, sessionId)) throw combworkError(M.sessionRunning)
    this.cleaning.add(k)
    try {
      return await fn()
    } finally {
      this.cleaning.delete(k)
    }
  }

  /**
   * Runs fn with the session reserved and not running (in any window): removing its attachments. Nothing resumes it, or
   * archives or deletes it, until fn is done, so it can't start pasting while its attachments go.
   */
  whileStopped<T>(projectPath: string, sessionId: string, fn: () => Promise<T>): Promise<T> {
    return this.whileReserved(projectPath, sessionId, async () => {
      if (this.liveAnywhere(sessionId)) throw new SessionInUse('live', msg({ id: 'session.inUse.attaching', defaultMessage: 'It is running, and may attach more files. Stop it first.', description: "Removing a session's attachments is refused: it is running." }), 'conflict')
      return fn()
    })
  }

  /** Runs fn (an archive or delete) with the session reserved, as whileCleaning; one already reserved is in use. */
  private async whileReserved<T>(projectPath: string, sessionId: string, fn: () => Promise<T>): Promise<T> {
    const k = `${projectPath.toLowerCase()}|${sessionId.toLowerCase()}`
    if (this.cleaning.has(k)) throw new SessionInUse('in-use', msg({ id: 'session.inUse.reserved', defaultMessage: 'Combwork is already archiving, deleting or cleaning up this session.', description: 'A session is left alone (archive, delete) for a moment: Combwork is moving or removing its files already.' }))
    this.cleaning.add(k)
    try {
      return await fn()
    } finally {
      this.cleaning.delete(k)
    }
  }

  /** Runs fn with both of a session's backups locked (the archive's first, as archive() does), so no backup or move runs into it. */
  private withBackupsLocked<T>(projectPath: string, sessionId: string, fn: () => Promise<T>): Promise<T> {
    return withFileLock(this.backupPath(projectPath, sessionId, true), () => withFileLock(this.backupPath(projectPath, sessionId), fn))
  }

  /**
   * For Clean Up…, with the session's backups locked: it is still archived and not running, and `expected` (what the
   * preview listed) are exactly its copies. Otherwise it changed since the preview and nothing of it goes.
   */
  private async assertCleanable(projectPath: string, sessionId: string, expected: string[]): Promise<void> {
    const rec = (await workspace.sessionsFile(projectPath)).sessions.find((s) => s.id === sessionId)
    if (!rec?.archived) throw combworkError(msg({ id: 'session.cleanUp.unarchived', defaultMessage: 'The session is no longer archived.', description: 'Clean Up… left a session alone: it was unarchived since the preview.' }), undefined, { kind: 'conflict' })
    if (this.sessionOpen(projectPath, sessionId)) throw combworkError(M.sessionRunning)
    const want = new Set(expected.map((e) => e.toLowerCase()))
    const has = this.backupFiles(projectPath, sessionId).map((b) => b.toLowerCase())
    if (has.length !== want.size || !has.every((b) => want.has(b))) throw combworkError(msg({ id: 'session.cleanUp.changed', defaultMessage: "The session's copies changed since the preview.", description: "Clean Up… left a session alone: Combwork's copies of its transcript changed since the preview." }))
  }

  /**
   * Moves Combwork's backups of an archived session the CLI still has to the Recycle Bin (Clean Up…), what it used recorded
   * in the usage history first (#1106), so totals still count it once the CLI's transcript goes too. `expected` is what
   * the preview listed. Nothing goes unless the session is unchanged since (assertCleanable, again right before the
   * files go) and what it used was recorded; the session can't be resumed meanwhile (whileCleaning).
   */
  async removeBackups(projectPath: string, sessionId: string, expected: string[]): Promise<void> {
    projectPath = workspace.assertSessionHost(projectPath)
    assertSessionId(sessionId)
    await this.whileCleaning(projectPath, sessionId, () =>
      this.withBackupsLocked(projectPath, sessionId, async () => {
        await this.assertCleanable(projectPath, sessionId, expected)
        if (!(await this.providerTranscript(projectPath, sessionId))) throw combworkError(msg({ id: 'session.cleanUp.cliGone', defaultMessage: "The CLI no longer has this session's transcript.", description: "Clean Up… kept a session's backups: the coding agent's own transcript is gone since the preview." }))
        if (!(await usageHistory.recordNow(projectPath, sessionId).catch(() => false))) throw combworkError(msg({ id: 'session.cleanUp.unreadBackups', defaultMessage: "Combwork couldn't read what the session used, so its backups are kept.", description: "Clean Up… kept a session's backups: Combwork couldn't read its usage, which the project's totals keep." }))
        await this.assertCleanable(projectPath, sessionId, expected)
        for (const b of this.backupFiles(projectPath, sessionId)) await trash(b)
      })
    )
    log.info(`Clean Up: removed the backups of session ${sessionId} in ${userText(projectPath)}`)
  }

  /**
   * Purge… (#1138): removes what Combwork keeps of one of its sessions as the preview listed it (`listed`: its backups,
   * leftovers of them, its attachments folder, the old usage on its record). The session is reserved (nothing resumes it
   * meanwhile) with its backups locked, and checked again just before anything goes: not running or starting, its
   * transcript not being read by Combwork (nor shown, when its last copy goes), and its copies exactly those listed. What it used is recorded in the usage
   * history first, so totals don't change. Backups that are its last copy (`lastCopy`: the CLI no longer has its
   * transcript, checked again) go with its record, all or nothing, as Delete does. `remove` removes a file (to the
   * Recycle Bin, or for good); `attachments` its listed attachments; `unchanged` throws when a listed file changed since. The CLI's own files are never touched.
   */
  async purge(projectPath: string, sessionId: string, listed: { backups: string[]; leftovers: string[]; attachments: boolean; keptUsage: boolean; lastCopy: boolean }, remove: (file: string) => Promise<void>, attachments: () => Promise<void>, unchanged?: () => Promise<void>): Promise<{ deleted: boolean }> {
    assertSessionId(sessionId)
    const check = async (): Promise<void> => {
      if (this.liveAnywhere(sessionId)) throw new SessionInUse('live', msg({ id: 'session.purge.running', defaultMessage: 'It is running.', description: 'Purge left a session alone: it is running (or starting) now.' }))
      if (beingRead(projectPath, sessionId)) throw new SessionInUse('reading', msg({ id: 'session.purge.reading', defaultMessage: 'Combwork is reading its transcript (an export or a search). Try again in a moment.', description: 'Purge left a session alone for a moment: Combwork is reading its transcript.' }))
      // A view reads the CLI's transcript while the CLI has it: only a last copy going takes what it shows.
      if (listed.lastCopy && viewingWindows(projectPath, sessionId).length) throw new SessionInUse('open', msg({ id: 'session.purge.open', defaultMessage: 'Its transcript is open in Combwork. Close it, then try again.', description: "Purge left a session alone: its transcript is open in Combwork's Sessions tab." }))
      const rec = (await workspace.sessionsFile(projectPath)).sessions.find((s) => s.id === sessionId)
      if (!rec) throw combworkError(msg({ id: 'session.purge.gone', defaultMessage: 'The session is no longer in Combwork.', description: 'Purge left a session alone: it was deleted since the preview.' }))
      const want = new Set(listed.backups.map((b) => b.toLowerCase()))
      const has = this.backupFiles(projectPath, sessionId).map((b) => b.toLowerCase())
      if (want.size && (has.length !== want.size || !has.every((b) => want.has(b)))) throw combworkError(msg({ id: 'session.purge.changed', defaultMessage: "The session's copies changed since the preview.", description: "Purge left a session alone: Combwork's copies of its transcript changed since the preview." }))
    }
    const deleted = await this.whileCleaning(projectPath, sessionId, () =>
      this.withBackupsLocked(projectPath, sessionId, async () => {
        await check()
        if (listed.backups.length && !!(await this.providerTranscript(projectPath, sessionId).catch(() => null)) === listed.lastCopy) {
          throw combworkError(listed.lastCopy ? msg({ id: 'session.purge.cliBack', defaultMessage: "The CLI has this session's transcript again.", description: "Purge left a session alone: the coding agent's own transcript is back since the preview, so Combwork's backups are no longer its last copy." }) : msg({ id: 'session.purge.cliGone', defaultMessage: "The CLI no longer has this session's transcript.", description: "Purge left a session alone: the coding agent's own transcript went since the preview, so Combwork's backups are now its last copy." }))
        }
        if ((listed.backups.length || listed.keptUsage) && !(await usageHistory.recordNow(projectPath, sessionId).catch(() => false))) {
          throw combworkError(msg({ id: 'session.purge.unread', defaultMessage: "Combwork couldn't record what the session used, so it is kept.", description: "Purge left a session alone: Combwork couldn't save its usage in the usage history, which the totals keep." }))
        }
        // Again after the waits above, and the files as listed (`unchanged`): nothing else is awaited before the first removal.
        await check()
        await unchanged?.()
        const backups = listed.backups.length ? this.backupFiles(projectPath, sessionId) : []
        for (const f of listed.leftovers) if (existsSync(f)) await inUseOnFail(() => remove(f))
        if (listed.attachments) await attachments()
        if (listed.lastCopy && backups.length) {
          await inUseOnFail(() =>
            trashAllOrNothing(backups, remove, () =>
              workspace.mutateSessions(projectPath, (f) => {
                f.sessions = f.sessions.filter((s) => s.id !== sessionId)
                if (!f.deleted?.includes(sessionId)) f.deleted = [...(f.deleted ?? []), sessionId]
              })
            )
          )
          return true
        }
        for (const b of backups) await inUseOnFail(() => remove(b))
        if (listed.keptUsage) {
          await workspace.mutateSessions(projectPath, (f) => {
            const rec = f.sessions.find((s) => s.id === sessionId)
            if (rec) delete rec.keptUsage
          })
        }
        return false
      })
    )
    if (deleted) {
      for (const a of projectAgents(await workspace.projectConfig(projectPath))) {
        if (a.lastSessionId === sessionId) await workspace.updateAgent(projectPath, a.id, { lastSessionId: undefined }).catch(() => undefined)
      }
    }
    return { deleted }
  }

  /**
   * Deletes a session from Combwork: its record and Combwork's copies of the transcript (to the Recycle Bin). The CLI's
   * own transcript is left alone (Combwork doesn't change the CLIs' files), so Combwork remembers the id to keep it hidden.
   * Clean Up… passes `expected`, the copies its preview listed (see removeBackups).
   */
  async delete(projectPath: string, sessionId: string, expected?: string[]): Promise<void> {
    projectPath = workspace.assertSessionHost(projectPath)
    await this.deleteOne(projectPath, sessionId, expected)
    log.info(`Deleted session ${sessionId} in ${userText(projectPath)}`)
    workspaceOf(projectPath).scheduleRefresh()
  }

  /**
   * delete() without its log line and refresh (bulk() does those once). All or nothing: with the session reserved and
   * nothing having it in use (assertFree; running checked again with its copies locked), Combwork's copies go to the
   * Recycle Bin and the record goes with trashAllOrNothing: if a copy fails to go, or the record can't be saved, the
   * copies already gone are put back (a copy stays in the Recycle Bin).
   */
  private async deleteOne(projectPath: string, sessionId: string, expected?: string[]): Promise<void> {
    assertSessionId(sessionId)
    const remove = (): Promise<void> =>
      this.withBackupsLocked(projectPath, sessionId, async () => {
        // Clean Up… (a session whose only copies are Combwork's): only as the preview listed it, and only once what it used is saved.
        if (expected) {
          await this.assertCleanable(projectPath, sessionId, expected)
          if (await this.providerTranscript(projectPath, sessionId)) throw combworkError(msg({ id: 'session.cleanUp.cliBack', defaultMessage: "The CLI has this session's transcript again.", description: "Clean Up… kept a session: the coding agent's own transcript is back since the preview." }))
        } else await this.assertFree(projectPath, sessionId, 'delete')
        // What it used stays in the project's totals: recorded in the usage history (#1106) before its copies go, where
        // it stays once the record is gone.
        const rec = (await workspace.sessionsFile(projectPath)).sessions.find((s) => s.id === sessionId)
        // Not recorded (the worker ended, a write another Combwork held): the session stays, Delete and Clean Up alike.
        const recorded = rec ? await usageHistory.recordNow(projectPath, sessionId).catch(() => false) : true
        if (!recorded) throw combworkError(msg({ id: 'session.cleanUp.unread', defaultMessage: "Combwork couldn't read what the session used, so it is kept.", description: "Clean Up… kept a session: Combwork couldn't read its usage, which the project's totals keep." }))
        if (expected) await this.assertCleanable(projectPath, sessionId, expected)
        this.assertNotLive(sessionId, 'delete')
        const files = this.backupFiles(projectPath, sessionId)
        await inUseOnFail(() =>
          trashAllOrNothing(
            files,
            (b) => trash(b),
            () =>
              workspace.mutateSessions(projectPath, (f) => {
                f.sessions = f.sessions.filter((s) => s.id !== sessionId)
                if (!f.deleted?.includes(sessionId)) f.deleted = [...(f.deleted ?? []), sessionId]
              })
          )
        )
      })
    await (expected ? this.whileCleaning(projectPath, sessionId, remove) : this.whileReserved(projectPath, sessionId, remove))
    // Gone: nothing reads it again, so a server marker kept for it goes too (HI-1829).
    serverMarks.deleted(projectPath, sessionId)
    for (const a of projectAgents(await workspace.projectConfig(projectPath))) {
      if (a.lastSessionId === sessionId) await workspace.updateAgent(projectPath, a.id, { lastSessionId: undefined }).catch(() => undefined)
    }
  }

  /**
   * Combwork's sessions of a host (and deleted ones') with only what totals need, for the Workspace Overview and Performance:
   * their usage from the usage history (#1106), no transcript read. Until the history has imported the host's sessions,
   * what it has so far: a record it hasn't reached yet counts its kept usage, or none (the Overview says the figures
   * are partial meanwhile). Sessions started outside Combwork aren't in it.
   */
  async usageItems(projectPath: string): Promise<SessionListItem[]> {
    projectPath = workspace.assertSessionHost(projectPath)
    const file = await workspace.sessionsFile(projectPath)
    const cfg = await workspace.projectConfig(projectPath)
    const stored = await usageHistory.storedUsage(projectPath)
    const done = usageHistory.backfilled(workspaceOf(projectPath).path ?? '')
    // Whose each was, by the agent's name now (its name then once it is gone): Performance's totals by agent (#606).
    const named = new Map(projectAgents(cfg).map((a) => [a.id, a.name]))
    // A running session's too as the history has it: its last tick or turn's end (decision 4: views may lag by a tick).
    const items: SessionListItem[] = []
    for (const rec of file.sessions) {
      const kept = stored.get(rec.id)?.usage ?? (done ? null : (rec.keptUsage ?? null))
      const usage = kept && withScreenStopsIn(kept, rec.screenStops)
      const agentName = (rec.agentId && named.get(rec.agentId)) || rec.agentName
      items.push({
        id: rec.id,
        provider: recordProvider(rec),
        source: 'combwork',
        agentId: rec.agentId,
        ...(agentName ? { agentName } : {}),
        cwd: rec.cwd,
        archived: rec.archived,
        title: null,
        lastActivity: usage?.lastActivity ?? rec.lastActiveAt,
        hasTranscript: !!usage,
        hasBackup: false,
        usage: usage && { ...usage, lastPrompt: null, title: null },
        recache: null
      })
    }
    return [...items, ...this.deletedItems(file, stored, done).map((k) => {
      const agentName = (k.agentId && named.get(k.agentId)) || k.agentName
      return agentName ? { ...k, agentName } : k
    })]
  }

  /** Deleted sessions' usage, as list items for totals (never shown in the session lists). */
  async keptUsage(projectPath: string): Promise<SessionListItem[]> {
    projectPath = workspace.assertSessionHost(projectPath)
    const done = usageHistory.backfilled(workspaceOf(projectPath).path ?? '')
    return this.deletedItems(await workspace.sessionsFile(projectPath), await usageHistory.storedUsage(projectPath), done)
  }

  /**
   * The deleted sessions of a host: those the usage history has that no record does (#1106); until it has imported the
   * host's, also the kept usage of those it hasn't reached yet (deletedUsage, from before the history).
   */
  private deletedItems(file: SessionsFile, stored: Map<string, StoredUsage>, done: boolean): SessionListItem[] {
    const records = new Set(file.sessions.map((s) => s.id))
    const item = (k: { id: string; provider: ProviderId; agentId?: string; agentName?: string; cwd?: string; name?: string; usage: SessionUsage }): SessionListItem => ({
      id: k.id,
      provider: k.provider,
      source: 'combwork' as const,
      agentId: k.agentId,
      ...(k.agentName ? { agentName: k.agentName } : {}),
      cwd: k.cwd,
      name: k.name,
      archived: true,
      deleted: true,
      title: null,
      lastActivity: k.usage.lastActivity,
      hasTranscript: false,
      hasBackup: false,
      usage: k.usage,
      recache: null
    })
    const out: SessionListItem[] = []
    // Sessions started outside Combwork are kept for the Sessions list, never counted.
    for (const [id, s] of stored) if (!records.has(id) && s.source !== 'external') out.push(item({ ...s.meta, id, usage: { ...s.usage, lastPrompt: null } }))
    if (!done) for (const k of file.deletedUsage ?? []) if (!stored.has(k.id) && !records.has(k.id)) out.push(item(k))
    return out
  }

  async rename(projectPath: string, sessionId: string, name: string): Promise<void> {
    projectPath = workspace.assertSessionHost(projectPath)
    assertSessionId(sessionId)
    // The CLI's name now: a /rename after this one changes it, and then wins (sessionLabel).
    const titleAtRename = (await this.usage(projectPath, sessionId).catch(() => null))?.customTitle ?? null
    await workspace.upsertSession(projectPath, { id: sessionId, name: name.trim(), titleAtRename })
    const l = [...this.live.values()].find((x) => x.state.sessionId === sessionId && x.state.projectPath.toLowerCase() === projectPath.toLowerCase())
    if (l) {
      // Also the name its record is written with when the CLI starts the session again (a compaction, say).
      l.name = name.trim()
      const live = l.state
      live.sessionName = name.trim()
      live.titleAtRename = titleAtRename
      this.emitState(live)
    }
  }

  async adopt(projectPath: string, sessionId: string): Promise<void> {
    projectPath = workspace.assertSessionHost(projectPath)
    assertSessionId(sessionId)
    // One adoption of a session at a time (HR2 on HI-2774): its provider's record and Combwork's are made, or taken back,
    // as one, never interleaved with another's.
    const k = `${projectPath.toLowerCase()}|${sessionId}`
    const before = this.adoptions.get(k) ?? Promise.resolve()
    const mine = before.catch(() => undefined).then(() => this.adoptNow(projectPath, sessionId))
    const kept = mine.catch(() => undefined)
    this.adoptions.set(k, kept)
    void kept.then(() => {
      if (this.adoptions.get(k) === kept) this.adoptions.delete(k)
    })
    return mine
  }
  private adoptions = new Map<string, Promise<unknown>>()

  private async adoptNow(projectPath: string, sessionId: string): Promise<void> {
    const src = await this.providerTranscript(projectPath, sessionId)
    const provider = src?.provider ?? 'claude-code'
    // As its record says, if it has one (HI-1829): a conversation that ran on a server is never read Claude-priced.
    const rec = await workspace.sessionRecord(projectPath, sessionId).catch(() => undefined)
    const usage = src ? await this.usageFor(projectPath, src.path, sessionId, provider, { reportsIgnored: !!rec?.serverRan, costFree: !!rec?.serverLocal && !rec?.notLocal }) : null
    // A sub-session (a Codex guardian review, say) stays one: never an agent's session to resume.
    const adapter = providerAdapter(provider)
    // Found in another of the host's folders, it is still one: its transcript's first line says so too (HI-2774).
    const sub = src ? ((await adapter.listSessions(projectPath).catch(() => [])).find((e) => e.id === sessionId)?.sub ?? (await adapter.subSessionOf(src.path, sessionId).catch(() => null)) ?? undefined) : undefined
    // A conversation the CLI keeps by a record of Combwork's (OpenCode's mark, HI-2774) is taken over in the CLI's data
    // first, or refused with why; what that made is taken back if the record can't be written, so nothing half-adopted stays.
    let handle: AdoptionHandle | null = null
    if (src && !sub && adapter.adopting) {
      const file = await workspace.sessionsFile(projectPath)
      const cfg = await workspace.projectConfig(projectPath)
      handle = await adapter.adopting(projectPath, sessionId, src.path, this.sessionFolders(projectPath, file.sessions, cfg))
    }
    try {
      await handle?.commit()
      await this.writeAdopted(projectPath, sessionId, provider, src, sub, usage)
    } catch (e) {
      if (handle) await handle.done(false).catch((u) => log.warn(`Taking back an adoption's record in ${userText(projectPath)}`, u))
      throw e
    }
    if (handle) await handle.done(true).catch((u) => log.warn(`Ending an adoption in ${userText(projectPath)}`, u))
    if (src && config.settings.sessions.backupTranscripts) await syncCopy(src.path, this.backupPath(projectPath, sessionId)).catch(() => undefined)
  }

  /** An adopted session's record (a seam for tests: its write failing must take back what the adoption made). */
  writeAdopted = async (projectPath: string, sessionId: string, provider: ProviderId, src: { path: string } | null, sub: SubSession | undefined, usage: SessionUsage | null): Promise<void> => {
    await workspace.upsertSession(projectPath, {
      ...(sub ? { sub } : {}),
      id: sessionId,
      agent: provider,
      // A session's stored name, which agents read and the user can rename: said in the Default.
      name: usage?.title ?? inDefaultDialect(() => say(SESSION.adopted, { id: sessionId.slice(0, 8) })),
      titleAtRename: usage?.customTitle ?? null,
      createdAt: usage?.firstActivity ?? new Date().toISOString(),
      lastActiveAt: usage?.lastActivity ?? new Date().toISOString(),
      ...(src && !providerDescriptor(provider).capabilities.fixedSessionId ? { transcriptPath: src.path } : {})
    })
  }
}

export const sessions = new SessionManager()
// HI-2887: a hold against launches reads the live sessions' folders.
setLiveFolders(() => sessions.liveStates().flatMap((s) => (s.cwd ? [s.cwd] : [])))
// A workspace closing (HI-1829): its server markers whose records couldn't be saved can't be kept for its reopening.
WorkspaceService.closingListeners.add((path) => serverMarks.closing(path))
onLanguageChange(() => sessions.relabel())
// Agent text's chain resolver (dialects, HI-2443): a session's chain is the one pinned at its launch; a caller with no
// session (the Agent API's scripts and viewers) gets the API chain of the workspace its request is for, which follows
// the files (servers.ts binds it: inApiWorkspace).
setChainResolver((scope) => (scope.kind === 'session' ? sessions.pinnedChain(scope.session.projectPath, scope.session.agentId) : requestApiChain()))
WorkspaceService.dialectsListeners.add((ws) => apiChainChanged(ws.combworkDir))
WorkspaceService.closingListeners.add((path) => forgetApiChain(join(path, CW_DIR)))
