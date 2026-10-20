import { randomUUID, randomBytes } from 'crypto'
import { fmt, msg, onLanguageChange, tr } from '../shared/i18n'
import { drawnWaitId, englishText, shownText, withValues, type Text, type TextPart } from '../shared/advanced'
import { capturedText, hiveError, HiveError, shownError } from './hiveError'
import { assertUpgraded } from './boardStore'
import { advanced } from './advanced'
import { folderChanging, folderSteady } from './folderFence'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'path'
import { copyFile, lstat, mkdir, open, readdir, rename, rm, rmdir, stat, writeFile } from 'original-fs/promises'
import { constants as fsConstants, existsSync, realpathSync } from 'original-fs'
import { typedText } from '../shared/terminalInput'
import { failedStart, type StartFailure } from '../shared/startFailure'
import { BrowserWindow, Notification, app, clipboard } from 'electron'
import { ASSISTANT_DIR, ASSISTANT_NAME } from '../shared/assistant'
import { formatDateTime } from '../shared/dates'
import { formatSize } from '../shared/units'
import { assistantTools } from '../shared/assistantTools'
import { HIVE_DIR, isCompacting, agentPtyKey, assertSessionId, cliRename, isSessionId, projectAgents, resumeRecord, transcriptWarnLimit } from '../shared/defaults'
import { agentLaunchSettings, defaultProviderPending, extraArgsProblem, isProviderEnabled, modeAllowed, permissionLabel, providerDescriptor, providerSettings, splitArgs, tasksWillWake } from '../shared/providers'
import { resolvedModel } from '../shared/models'
import type {
  AutoCompactSetting,
  AgentDef,
  AgentInfo,
  EffortLevel,
  FileLockMode,
  LiveSessionState,
  RuntimeFacts,
  McpServerDef,
  McpServerInfo,
  PermissionMode,
  ProjectConfig,
  ProviderId,
  InboxSummary,
  SessionBulkAction,
  SessionBulkResult,
  Attached,
  AttachmentPlan,
  SessionListItem,
  SessionRecord,
  SessionSkipReason,
  SubSession,
  SessionStatus,
  SkillInfo,
  SessionUsage,
  TaskWatchInfo,
  ToastAction
} from '../shared/types'
import { provider as providerAdapter, allProviders } from './providers'
import { recacheEstimate } from './providers/common'
import { GZ, compressFile, decompressTo, expandBackup, isGz } from './transcriptFiles'
import { usesOwnPrices } from '../shared/prices'
import { priceUsage } from '../shared/usageDays'
import type { Ask, HookEvent, LaunchContext, LaunchSkill, ProviderAdapter, SkillDelivery } from './providers/types'
import { providerService } from './providerService'
import { config } from './config'
import { emit, emitTo, tellListeners, toast } from './events'
import { presentWindow, showOsNotification, testNotifyLog, testQuiet } from './testQuiet'
import { hashText, heldOpen, insideReal, isInUse, placeRelative, removePath, samePlace, treeSignature, syncCopy, syncCopyLocked, syncCopyNow, trashAllOrNothing, withFileLock } from './fsutil'
import { createLogger, hookJournal, userText } from './logger'
import { COMPACTING_TEXT } from '../shared/runtime'
import { applyStep, compactionOver, expireTasks, hookStep, idleAfter, markedIdle, safeguardAnswered, SAFEGUARD_IDLE_MESSAGE, startupScreen, startupWatched, titleStep, type HookStatusInput, type HookStep } from './hookStatus'
import { memoModel, memoTools, memoTurn, noteSafeguard, safeguardComment, safeguardText, seenInTurn, withScreenStops, type GuardTurns, type SafeguardEvent, type ScreenStop } from '../shared/safeguards'
import { admit, describe as describeTurn, endRunning, expectInjected, heard, newLedger, openCalls, reconciles, silentFor, unheardStop, type ScreenReading, type TurnLedger } from './turnLedger'
import { Compaction } from './compaction'
import { lastTitle } from './terminalTitle'
import { asksYou } from '../shared/inbox'
import type { DeliveryHooks, NewDelivery } from './deliveries'
import { readyFor } from './readiness'
import { HAND_OVER_TEXT, handOverNow } from '../shared/handOver'
import { NOTICE_PREFIX } from '../shared/doorbell'
import { FinishBatcher, finishedApiTitle, finishedNotice, noticeRoute, type FocusedHive, type NoticeRoute } from '../shared/bursts'
import type { SlotNote } from './mergeSlots'
import { commentOnDoingCards, recordCards } from './cardSessions'
import { listMcp, toLaunchDef } from './mcp'
import { agentGetsMcp, serverOnIn } from '../shared/agentMcp'
import { launchEnded, leftoversOf, noteUntracked, settleLeftovers, STOPPED_BEFORE_START, trackingProblemText, trackingReady, trackLaunch, type TrackResult } from './agentProcesses'
import type { GateWord } from './launchGate'
import { leftoversSummary, processCount } from '../shared/agentProcesses'
import { childEnv, killPty, refreshPty, spawnPty, startSize, writePty } from './ptyHost'
import { refreshPathBeforeStart } from './freshPath'
import { TerminalScreen } from './terminalScreen'
import { KeysStopped, PickNotFound, typeKeySteps } from './keySteps'
import { withBinOnPath } from './progressReporters/shims'
import { hiveSkills, parseSkillFrontmatter, skillFor } from './skills'
import { GUIDANCE_REVISION, launchParts, launchRecord } from './guidance'
import { notificationIcon } from './paths'
import { reportPlanUsage } from './planUsage'
import { devConsole, sessionSourceId } from './devConsole'
import { flightRecorder } from './flightRecorder'
import { DETAILS_FIELDS, HOOK_FIELDS, HOOK_MADE_FIELDS, STATUSLINE_FIELDS, safeWord } from '../shared/devConsole'
import { hookSummary, launchEvent, statusLineSummary, transcriptEvent } from './devConsoleWords'
import { ScreenRecognition } from './screenRecognition'
import { revisionOf } from './revisions'
import { metricsHandle, recordLaunch } from './metrics'
import { headerOf } from './revisions'
import { utf8Bytes } from '../shared/metrics'
import { inWorkspace, workspace, workspaceFor, workspaceOf, type SessionsFile } from './workspace'
import { usageHistory, type StoredUsage } from './usageHistory'
import { journalSettingsOf } from './journalService'
import { endAgentToken, newAgentToken } from './agentTokens'
import { endHookToken, newHookToken } from './hookTokens'
import { beingRead, viewingWindows } from './transcriptReads'
import { trash } from './trash'
import { attachmentsDir, freeName, ownAttachmentsFolder } from './attachmentsFolder'
import { attachmentKind } from '../shared/attachments'
import { replyStart } from '../shared/tiles'
import { observer } from './platform/observe'

const log = createLogger('sessions')

/**
 * Hive's own words for sessions (#847, E10c of #677): errors (HiveErrors, in the window's language through IPC and in
 * English for the Agent API), statuses (LiveSessionState.statusText beside the English statusMessage), notices (a
 * translated title with its English for the Agent API's stream) and toasts. Text agents read (prompts Hive types, lock
 * replies, deliveries), the log and the developer console stay English.
 */
const M = {
  noSession: msg({ id: 'session.error.noSession', defaultMessage: 'No session is running for this agent.', description: "An action on an agent's session is refused: the agent isn't running." }),
  stoppedBeforeStart: msg({ id: 'session.error.stoppedBeforeStart', defaultMessage: 'The agent was stopped before it had started.', description: "Starting an agent failed: it was stopped (or its workspace closed) while it was starting." }),
  stoppedBeforePrompt: msg({ id: 'session.error.stoppedBeforePrompt', defaultMessage: 'The agent stopped before the prompt was sent.', description: 'Typing a prompt into an agent failed: it stopped or restarted meanwhile.' }),
  typingBusy: msg({ id: 'session.error.typingBusy', defaultMessage: 'Hive is already typing a prompt into this agent; it is busy.', description: 'An action on an agent is refused: Hive is typing a prompt into it now.' }),
  inUseElsewhere: msg({ id: 'session.error.inUseElsewhere', defaultMessage: 'Another program has its transcript open. Close it, then try again.', description: "Archiving or deleting a session is refused: another program holds its transcript file open." }),
  stopFirst: msg({ id: 'session.error.stopFirst', defaultMessage: '{action, select, archive {Stop the session before you archive it.} unarchive {Stop the session before you unarchive it.} other {Stop the session before you delete it.}}', description: 'Archiving, unarchiving or deleting a session is refused while it runs. {action} says which.' }),
  sessionRunning: msg({ id: 'session.error.running', defaultMessage: 'The session is running.', description: "Clean Up… is refused for a session: it is running." }),
  handOverNotNow: msg({ id: 'session.handOver.notNow', defaultMessage: "{agent} is working, merging or on a card loop's card, so its conversation isn't ended now. Hand it over to a new conversation when it has finished.", description: 'Handing an agent over to itself (a new conversation) is refused: it is working, holds the merge slot or works on a card of a running card loop. {agent} is its name.' }),
  handOverMomentLost: msg({ id: 'session.handOver.momentLost', defaultMessage: '{agent} took the merge slot, started other work or changed while it wrote its handover, so its conversation wasn\'t ended. The handover "{handover}" is kept.', description: 'Handing an agent over to itself stopped before ending its conversation: while it wrote its handover it began merging (the merge slot), began other work (a task, a card loop\'s card) or restarted. {agent} is its name, {handover} the handover\'s path in the shared notes.' }),
  handOverBusy: msg({ id: 'session.handOver.busy', defaultMessage: '{agent} is busy. Hand over once it has finished.', description: "Hand Over to… is refused: the agent named is working. {agent} is the agent's name." }),
  switchEnded: msg({ id: 'session.mode.ended', defaultMessage: 'The session ended before Hive could switch it to {mode}.', description: "Switching a running agent's permission mode failed: its session ended. {mode} is the mode's name." }),
  needsInput: msg({ id: 'session.notice.needsInput', defaultMessage: '{agent} needs your input', description: "A notification's title: an agent waits for the user. {agent} is the agent (\"hive · B1\", or the project when it has one agent)." }),
  finished: msg({ id: 'session.notice.finished', defaultMessage: '{agent} finished', description: "A notification's title: an agent's turn has ended. {agent} is the agent (\"hive · B1\", or the project when it has one agent)." }),
  longConversation: msg({ id: 'session.notice.longConversation', defaultMessage: '{agent}: long conversation', description: "A notice's title: an agent's transcript has grown past the size set in Settings → Sessions. {agent} is the agent." })
}

/**
 * Sets an agent's status message (#845): Hive's own as text (its English in `statusMessage`, which agents read and Hive
 * compares, and `statusText`, which the window shows in its language), the CLI's words as they came, or null to clear it.
 */
function setStatus(st: LiveSessionState, text: TextPart | null): void {
  st.statusMessage = text === null ? undefined : englishText(text)
  st.statusText = text === null || typeof text === 'string' || typeof text === 'number' ? undefined : text
}

/** An agent's place at the merge slot as the window shows it (LiveSessionState.mergeSlotText); `mergeSlot` is its English (shared/mergeSlot.ts). */
function slotNoteText(note: SlotNote): Text {
  if ('holding' in note) return withValues(msg({ id: 'session.mergeSlot.holding', defaultMessage: 'Merging into {branch} (merge slot)', description: "An agent's status while it holds the project's merge slot. {branch} is the branch it merges into." }), { branch: note.holding })
  const h = note.waitingFor
  if (!h) return msg({ id: 'session.mergeSlot.waiting', defaultMessage: 'Waiting for the merge slot', description: "An agent's status while it waits for the project's merge slot." })
  if (h.kind === 'user') return msg({ id: 'session.mergeSlot.waitingForYou', defaultMessage: 'Waiting for the merge slot (you are merging)', description: "An agent's status while it waits for the merge slot the user holds (merging from Hive's Merge dialog)." })
  const cards = h.cards.map((n) => `#${n}`).join(', ')
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

export interface HiveMcpProvider {
  /** The hive MCP server for a project's sessions; with agentId, that agent's (its tools then say who is calling). */
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
/** How long after an ask its CLI's screen may take to show it is a safeguard prompt (LiveSession.guardAsk, #606). */
const GUARD_ASK_MS = 10_000
/** How many stops seen only on screen a session's record keeps (SessionRecord.screenStops). */
const MAX_SCREEN_STOPS = 200
/**
 * How long a turn may run with nothing heard of it (no hook, no transcript growth, no tool call under way) before Hive
 * looks for its end on the CLI's screen, and failing that says its state is unknown (#648). Never an end in itself.
 * Unpackaged test builds can shorten it (HIVE_TEST_SILENT_MS).
 */
const silentMs = (): number => (!app.isPackaged && Number(process.env.HIVE_TEST_SILENT_MS) > 0 ? Number(process.env.HIVE_TEST_SILENT_MS) : 5 * 60_000)
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
  /** The terminal as rendered, for an adapter that reads it (its footer's mode, or a menu to pick from: #396). */
  screen?: TerminalScreen | null
  /** The size refreshes given so far, for a CLI that needs them (capabilities.startupSizeRefresh, #486). */
  sizeRefreshed?: 'started' | 'ready'
  /** The transcript's modified time and size at the last look ("mtime:size"). */
  transcriptMtime: string
  /** Where the provider writes this session's transcript, once known (from a hook, or found by id). */
  transcriptPath?: string
  backupTimer?: NodeJS.Timeout
  /** When the transcript was last copied to .hive/sessions (see BACKUP_INTERVAL_MS). */
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
  /** Set while a compaction Hive asked for runs. */
  compacting?: Compaction
  /** The user stopped it (e.g. during its worktree setup), so an early exit isn't reported as a failure. */
  stopRequested?: boolean
  /** Its CLI is being ended with its exit keys (endProcess): a second stop kills it at once. */
  ending?: boolean
  /** Terminal output tail, to see the CLI ready or asking something at the start. */
  modeTail: string
  /** What Hive recognised on its screen this launch, whatever its status (the developer console's contract markers, #638). */
  recognition: ScreenRecognition
  /** The mode it was launched in. */
  launchMode: PermissionMode | null
  /** The mode the settings asked for when it launched, or when the user last applied a settings change to it. */
  configuredMode: PermissionMode | null
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
  /** The last compaction end read from the transcript (LiveDetails.compactedAt, #454), so each counts once. */
  compactedAt?: string
  /**
   * The launch's hooks that have arrived, counted as each comes (before its turn in the queue): an interrupt read from
   * the transcript is dropped if one came after the read began, as that hook says something newer (#475).
   */
  hooksSeen?: number
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
   * This launch was given Hive's tools (the hive MCP server, #865): `connecting` until its server says the CLI has
   * connected (POST /v1/launch/connected), and no line of Hive's is typed meanwhile, at most hive.mcp.connectSeconds
   * from when it first became ready (readyAt), for a CLI that never connects it.
   */
  hiveTools?: 'connecting' | 'connected'
  /** When this launch first became ready (or watching, or finished), in ms (#865). */
  readyAt?: number
  /**
   * The session its next conversation was handed over from (#782): recorded with that conversation once its id is known
   * (Codex's comes with its first prompt, which may be minutes away behind a question at start), then let go.
   */
  handedOverFrom?: string
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
  /** Asks its hooks reported that are still open, and the one it waits on (HookStatusInput). */
  open?: Ask[]
  waitingOn?: Ask | null
  /** Background tasks started in this launch that haven't ended: id → when it started, and when it expires. */
  tasks?: Map<string, { at: number; expiresAt?: number }>
  /** Tasks seen to end, so a start read late doesn't count one again. */
  tasksEnded?: Set<string>
  /** Bytes of the transcript already read for background tasks. */
  tasksOffset?: number
  /** What the adapter keeps between those reads (a call whose output comes later). */
  tasksMemo?: Record<string, unknown>
  /** Bytes of the transcript already read for safeguard stops (#606), and what the adapter keeps between reads (its model, its last tool calls). */
  guardOffset?: number
  guardMemo?: Record<string, unknown>
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
  /** When its latest turns began (as Hive saw each start), newest last: what a hand-over to itself checks (#1057). */
  turnStarts?: number[]
  /** The ledger's turn last seen, to tell a new one. */
  turnSeen?: object
  /** This launch resumes a conversation (a failed start's Retry resumes it again). */
  resumed?: boolean
  /** The Hive Assistant's mode (its id) its conversation was last given, started in or told: recorded with it. */
  mode?: string
  /** Prompts the CLI has reported submitted in this launch (UserPromptSubmit), for sendPrompt's confirm and a wake's (#376). */
  prompts?: number
  /**
   * Hive's latest typed prompt (sendPrompt): when (`at`, its Enter; `from`, when its typing reserved the composer), and the
   * prompts taken then. Until the CLI takes it, it is pending (#416).
   */
  typed?: { at: number; prompts: number; from: number }
  /**
   * A line of Hive's the user typed into before its CLI took it (#652 round 1 finding 2): the prompt is their draft now, so
   * nothing more is typed into the agent until a prompt is submitted (the CLI's count passes this).
   */
  draftOver?: { prompts: number }
  /** The start of its latest reply, as its last turn's end reported it (an agent watch's line, #416). */
  lastReply?: string
  /** Its latest hooks (what they were, when, and the status they left), for the log when the CLI turns out idle (#612). */
  recentHooks?: { kind: HookEvent['kind']; at: number; status: SessionStatus }[]
  /** Its CLI's turns as Hive knows them (#648): which runs and which are over, by the CLI's ids, and when it was last heard. */
  ledger?: TurnLedger
  /** The CLI's own latest record of a turn's end read from its transcript (LiveDetails.turnEnded). */
  turnRecord?: { turn: string; at: string } | null
  /** When the CLI answered its Stops this launch, as it recorded them (LiveDetails.stopsAnswered, ms; the latest STOPS_KEPT). */
  stopsAnswered?: number[]
  /** Its screen's reading of the CLI's turn (idle, working, not sure), for this launch's CLI version (ProviderAdapter.turnScreen). */
  turnScreen?: (screen: string) => 'idle' | 'working' | null
  /** Its transcript says its background task ended, which starts a turn of the CLI's own (backgroundWakes), not begun yet in the ledger. */
  woke?: boolean
  /**
   * A typed wake being confirmed (#430: watches' confirmTaken, from its typing until it is taken, marked not taken, or the
   * launch ends): nothing more is typed into it meanwhile, however long that takes. A token, so only its own release
   * clears it.
   */
  confirming?: symbol
}

export interface EffectiveSettings {
  provider: ProviderId
  skills: LaunchSkill[]
  skillHashes: Record<string, string>
  /** Hive skills nobody gets because their header can't be read (name → why): in the launch's problems. */
  skillProblems: Record<string, string>
  mcpServers: Record<string, McpServerDef>
  model: string | null
  effort: EffortLevel | null
  permissionMode: PermissionMode | null
  extraArgs: string[]
  use200kContext: boolean
  chime: boolean
}

/** Files read once for a whole session list (instead of once per session). */
/** An agent start in progress, before (or while) its process spawns. */
interface PendingStart {
  projectPath: string
  /** The session being resumed, if any. */
  resumeId?: string
  /** Set by a stop, workspace close or quit: the start gives up at its next check. */
  cancelled: boolean
  /** Settles when the start has finished or given up. */
  done: Promise<unknown>
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

/** What Hive types to tell an agent it may make the locked edits the user allowed. */
function goAheadPrompt(cwd: string, paths: string[]): string {
  const files = paths.map((p) => placeRelative(cwd, p) || basename(p)).join(', ')
  // i18n-ignore: typed to the agent (agent-facing text stays English)
  return `The user allowed you to edit ${files} while the other agent works on ${paths.length > 1 ? 'them' : 'it'}. Go ahead with the ${paths.length > 1 ? 'edits' : 'edit'}.`
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
  /** Worked out from raw (with costs); null until asked for again after a price change. */
  usage: SessionUsage | null
}
const usageSeen = new Map<string, UsageSeen>()
/** Transcripts main keeps the latest usage of (the worker keeps more: Settings → Sessions → Usage cache size). */
const MAX_USAGE_SEEN = 200

/**
 * A transcript's size for the Sessions list (#671): a stat, never a read, taken each time the list is (the window keeps
 * the list, and reloads it when it opens or a session changes). Null when it is missing or can't be read.
 */
async function transcriptSize(path: string | null | undefined): Promise<number | null> {
  if (!path) return null
  try {
    return (await stat(path)).size
  } catch {
    return null
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
    if (!still()) throw hiveError(M.stoppedBeforePrompt)
    writePty(key, text.slice(i, i + CHUNK))
    if (i + CHUNK < text.length) await new Promise((r) => setTimeout(r, 10))
  }
}

/**
 * Whether a line Hive is typing has been drawn on an agent's screen (#600): its end (spaces left out, as a CLI wraps
 * it) shows more often than when this was called, before it was typed (a doorbell's end is in its earlier ones too).
 */
export function drawnLine(screen: Pick<TerminalScreen, 'text'>, line: string): () => boolean {
  const end = line.replace(/\s+/g, '').slice(-40)
  const count = (): number => (end ? screen.text().replace(/\s+/g, '').split(end).length - 1 : 0)
  const before = count()
  return () => count() > before
}

/** Runs a worktree's setup command in the agent's terminal (Windows: cmd.exe, elsewhere: sh). */
function shellCommand(command: string): { file: string; args: string[] } {
  return process.platform === 'win32' ? { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] } : { file: '/bin/sh', args: ['-c', command] }
}

const shownNotifications = new Set<Notification>()

/** A new session's automatic name: "<project> · <date>", with the agent's name when the project has several. */
function autoName(projectPath: string, agent: Pick<AgentDef, 'name'>, count: number): string {
  return `${basename(projectPath)}${count > 1 ? ` · ${agent.name}` : ''} · ${formatDateTime(new Date())}`
}

/** How long a background task counts as running at most (Settings → Agents), in minutes. */
const taskMinutes = (): number => Math.min(480, Math.max(10, Number(config.settings.agents.backgroundTaskMinutes) || 60))

const liveId = (projectPath: string, agentId: string): string => `${projectPath.toLowerCase()}#${agentId}`

/**
 * The workspace's skills (their list and each one's revision) and MCP servers, read once for the agents whose launch
 * settings are worked out together (#1002): a refresh worked out every running agent's, reading them all again for each
 * one. The first read is made in the caller's workspace; one set of reads is never used for another workspace.
 */
export class LaunchReads {
  private skillList: Promise<SkillInfo[]> | null = null
  private serverList: Promise<McpServerInfo[]> | null = null
  private revisions = new Map<string, Promise<string>>()

  skills(): Promise<SkillInfo[]> {
    return (this.skillList ??= hiveSkills())
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
export class SessionInUse extends HiveError {
  constructor(
    readonly reason: SessionSkipReason,
    text: Text
  ) {
    super(text)
  }
}


/** Runs a move of Hive's copies; a copy another program holds fails it as SessionInUse. */
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
 * and description, from the header Hive reads anyway) and its bytes on disk (the bounded stat walk, no file read). A
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

/** How long a prompt Hive typed counts as pending (the agent just given a task) while its CLI hasn't taken it (#416). */
const PENDING_MS = 30_000

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
/** Hive's own deliveries come from it (#649). */
const HIVE_SENDER = { kind: 'hive', name: 'Hive' } as const // i18n-ignore: the sender's name in deliveries, which agents read
// i18n-ignore: typed to the agent (agent-facing text stays English)
const CARRY_ON_PROMPT = 'Your last turn stopped because your sign-in had expired. It is renewed now: carry on where you left off.'

class SessionManager {
  private live = new Map<string, LiveSession>()
  /**
   * CLIs whose sign-in was refused, until signed in again (#309): the user is told once per CLI and expiry (agents
   * stopping later only show it), and the CLI's own check runs again meanwhile, to notice the sign-in.
   */
  private signedOut = new Map<ProviderId, { gather?: ReturnType<typeof setTimeout>; recheck?: ReturnType<typeof setInterval> }>()
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
  /** "Allow" given while the agent was still in its turn (`<liveId>|<lock key>` → the file's path): the go-ahead it gets when that turn ends. */
  private lockGoAhead = new Map<string, string>()
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
  } | null = null
  private delivery(): NonNullable<SessionManager['deliveries']> {
    if (!this.deliveries) throw hiveError(msg({ id: 'session.error.noDeliveries', defaultMessage: "Hive's delivery service isn't running.", description: "Giving an agent a message failed: the part of Hive that delivers them hasn't started (or has stopped)." }))
    return this.deliveries
  }
  hookUrl = ''
  apiEnv: (projectPath: string, agentId: string) => Record<string, string> = () => ({})
  /** Hive's bin folder (hive-progress), first on each session's PATH; null until written, or when it couldn't be. */
  binDir: string | null = null
  hiveMcp: HiveMcpProvider = () => null
  /** Hive's guidance for agents (the hive MCP server's instructions), for providers that need it at launch. */
  hiveGuidance: (projectPath: string) => Promise<string> = async () => ''
  /** Before each Hive Assistant launch (its workspace gets a new Agent API token). */
  onAssistantLaunch: (projectPath: string) => Promise<void> = async () => undefined
  /** The user sent the Hive Assistant a message (a new turn). */
  onAssistantPrompt: (projectPath: string) => void = () => undefined
  /** The Hive Assistant's process ended (its token is revoked, its questions withdrawn). */
  onAssistantExit: (projectPath: string) => void = () => undefined
  /** When the user last typed in each terminal (by pty key), so nothing else types over them. */
  private userInput = new Map<string, { at: number; enter: boolean }>()
  /** The Hive Assistant's instructions for a launch (who it is, and its mode's), and the mode's name and id. */
  assistantInstructions: (projectPath: string, agent: AgentDef) => Promise<{ text: string; mode: string; modeId: string; modeText: string }> = async () => ({ text: '', mode: '', modeId: '', modeText: '' })
  /**
   * A Hive Assistant conversation was resumed in the mode `modeId`: main/assistantMode.ts tells it that mode
   * once it is idle, if the conversation was last given another (#334).
   */
  onAssistantResumed: (projectPath: string, runId: string, sessionId: string, modeId: string) => void = () => undefined
  /** An agent's wake-on-change watch, if it has one (main/watches.ts sets this). */
  watchFor: (projectPath: string, agentId: string) => TaskWatchInfo | null = () => null

  /** The prompts an agent's CLI has taken in this launch, and the launch (#376: was a typed line taken?). Null when not running. */
  promptsTaken(projectPath: string, agentId: string): { runId: string; count: number } | null {
    const l = this.live.get(liveId(projectPath, agentId))
    return l?.state.runId ? { runId: l.state.runId, count: l.prompts ?? 0 } : null
  }

  /**
   * A running agent as an agent watch reads it (#416), or null when it isn't running. A prompt Hive typed within the last
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
   * Whether an agent's CLI hasn't taken its launch's task yet (#712), as agentNow counts it (#721): nothing of Hive's is
   * typed into it meanwhile, or its CLI's first prompt, the task's, would be taken for that line's and the line would go
   * first.
   */
  launchTaskWaiting(projectPath: string, agentId: string): boolean {
    const l = this.live.get(liveId(projectPath, agentId))
    return !!l && launchPending(l)
  }

  /**
   * Whether an agent's launch was given Hive's tools and its CLI hasn't connected them yet (#865): a resumed Claude Code
   * is ready at its SessionStart before its hive server has connected, and a doorbell typed then is a turn that can't
   * call hive_inbox. At most hive.mcp.connectSeconds from when it first became ready, for a CLI that never connects it
   * (its server failed to start, or MCP is off in it).
   */
  hiveToolsWaiting(projectPath: string, agentId: string): boolean {
    const l = this.live.get(liveId(projectPath, agentId))
    if (l?.hiveTools !== 'connecting') return false
    return l.readyAt === undefined || Date.now() - l.readyAt < advanced.number('hive.mcp.connectSeconds') * 1000
  }

  /**
   * The hive server of an agent's launch `runId` says its CLI has connected (#865): Hive's lines may go to it now, and
   * what waited is offered at once (its status is sent again, which deliveries follow). Whether it was that launch's.
   */
  /** Who waits for a launch's hive tools (hiveToolsSettled), by agent: each looks at the gate again when told. */
  private toolsWaiters = new Map<string, Set<() => void>>()
  /** The waits look again when Settings → Advanced changes (the bound applies at once), once one has waited. */
  private toolsSettingsHook: (() => void) | null = null

  /** The waits for an agent's hive tools look at the gate again (it connected, its launch changed or ended). */
  private recheckTools(key: string): void {
    for (const look of [...(this.toolsWaiters.get(key) ?? [])]) look()
  }

  /**
   * Resolves once an agent's hive tools no longer hold its lines (#865 rounds 3 and 4): once hiveToolsWaiting, the gate
   * itself, is false. It is looked at again when the tools connect, the launch's state changes or it ends, the bound is
   * changed in Settings → Advanced, and when what is left of the bound from its ready runs out; never a frozen deadline.
   */
  hiveToolsSettled(projectPath: string, agentId: string): Promise<void> {
    if (!this.hiveToolsWaiting(projectPath, agentId)) return Promise.resolve()
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
        if (this.hiveToolsWaiting(projectPath, agentId)) {
          const l = this.live.get(key)!
          const bound = advanced.number('hive.mcp.connectSeconds') * 1000
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

  hiveToolsConnected(projectPath: string, agentId: string, runId?: string): boolean {
    const l = this.live.get(liveId(projectPath, agentId))
    if (!l || (runId !== undefined && l.state.runId !== runId)) return false
    if (l.hiveTools !== 'connecting') return true
    l.hiveTools = 'connected'
    this.recheckTools(liveId(projectPath, agentId))
    log.info(`${userText(agentId)}'s hive tools connected${l.readyAt === undefined ? '' : ` ${Date.now() - l.readyAt} ms after it became ready`}`)
    this.emitState(l.state)
    return true
  }

  /**
   * Presses Enter again in an agent whose typed line wasn't taken (#376: a CLI dropped the Enter, and the line stayed in
   * its prompt). Only in the same launch, while it is idle (watching too: a watch lasts until its wake is received, #649),
   * and not while the user types there or Hive types into it.
   */
  submitAgain(projectPath: string, agentId: string, runId: string): boolean {
    const l = this.live.get(liveId(projectPath, agentId))
    const key = this.key(projectPath, agentId)
    // Nor while its folder is being changed (#646 round 1: the Enter would start a turn under a Git switch or pull).
    if (!l || l.state.runId !== runId || !readyFor(l.state) || this.userMayBeTyping(projectPath, agentId) || this.delivering.has(key) || folderChanging(l.state.cwd)) return false
    // The prompt is the user's draft once they have typed in it (#652 round 1 finding 2): never sent by Hive's Enter.
    if (this.userTypedOverLine(projectPath, agentId)) return false
    writePty(key, '\r')
    return true
  }

  /**
   * Whether the user has typed in an agent's terminal since Hive's line still waiting there began to be typed (#530, #652
   * round 1 finding 2): the prompt holds their input too, whatever the typing pause says (0 included), and is theirs, not
   * Hive's to submit. False when no line of Hive's waits.
   */
  userTypedOverLine(projectPath: string, agentId: string): boolean {
    const l = this.live.get(liveId(projectPath, agentId))
    return !!l?.typed && (l.prompts ?? 0) <= l.typed.prompts && this.userTypedAt(projectPath, agentId) >= l.typed.from
  }

  /**
   * Leaves Hive's untaken line to the user, who typed into it (#652 round 1 finding 2): never submitted or cleared by Hive,
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
    const which = cards.map((n) => `#${n}`).join(', ')
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
    l.state.mergeSlotText = text !== null && about ? slotNoteText(about) : undefined
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
  /** Hive is quitting: no new agent starts. */
  private shuttingDown = false
  /** The window showing a project (several windows each show one workspace). */
  private getWindow: (projectPath?: string) => BrowserWindow | null = () => null

  setWindowProvider(fn: (projectPath?: string) => BrowserWindow | null): void {
    this.getWindow = fn
  }

  /** The Hive window the user is using (visible, focused): where in-app banners go (#157). None while Hive is in the background. */
  private focusedHive: () => (FocusedHive & { win: BrowserWindow }) | null = () => null

  setFocusedWindowProvider(fn: () => (FocusedHive & { win: BrowserWindow }) | null): void {
    this.focusedHive = fn
  }

  key(projectPath: string, agentId: string): string {
    return agentPtyKey(projectPath, agentId)
  }

  /** The agent a call that names none means: the project's only agent. */
  async soleAgent(projectPath: string): Promise<string> {
    const agents = projectAgents(await workspace.projectConfig(projectPath))
    if (agents.length === 1) return agents[0].id
    if (agents.length) throw hiveError(msg({ id: 'session.error.severalAgents', defaultMessage: 'This project has several agents: choose which one.', description: "An action that names no agent is refused: the project has more than one." }), undefined, { kind: 'invalid' })
    throw hiveError(msg({ id: 'session.error.noAgents', defaultMessage: 'This project has no agents yet. Add one first.', description: 'An action on an agent is refused: the project has none.' }), undefined, { kind: 'conflict' })
  }

  liveCount(provider?: ProviderId): number {
    return provider ? [...this.live.values()].filter((l) => l.state.provider === provider).length : this.live.size
  }

  liveStates(): LiveSessionState[] {
    return [...this.live.values()].map((l) => l.state)
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

  projectStates(projectPath: string): LiveSessionState[] {
    const prefix = `${projectPath.toLowerCase()}#`
    return [...this.live.entries()].filter(([k]) => k.startsWith(prefix)).map(([, l]) => l.state)
  }

  private async agentDef(projectPath: string, agentId: string): Promise<{ agent: AgentDef; cfg: ProjectConfig; count: number }> {
    const cfg = await workspace.projectConfig(projectPath)
    const agents = projectAgents(cfg)
    const agent = agents.find((a) => a.id === agentId)
    if (!agent) throw hiveError(msg({ id: 'session.error.agentGone', defaultMessage: 'That agent no longer exists.', description: 'An action on an agent is refused: it was removed meanwhile.' }), undefined, { kind: 'notFound' })
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
    const s = config.settings
    const pc = readPc ?? (await workspace.projectConfig(projectPath))
    const assistant = workspace.isAssistantHome(projectPath)
    // Every Hive skill for its audience (SKILL.md's metadata.audience) reaches the session: project agents get those for
    // agents, the Assistant those for it. There are no skill switches.
    // A skill whose header is broken or whose audience is unknown reaches nobody: the launch says why (its problems).
    const skills: LaunchSkill[] = []
    const skillHashes: Record<string, string> = {}
    const skillProblems: Record<string, string> = {}
    for (const sk of await reads.skills()) {
      if (sk.problem) {
        skillProblems[sk.name] = sk.problem
        skillHashes[sk.name] = ''
      } else if (skillFor(sk.audience, assistant ? 'assistant' : 'agent')) {
        skills.push({ name: sk.name, sourcePath: sk.path })
        skillHashes[sk.name] = await reads.revision(sk.path)
      }
    }
    // The workspace's servers on in the project (#713); the agent's own choice narrows them (#537): all of them unless
    // it names some. Never one named as Hive's own (a hand-made .hive/mcp/hive.json): the CLIs pre-approve that one's tools.
    const forAgent = agent ?? projectAgents(pc)[0]
    const mcpServers: Record<string, McpServerDef> = {}
    for (const m of await reads.servers()) {
      if (serverOnIn(m, pc.mcp) && m.def && agentGetsMcp(forAgent, m.name) && m.name.toLowerCase() !== 'hive') mcpServers[m.name] = toLaunchDef(m.def, workspace.mcpDir)
    }
    const hive = this.hiveMcp(projectPath, agent?.id)
    if (hive) mcpServers.hive = hive
    // The Assistant looks after the workspace with Hive's own tools, not the projects' MCP servers.
    if (assistant) for (const k of Object.keys(mcpServers)) if (k !== 'hive') delete mcpServers[k]

    const l = agentLaunchSettings(forAgent, pc, s)
    const extraArgs = l.extraArgs.flatMap((a) => splitArgs(a))
    const chime = pc.chime === 'inherit' ? s.notifications.chimeEnabled : pc.chime === 'on'
    return { provider: l.provider, skills, skillHashes, skillProblems, mcpServers, model: l.model, effort: l.effort, permissionMode: l.permissionMode, extraArgs, use200kContext: l.use200kContext, chime }
  }

  signature(e: EffectiveSettings): string {
    // The permission mode can be switched live (setPermissionMode), so it doesn't ask for a restart.
    const { chime: _c, skills: _s, permissionMode: _p, ...rest } = e
    return hashText(JSON.stringify(rest))
  }

  /**
   * Every agent of a project with its running session, for ProjectInfo. `scope`: the refresh it is for (#1002), whose
   * projects' running agents share one read of the workspace's skills and servers; without, this call's agents do.
   */
  async liveInfo(projectPath: string, cfg: ProjectConfig, scope?: object): Promise<{ live: LiveSessionState | null; restartNeeded: boolean; agents: AgentInfo[] }> {
    const reads = scope ? launchReadsOf(scope) : new LaunchReads()
    const agents: AgentInfo[] = []
    const records = (await workspace.sessionsFile(projectPath)).sessions
    this.checkSubsOnce(projectPath, records)
    const openIds = new Set(this.projectStates(projectPath).map((s) => s.sessionId).filter(Boolean))
    const ids = new Set(projectAgents(cfg).map((a) => a.id))
    for (const a of projectAgents(cfg)) {
      const l = this.live.get(liveId(projectPath, a.id))
      let restartNeeded = false
      if (l && !l.state.settingUp) {
        try {
          const eff = await this.effective(projectPath, pinProvider(a, l.state.provider), reads, cfg)
          restartNeeded = this.signature(eff) !== l.state.launchSignature
          this.noticeModeSetting(l, eff.permissionMode)
        } catch {
          // Settings can't be read right now; don't nag.
        }
      }
      const provider = agentLaunchSettings(a, cfg, config.settings).provider
      // The Assistant's sessions ran in the workspace folder, not its home.
      const folder = workspace.isAssistantHome(projectPath) ? (workspaceOf(projectPath).path ?? projectPath) : projectPath
      const r = l ? null : resumeRecord(folder, a, records.filter((x) => recordProvider(x) === provider), openIds, ids)
      agents.push({ ...a, live: l?.state ?? null, restartNeeded, resume: r && { id: r.id, name: r.name, lastActiveAt: r.lastActiveAt, createdAt: r.createdAt, titleAtRename: r.titleAtRename } })
    }
    const primary = agents.find((a) => a.live)
    return { live: primary?.live ?? null, restartNeeded: primary?.restartNeeded ?? false, agents }
  }

  private backupPath(projectPath: string, sessionId: string, archived = false): string {
    return join(projectPath, HIVE_DIR, archived ? 'archive' : 'sessions', `${assertSessionId(sessionId)}.jsonl`)
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

  /** Removes usage-cache.json, which the usage history replaced (#1106), if a Hive from before it left one. */
  async retireUsageCacheFile(): Promise<void> {
    if (!existsSync(usageCacheFile())) return
    await removePath(usageCacheFile())
    log.info('usage-cache.json removed: the usage history replaced it')
  }

  /**
   * A result with costs from the current prices: the provider's report, else (or on top) Hive's estimate, and each day's
   * share. Without its timeline (usageTimeline has it): it stays in the cache, never in the usage passed on.
   */
  private priced(raw: SessionUsage): SessionUsage {
    const { timeline: _timeline, ...usage } = raw
    return priceUsage(usage, config.settings)
  }

  /**
   * Where a session's transcript is: the provider knows (by folder, or by the path it reported), and a
   * worktree agent's sessions ran in its worktree. The session's own record comes first.
   */
  async providerTranscript(projectPath: string, sessionId: string, ctx?: ListContext): Promise<{ path: string; provider: ProviderId } | null> {
    const records = ctx?.records ?? (await workspace.sessionsFile(projectPath)).sessions
    const rec = records.find((s) => s.id === sessionId)
    const live = this.projectStates(projectPath).find((s) => s.sessionId === sessionId)
    const ids = rec ? [recordProvider(rec)] : live ? [live.provider] : allProviders().map((p) => p.id)
    const cfg = ctx?.cfg ?? (await workspace.projectConfig(projectPath))
    // Its own folder first, then every folder the host's sessions run in (sessionFolders, where list() finds them: a
    // sub-session started in a removed agent's worktree, or the Assistant's workspace folder).
    const folders = [rec?.cwd, ...this.sessionFolders(projectPath, records, cfg)].filter((f): f is string => !!f)
    const unique = [...new Map(folders.map((f) => [resolve(f).toLowerCase(), f])).values()]
    for (const id of ids) {
      let adapter: ProviderAdapter
      try {
        adapter = providerAdapter(id)
      } catch {
        continue
      }
      for (const f of unique) {
        const t = await adapter.transcriptPath(f, sessionId, rec?.transcriptPath)
        if (t) return { path: t, provider: id }
      }
    }
    return null
  }

  async start(projectPath: string, opts: { resumeId?: string; name?: string; agentId?: string; skipSetup?: boolean; permissionMode?: PermissionMode; prompt?: string; allowed?: () => void; handedOverFrom?: string }): Promise<LiveSessionState> {
    this.assertStartsAllowed(projectPath)
    projectPath = workspace.assertSessionHost(projectPath)
    if (opts.resumeId !== undefined) assertSessionId(opts.resumeId)
    const agentId = opts.agentId || (await this.soleAgent(projectPath))
    // Again after the await, with nothing awaited before the start is reserved: a fence raised meanwhile holds.
    this.assertStartsAllowed(projectPath)
    const id = liveId(projectPath, agentId)
    // Checked and reserved before anything is awaited: a double click, or the UI and the Agent API at
    // once, must not start the agent twice (the second start would orphan the first process).
    if (this.live.has(id) || this.starting.has(id)) throw hiveError(msg({ id: 'session.start.alreadyRunning', defaultMessage: 'This agent is already running or starting. Stop it first.', description: 'Starting an agent is refused: it runs, or is starting, already.' }), undefined, { kind: 'conflict' })
    // Two terminals on one conversation would both append to its transcript.
    if (opts.resumeId && [...this.starting.values()].some((p) => p.resumeId === opts.resumeId)) throw hiveError(msg({ id: 'session.start.beingOpened', defaultMessage: 'This conversation is already being opened in another agent.', description: 'Resuming a conversation is refused: another agent is starting on it now.' }), undefined, { kind: 'conflict' })
    if (opts.resumeId && this.cleaning.has(`${projectPath.toLowerCase()}|${opts.resumeId.toLowerCase()}`)) throw hiveError(msg({ id: 'session.start.cleaning', defaultMessage: "Hive is archiving, deleting or cleaning up this session's files. Try again in a moment.", description: "Resuming a conversation is refused for a moment: Hive is moving or removing its files." }))
    const pending: PendingStart = { projectPath, resumeId: opts.resumeId, cancelled: false, done: Promise.resolve() }
    this.starting.set(id, pending)
    const run = this.startReserved(projectPath, agentId, id, opts)
    pending.done = run.catch(() => undefined)
    try {
      return await run
    } finally {
      this.starting.delete(id)
    }
  }

  /**
   * Refuses a start while Hive quits, while the project's workspace is closing or switching, or while a fence holds the
   * project (it is being removed, or a template is replacing its agents), while its workspace's move is being repaired,
   * or while its workspace's upgrade to 1.0 waits.
   */
  private assertStartsAllowed(projectPath: string): void {
    if (this.shuttingDown || workspaceFor(projectPath)?.closing) throw hiveError(msg({ id: 'session.start.closing', defaultMessage: "Hive is stopping this workspace's agents, so none can start now.", description: 'Starting an agent is refused: Hive is quitting, or its workspace is closing.' }))
    // Its workspace's upgrade to 1.0 waits (#1207): hive.db takes no writes, so the session couldn't be recorded.
    const ws = workspaceFor(projectPath)?.path
    if (ws) assertUpgraded(ws)
    if (workspaceFor(projectPath)?.repairingMove) throw hiveError(msg({ id: 'session.start.repairing', defaultMessage: 'Hive is repairing this moved workspace: start the agent when Repair has finished.', description: "Starting an agent is refused while Repair… fixes a moved workspace's paths." }))
    const why = this.fenced.get(resolve(projectPath).toLowerCase())?.at(-1)
    if (why) throw hiveError(msg({ id: 'session.start.fenced', defaultMessage: "{why}, so its agents can't start now.", description: "Starting an agent is refused while something changes its project. {why} says what, as a sentence without its full stop (\"This project is being removed\")." }), { why })
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

  /** Throws if the start was cancelled while it awaited something (the agent stopped, its workspace closed). */
  private assertStarting(id: string): void {
    if (this.starting.get(id)?.cancelled) throw hiveError(M.stoppedBeforeStart)
  }

  private async startReserved(projectPath: string, agentId: string, id: string, opts: { resumeId?: string; name?: string; skipSetup?: boolean; permissionMode?: PermissionMode; prompt?: string; allowed?: () => void; handedOverFrom?: string }): Promise<LiveSessionState> {
    const { agent, cfg, count } = await this.agentDef(projectPath, agentId)
    this.assertStarting(id)
    if (this.live.has(id))
      throw count > 1
        ? hiveError(msg({ id: 'session.start.agentRunning', defaultMessage: '{agent} is already running. Stop it first.', description: "Starting an agent is refused: it runs already. {agent} is the agent's name." }), { agent: agent.name }, { kind: 'conflict' })
        : hiveError(msg({ id: 'session.start.projectRunning', defaultMessage: 'A session is already running for this project. Stop it first.', description: "Starting a project's only agent is refused: it runs already." }), undefined, { kind: 'conflict' })
    const holder = opts.resumeId ? this.projectStates(projectPath).find((s) => s.sessionId === opts.resumeId) : undefined
    if (holder) throw hiveError(msg({ id: 'session.start.openIn', defaultMessage: 'This conversation is already open in {agent}. An agent can only resume a session no other agent is running.', description: "Resuming a conversation is refused: another agent is running it. {agent} is that agent's name." }), { agent: holder.agentName ?? msg({ id: 'session.start.anotherAgent', defaultMessage: 'another agent', description: "Stands for an agent whose name isn't known, in the middle of a sentence (\"This conversation is already open in another agent.\")." }) }, { kind: 'conflict' })
    const assistant = workspace.isAssistantHome(projectPath)
    const existing = opts.resumeId ? (await workspace.sessionsFile(projectPath)).sessions.find((s) => s.id === opts.resumeId) : undefined
    this.assertStarting(id)
    // A resume runs the provider its conversation ran in (#506), whatever the agent's provider is now: neither a default
    // nor a change of the agent's own re-points one. A new conversation following Automatic waits until Hive knows what
    // is installed.
    const recorded = opts.resumeId ? await this.resumeProvider(projectPath, opts.resumeId, existing) : null
    this.assertStarting(id)
    if (!recorded && !agent.provider && defaultProviderPending(cfg, config.settings)) await providerService.settle()
    this.assertStarting(id)
    const providerId = recorded ?? agentLaunchSettings(agent, cfg, config.settings).provider
    // At start, Hive may still be looking for that CLI.
    await providerService.settle(providerId)
    // The PATH a new process gets now, with what was installed since Hive started (#821).
    await refreshPathBeforeStart()
    this.assertStarting(id)
    const adapter = providerAdapter(providerId)
    const name = adapter.descriptor.name
    const resuming = opts.resumeId ? 'yes' : 'no'
    if (!isProviderEnabled(config.settings, providerId)) throw hiveError(msg({ id: 'session.start.providerOff', defaultMessage: '{provider} is turned off. {resuming, select, yes {Turn it on in Settings → Providers to resume this conversation.} other {Turn it on in Settings → Providers to run {agent}.}}', description: "Starting an agent is refused: its coding agent is turned off in Settings → Providers. {provider} is the coding agent's name (Claude Code), {agent} the agent's; {resuming} says whether it resumes a conversation." }), { provider: name, resuming, agent: agent.name }, { kind: 'conflict' })
    const info = providerService.info(providerId)
    if (!info.found || !info.path) throw hiveError(msg({ id: 'session.start.providerMissing', defaultMessage: '{resuming, select, yes {{provider} is required to resume this conversation. Install it from Help → Agent Setup.} other {{provider} is required to run {agent}. Install it from Help → Agent Setup.}}', description: "Starting an agent is refused: its coding agent's CLI isn't installed. {provider} is the coding agent's name (Claude Code), {agent} the agent's; {resuming} says whether it resumes a conversation. Help → Agent Setup is a menu command." }), { provider: name, resuming, agent: agent.name })
    await workspace.ensureProject(projectPath)
    // The Assistant works in the workspace folder, where it can read every project.
    const cwd = assistant ? workspaceOf(projectPath).path! : (agent.worktree?.path ?? projectPath)
    if (!existsSync(cwd)) throw hiveError(msg({ id: 'session.start.worktreeMissing', defaultMessage: "{agent}'s worktree folder is missing: {folder}. Start {agent} from its pane to recreate the worktree on its branch (Repair… if the workspace moved), or remove the agent.", description: "Starting an agent is refused: its git worktree's folder is gone. {agent} is the agent's name, {folder} the folder's path. Repair… is a command." }), { agent: agent.name, folder: cwd })

    if (existing?.archived) throw hiveError(msg({ id: 'session.start.archived', defaultMessage: 'This session is archived. Unarchive it before resuming.', description: 'Resuming an archived session is refused (Sessions tab: Unarchive).' }), undefined, { kind: 'conflict' })
    // A sub-session (a Codex guardian review, say) is not a conversation: never resumed (#239).
    const sub = opts.resumeId ? (existing ? await this.recordSub(projectPath, existing) : (await adapter.listSessions(cwd).catch(() => [])).find((e) => e.id === opts.resumeId)?.sub) : undefined
    if (sub) throw hiveError(msg({ id: 'session.start.subSession', defaultMessage: "That session is a {kind} {provider} ran for another session, not a conversation: it can't be resumed.", description: "Resuming a session is refused: the coding agent ran it for another session (a guardian review). {kind} is the coding agent's name for it, as it came; {provider} the coding agent's name (Codex)." }), { kind: sub.kind, provider: name }, { kind: 'conflict' })
    this.assertStarting(id)
    // By real paths (#455): the worktree's stored path may have changed form (an 8.3 short name, a junction) since.
    if (opts.resumeId && existing && !samePlace(existing.cwd ?? projectPath, cwd)) {
      throw hiveError(msg({ id: 'session.start.otherFolder', defaultMessage: 'This session ran in {folder}. Resume it with the agent that works in that folder.', description: "Resuming a session is refused: it ran in another folder (another agent's worktree). {folder} is that folder's path." }), { folder: existing.cwd ?? projectPath }, { kind: 'conflict' })
    }
    // Providers that choose their own session id report it once started (see the start hook).
    const sessionId = opts.resumeId ?? (adapter.descriptor.capabilities.fixedSessionId ? randomUUID() : '')

    const mode = assistant ? (await this.assistantInstructions(projectPath, agent).catch(() => null))?.mode : undefined
    // A /rename in the CLI since the session was last named in Hive is the newer name: Hive takes it, and so passes
    // it back with --name rather than its own.
    let adopted: string | null = null
    if (opts.resumeId && existing && (!opts.name?.trim() || opts.name.trim() === existing.name)) {
      const usage = await this.usage(projectPath, opts.resumeId).catch(() => null)
      adopted = cliRename({ ...existing, usage }, assistant ? ASSISTANT_NAME : basename(projectPath))
      if (adopted) {
        await workspace.upsertSession(projectPath, { id: existing.id, name: adopted, titleAtRename: adopted })
        log.info(`Session ${existing.id} takes the name ${userText(adopted)} it was given in the CLI`)
      }
    }
    const sessionName = adopted || opts.name?.trim() || existing?.name || (assistant ? `${ASSISTANT_NAME}${mode ? ` · ${mode}` : ''} · ${formatDateTime(new Date())}` : autoName(projectPath, agent, count))
    const key = this.key(projectPath, agentId)
    const runId = randomBytes(12).toString('hex')
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
      launchSignature: '',
      unseen: false
    }
    this.live.set(id, { state, adapter, transcriptMtime: '', defaultModel: false, modeTail: '', recognition: new ScreenRecognition(adapter), launchMode: null, configuredMode: null, modeOverride: opts.permissionMode, name: sessionName, transcriptPath: existing?.transcriptPath, initialPrompt: opts.prompt?.trim() || undefined, ...(opts.prompt?.trim() ? { launchTask: true as const } : {}), ...(opts.handedOverFrom ? { handedOverFrom: opts.handedOverFrom } : {}), startAllowed: opts.allowed, resumed: !!opts.resumeId })
    this.runs.set(runId, id)

    const setup = cfg.worktreeSetup.trim()
    if (agent.worktree && agent.needsSetup && setup && !opts.skipSetup) {
      // The worktree's setup command runs in the agent's terminal first, then the agent starts there.
      state.settingUp = true
      setStatus(state, withValues(msg({ id: 'session.status.settingUp', defaultMessage: 'Setting up the worktree: {command}', description: "An agent's status while the project's worktree setup command runs in its terminal. {command} is that command, as written." }), { command: setup }))
      const sh = shellCommand(setup)
      try {
        const tracked = await this.trackingReady()
        // The same last check as before an agent's own launch.
        if (this.starting.get(id)?.cancelled || this.shuttingDown || workspaceFor(projectPath)?.closing) throw hiveError(M.stoppedBeforeStart)
        opts.allowed?.()
        spawnPty(key, {
          file: sh.file,
          args: sh.args,
          cwd,
          env: childEnv(),
          quietExit: true,
          // What the setup command starts is the launch's too (an `npm install` left running).
          ...(tracked ? { track: (pid: number, cancelled: AbortSignal) => trackLaunch({ runId, projectPath, agentId, agentName: agent.name }, pid, cancelled).then((r) => this.launchWord(r)) } : {}),
          onExit: (code) => void this.afterSetup(projectPath, agentId, code, { sessionId, name: sessionName, resume: !!opts.resumeId })
        })
      } catch (e) {
        this.forget(id)
        throw e
      }
      this.emitState(state)
      workspaceOf(projectPath).scheduleRefresh()
      return state
    }
    try {
      await this.launch(projectPath, agent, { sessionId, name: sessionName, resume: !!opts.resumeId })
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
          projectPath
        )
      workspaceOf(projectPath).scheduleRefresh()
      return
    }
    await workspace.updateAgent(projectPath, agentId, { needsSetup: false }).catch(() => undefined)
    l.state.settingUp = false
    setStatus(l.state, null)
    try {
      await this.launch(projectPath, { ...agent, needsSetup: false }, launch)
    } catch (e) {
      void this.afterLaunch(l.state.runId, this.label(l.state))
      this.forget(id)
      emit({ type: 'session-status', state: { ...l.state, status: 'stopped', runtime: { ...l.state.runtime!, lifecycle: 'stopped' } } })
      toast('error', tr(msg({ id: 'session.start.couldNot', defaultMessage: 'Could not start {agent}', description: "A notice's title: an agent failed to start after its worktree setup. {agent} is the agent's name; the error follows." }), { agent: agent.name }), shownError(e), undefined, projectPath)
    }
  }

  /** Starts the agent's CLI for an agent whose live entry already exists. */
  private async launch(projectPath: string, agent: AgentDef, opts: { sessionId: string; name: string; resume: boolean }): Promise<void> {
    const id = liveId(projectPath, agent.id)
    const l = this.live.get(id)!
    const { state, adapter } = l
    const cwd = state.cwd
    // Performance metrics for this launch go to the workspace it started in (none, if that closes meanwhile).
    const metrics = metricsHandle(workspaceOf(projectPath))
    const { sessionId } = opts
    const info = providerService.info(adapter.id)
    if (!info.path) throw hiveError(msg({ id: 'session.start.cliRequired', defaultMessage: '{provider} is required to run sessions.', description: "Starting an agent failed: its coding agent's CLI wasn't found. {provider} is the coding agent's name." }), { provider: adapter.descriptor.name }, { kind: 'conflict' })

    let resume = opts.resume
    if (resume) {
      const recorded = l.transcriptPath
      if (!(await adapter.transcriptPath(cwd, sessionId, recorded))) {
        // The provider has deleted it: put Hive's backup back where the provider looks for it (a compressed one
        // decompressed, #1110: the only time it is).
        const backup = this.backupCopy(projectPath, sessionId)
        const dest = adapter.restorePath(cwd, sessionId, recorded)
        if (dest && backup) {
          await mkdir(dirname(dest), { recursive: true })
          if (isGz(backup)) await decompressTo(backup, dest)
          else await copyFile(backup, dest)
          log.info(`Restored transcript for ${sessionId} from Hive backup`)
        }
      }
      // A session restarted before anything was typed has no transcript: start it fresh under the same id
      // where the provider allows choosing it, else as a new session.
      resume = !!(await adapter.transcriptPath(cwd, sessionId, recorded))
      if (!resume) {
        log.info(`No transcript for ${sessionId}; starting it fresh instead of resuming`)
        if (!adapter.descriptor.capabilities.fixedSessionId) state.sessionId = ''
      }
    }

    const eff = await this.effective(projectPath, pinProvider(agent, state.provider))
    // Extra arguments saved before Settings refused a bare "--" (#523) stop the launch before anything changes.
    const argsProblem = capturedText((t) => extraArgsProblem(eff.extraArgs, t))
    if (argsProblem)
      throw workspace.isAssistantHome(projectPath)
        ? hiveError(msg({ id: 'session.start.argsAssistant', defaultMessage: '{problem} Fix it in Settings → Assistant.', description: "Starting the Assistant is refused: its extra arguments are wrong. {problem} says why, as a sentence." }), { problem: argsProblem })
        : hiveError(msg({ id: 'session.start.args', defaultMessage: '{problem} Fix it in Project Settings or Settings → {provider}.', description: "Starting an agent is refused: its extra arguments are wrong. {problem} says why, as a sentence; {provider} is the coding agent's name (its Settings section)." }), { problem: argsProblem, provider: adapter.descriptor.name })
    l.configuredMode = eff.permissionMode
    let mode = eff.permissionMode
    if (l.modeOverride && modeAllowed(adapter.id, l.modeOverride, config.settings)) mode = l.modeOverride
    l.launchMode = mode
    state.permissionMode = mode ?? undefined
    // Given Hive's tools, it takes no line of Hive's until they have connected (#865).
    l.hiveTools = eff.mcpServers.hive ? 'connecting' : undefined
    // Its own Agent API token for this launch, which confines its board calls to its project (the Assistant has its own).
    if (!workspace.isAssistantHome(projectPath)) await newAgentToken({ workspace: workspaceOf(projectPath).path!, projectPath, agentId: agent.id }, state.runId)
    const assistantText = workspace.isAssistantHome(projectPath) ? await this.assistantInstructions(projectPath, agent).catch(() => null) : null
    // A new conversation starts in its mode; a resumed one is told it if it was last given another (below).
    l.mode = !resume ? assistantText?.modeId || undefined : undefined
    // This launch's own hook token (#345): in its environment for HTTP hooks, in a file outside the project for hook commands.
    const hookAuth = await newHookToken(state.runId)
    const ctx = {
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
      mcpServers: eff.mcpServers,
      model: eff.model,
      effort: eff.effort,
      permissionMode: mode,
      extraArgs: eff.extraArgs,
      use200kContext: eff.use200kContext,
      hookUrl: `${this.hookUrl}?run=${state.runId}`,
      hookAuthFile: hookAuth.file,
      privateDir: hookAuth.dir,
      guidance: await this.hiveGuidance(projectPath).catch(() => ''),
      instructions: assistantText?.text,
      trustedHiveTools: workspace.isAssistantHome(projectPath) ? assistantTools(config.settings.assistant?.control, config.settings.assistant?.changeSettings === true, journalSettingsOf(workspaceOf(projectPath)).enabled) : undefined,
      initialPrompt: l.initialPrompt,
      allowBackgroundSessions: providerSettings(config.settings, adapter.id).allowBackgroundSessions,
      env: withBinOnPath(childEnv({
        HIVE_HOOK_TOKEN: hookAuth.token,
        HIVE_PROJECT: basename(projectPath),
        HIVE_PROJECT_PATH: projectPath,
        HIVE_WORKSPACE: workspaceOf(projectPath).path!,
        HIVE_RUN_ID: state.runId,
        ...(state.sessionId ? { HIVE_SESSION_ID: state.sessionId } : {}),
        HIVE_AGENT: agent.name,
        HIVE_PROVIDER: adapter.id,
        // Not for the Assistant: it reaches the API through its hive tools, with its own token.
        ...(workspace.isAssistantHome(projectPath) ? {} : this.apiEnv(projectPath, agent.id))
      }), this.binDir)
    }
    const delivered = await adapter.prepareLaunch(ctx)
    // What the session got, measured on the copies its CLI reads (not their sources: a kept old copy is what it reads).
    const deliveredSizes = await deliveredSkillSizes(adapter, ctx, delivered).catch(() => ({ catalog: 0, bytes: 0, unmeasured: Object.values(delivered).filter((d) => d.revision).length }))
    if (workspace.isAssistantHome(projectPath)) await this.onAssistantLaunch(projectPath)
    // Through its gate when its processes can be tracked (#507), else directly, untracked, as said once.
    const tracked = await this.trackingReady()
    // Not while its folder is being changed under it (#646: a Git switch or pull there): it starts once that is done.
    await folderSteady(cwd)
    // Checked after the last await, just before spawning: stopped, its workspace closed or switched, or the
    // provider turned off while this launch was being prepared, it must not start a process.
    if (l.stopRequested || this.live.get(id) !== l || this.starting.get(id)?.cancelled || !workspaceFor(projectPath) || this.shuttingDown || workspaceFor(projectPath)?.closing) throw hiveError(M.stoppedBeforeStart)
    if (!isProviderEnabled(config.settings, adapter.id)) throw hiveError(msg({ id: 'session.start.turnedOff', defaultMessage: '{provider} was turned off while {agent} was starting.', description: "Starting an agent failed: its coding agent was turned off in Settings meanwhile. {provider} is the coding agent's name, {agent} the agent's." }), { provider: adapter.descriptor.name, agent: agent.name })
    l.startAllowed?.()
    const cmd = adapter.buildCommand(info.path, ctx)
    // What the user should know about this launch: once per agent, folder and notice while Hive runs.
    const notice = adapter.launchNotice?.(ctx)
    const noticeKey = notice ? `${id}\n${ctx.cwd}\n${notice.title}` : ''
    if (notice && !this.launchNotices.has(noticeKey)) {
      this.launchNotices.add(noticeKey)
      toast('warning', `${this.label(state)}: ${notice.title}`, notice.message, undefined, projectPath)
    }
    this.checkFolder(projectPath, ctx.cwd)
    // Where it compacts by itself (#242): for the model it runs as, the choice's (an alias resolved) or the CLI's default.
    const chosenModel = eff.model || info.defaultModel || ''
    // Once the session reports the model it runs, that model alone: another model's window isn't its own.
    const modelsFor = (running?: string): string[] => (running ? [running] : [chosenModel && resolvedModel(info, chosenModel), chosenModel].filter((m): m is string => !!m))
    l.autoCompactFor = adapter.autoCompact ? (running) => adapter.autoCompact!(ctx, cmd, modelsFor(running)) : undefined
    state.autoCompact = l.autoCompactFor?.()
    l.titleAttention = adapter.titleAttention?.(info.version) ?? undefined
    l.turnScreen = adapter.turnScreen?.(info.version) ?? undefined
    l.ledger = newLedger()
    // What it was given: Hive's guidance revision and each skill as delivered (the Agent API's project status shows
    // them). A skill not delivered as asked (kept old copy, failed copy) leaves it needing a restart.
    // i18n-ignore: what the Agent API's project status says of a skill (agent-facing text stays English)
    const notGiven = Object.fromEntries(Object.entries(eff.skillProblems).map(([name, why]) => [name, { revision: null, problem: `nobody gets it: ${why}`, lasting: true as const }]))
    const record = launchRecord(eff.skillHashes, { ...delivered, ...notGiven })
    state.launchSignature = this.signature({ ...eff, skillHashes: record.settled })
    state.launched = { guidance: GUIDANCE_REVISION, skills: record.skills, ...(record.problems ? { problems: record.problems } : {}) }
    // Performance metrics: what Hive gave this session, exact sizes. The session contract once (whichever way the
    // provider gets it); the skills that reached it, measured on their copies; the ones asked for that didn't.
    const given = Object.keys(record.skills)
    const parts = launchParts(ctx.guidance, workspace.isAssistantHome(projectPath) ? 'assistant' : 'agent', basename(projectPath), assistantText)
    recordLaunch(metrics, workspace.isAssistantHome(projectPath) ? null : basename(projectPath), {
      provider: adapter.id,
      role: workspace.isAssistantHome(projectPath) ? 'assistant' : 'agent',
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
    // menu, whose entries Hive picks by what they say (#396).
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
      args: cmd.args,
      cwd,
      env: cmd.env ?? ctx.env,
      // After a worktree's setup command, its output stays at the top of the terminal.
      continueBuffer: true,
      onData: (data) => {
        if (l.switchTail !== undefined) l.switchTail = (l.switchTail + data.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ' ').replace(/\x1b\][^\x07]*\x07/g, ' ')).replace(/\s+/g, ' ').slice(-2000)
        // The CLI refusing or failing a compaction Hive asked for sends no hook ("Not enough messages to compact.").
        this.live.get(id)?.compacting?.terminal(data)
        screen?.write(data, () => {
          this.readFooterMode(l, screen)
          this.screenDrawn(id, l)
        })
        this.watchTitle(id, data)
        this.watchReadyOutput(id, data)
        this.recognisePrompt(l, data)
      },
      onResize: (cols, rows) => screen?.resize(cols, rows),
      // Everything it starts is tracked, to offer to end what it leaves running (#507): it starts once it is.
      ...(tracked
        ? {
            track: (pid: number, cancelled: AbortSignal) => {
              state.pid = pid
              return trackLaunch({ runId: state.runId, projectPath, agentId: agent.id, agentName: agent.name }, pid, cancelled).then((r) => this.launchWord(r))
            }
          }
        : {}),
      onExit: (code, output) => {
        screen?.dispose()
        void this.onExit(projectPath, agent.id, state.runId, code, output)
      }
    })
    l.initialPrompt = undefined
    l.startAllowed = undefined
    // After each look at the transcript, the silence check: what the CLI recorded (a turn's end) comes first (#648).
    l.backupTimer = setInterval(() => {
      void this.backup(projectPath, agent.id)
        .catch((e) => log.warn('transcript look failed', e))
        .then(() => this.checkSilence(projectPath, agent.id))
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
  private async recordSession(projectPath: string, agent: Pick<AgentDef, 'id' | 'name' | 'worktree'>, l: LiveSession): Promise<void> {
    const { state } = l
    const sessionId = state.sessionId
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
      ...(state.titleAtRename !== undefined ? { titleAtRename: state.titleAtRename } : {}),
      lastActiveAt: new Date().toISOString(),
      // The agent running it now; a session can move between agents that share a folder. Its name too, for once it's gone.
      agentId: agent.id,
      agentName: agent.name,
      // The Assistant's mode its conversation was last given (a resumed one's is unknown until it is told: assistantMode.ts).
      ...(l.mode ? { mode: l.mode } : {}),
      // Providers that choose their own ids file transcripts by date, not folder: remember where.
      ...(l.transcriptPath && !l.adapter.descriptor.capabilities.fixedSessionId ? { transcriptPath: l.transcriptPath } : {}),
      // Where it ran, when not the project folder (a worktree, or the Assistant's workspace folder).
      ...(state.cwd.toLowerCase() !== projectPath.toLowerCase() ? { cwd: state.cwd } : {}),
      ...(agent.worktree ? { branch: agent.worktree.branch } : {}),
      ...(l.handedOverFrom ? { handedOverFrom: l.handedOverFrom } : {})
    }, { createdAt: state.sessionCreatedAt })
    // The conversation it was meant for has it: one the CLI moves to later (/clear, /new) wasn't handed over.
    l.handedOverFrom = undefined
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

  /** Stops one agent's session, or every agent of the project when agentId is omitted. */
  stop(projectPath: string, agentId?: string): void {
    const agents = agentId ? [agentId] : this.projectStates(projectPath).map((s) => s.agentId)
    for (const a of agents) {
      const l = this.live.get(liveId(projectPath, a))
      if (l) {
        l.stopRequested = true
        this.endProcess(l)
      } else killPty(this.key(projectPath, a))
    }
    // Starts still being prepared (no process yet) give up at their next check.
    for (const [k, p] of this.starting) if (p.projectPath.toLowerCase() === projectPath.toLowerCase() && (!agentId || k === liveId(projectPath, agentId))) p.cancelled = true
  }

  /**
   * Ends a session's CLI: as a person ends it first, where the provider says how (exitKeys), so it writes what it
   * owes as it exits (Copilot's token totals, #465), and killed if it is still running after a moment. Killed at once
   * while its worktree setup runs, or when it is stopped again while ending. Keys and the kill reach only this
   * session's terminal: a restart's new one is left alone.
   */
  private endProcess(l: LiveSession): void {
    const key = this.key(l.state.projectPath, l.state.agentId)
    const exit = l.adapter.exitKeys
    if (!exit || l.state.settingUp || l.ending) return killPty(key)
    l.ending = true
    const id = liveId(l.state.projectPath, l.state.agentId)
    const same = (): boolean => this.live.get(id) === l
    exit.keys.forEach((k, i) => setTimeout(() => same() && writePty(key, k), i * exit.gapMs))
    setTimeout(() => same() && killPty(key), exit.graceMs)
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
  async stopWhereAndWait(which: (s: { projectPath: string }) => boolean, timeoutMs = 3000): Promise<void> {
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
      if (!l || l.state.settingUp) throw hiveError(M.noSession, undefined, { kind: 'conflict' })
      if (l.compacting) throw hiveError(msg({ id: 'session.compact.already', defaultMessage: 'This session is already compacting.', description: 'Compact is refused: the conversation is being compacted already.' }))
      if (this.delivering.has(key)) throw hiveError(M.typingBusy, undefined, { kind: 'conflict' })
      // Watching its cards (its turn has ended) may compact: the watch stays.
      if (l.state.status !== 'ready' && l.state.status !== 'finished' && l.state.status !== 'watching') {
        throw l.state.status === 'waiting'
          ? hiveError(msg({ id: 'session.compact.waiting', defaultMessage: 'The agent is waiting for your answer. Compact after it has finished.', description: 'Compact is refused: the agent waits for the user.' }))
          : hiveError(msg({ id: 'session.compact.busy', defaultMessage: 'The agent is busy. Compact once it has finished.', description: 'Compact is refused: the agent is working.' }), undefined, { kind: 'conflict' })
      }
      return l
    }
    const l = check(this.live.get(id))
    const src = await this.liveTranscript(l)
    const before = src ? ((await this.usageFor(l.state.projectPath, src, l.state.sessionId, l.state.provider))?.compactions.length ?? 0) : 0
    // Again: a second Compact or a prompt may have come meanwhile (one at a time, only while idle).
    if (this.live.get(id) !== l) throw hiveError(M.noSession, undefined, { kind: 'conflict' })
    check(l)
    // Reserved while Hive types the command (a long focus takes a while), so nothing else is typed or compacted
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
    const pause = async (ms: number): Promise<void> => {
      await new Promise((r) => setTimeout(r, ms))
      if (!same()) throw hiveError(msg({ id: 'session.compact.stopped', defaultMessage: 'The agent stopped before Compact was sent.', description: 'Compact failed: the agent stopped or restarted while Hive typed the command.' }))
    }
    try {
      writePty(key, '\x15')
      await pause(150)
      const text = l.adapter.descriptor.capabilities.compactFocus ? (focus ?? '').replace(/\s+/g, ' ').trim() : ''
      // Written in one go, a long line counts as a paste, and pasted input is sent as a message even when
      // it starts with "/compact". So type the command on its own, then the focus in small pieces.
      writePty(key, '/compact')
      await pause(150)
      if (text) await typeInto(key, ` ${text}`, same)
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

  /** A compaction Hive watches is over with no hook saying so (Compaction's `over`): an agent still showing it is idle again. */
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
   * Watched as Hive's own from now (begun): over at PostCompact or a prompt, a compaction recorded in the transcript
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
   * Sets facts of an agent's runtime where Hive learns them (LiveSessionState.runtime, #648), never from its status word.
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

  /** Whether Hive holds an agent's input (RuntimeFacts.composer): typing into it, or a line it typed not taken yet. */
  private composerOf(l: LiveSession, key = this.key(l.state.projectPath, l.state.agentId)): RuntimeFacts['composer'] {
    return this.delivering.has(key) || this.lineBlocked(l) ? 'held' : 'free'
  }

  /**
   * The agent's input may be held or freed now (Hive typing, confirming, a line taken or given up): sent when it changed.
   * Only a report: it never stops what Hive is typing (`key`: the terminal's, when the caller has it).
   */
  private noteComposer(l: LiveSession | undefined, key?: string): void {
    if (!l) return
    try {
      if (this.fact(l.state, { composer: this.composerOf(l, key) })) this.emitState(l.state)
    } catch (e) {
      log.warn('could not report whether Hive holds an input', e)
    }
  }

  /** Reads the mode from the CLI's footer on its screen as it redraws, so a mode change in the terminal shows in Hive at once. */
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
      l.state.permissionMode = l.state.modeObserved = mode
      this.emitState(l.state)
    }
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
    if (!l || l.state.settingUp) throw hiveError(M.noSession, undefined, { kind: 'conflict' })
    const st = l.state
    const p = st.provider
    const name = l.adapter.descriptor.name
    if (st.permissionMode === mode) return { ok: true }
    if (!modeAllowed(p, mode, config.settings)) throw hiveError(msg({ id: 'session.mode.off', defaultMessage: '{mode} is turned off in Settings → {provider}.', description: "Switching an agent's permission mode is refused: that mode is turned off. {mode} is the mode's name; {provider} the coding agent's (its Settings section)." }), { mode: permissionLabel(p, mode, tr), provider: name }, { kind: 'conflict' })
    const how = l.adapter.descriptor.capabilities.liveModeSwitch
    if (how === 'none' || !l.adapter.canSwitchLive(mode, st.permissionMode, l.launchMode)) {
      return { ok: false, restart: true, message: tr(msg({ id: 'session.mode.restart', defaultMessage: "{mode} can't be switched to inside a running session. Restart the session in that mode; the conversation continues.", description: "Switching an agent's permission mode needs a restart. {mode} is the mode's name." }), { mode: permissionLabel(p, mode, tr) }) }
    }
    if (st.status === 'waiting') throw hiveError(msg({ id: 'session.mode.asking', defaultMessage: 'The agent is asking you something. Answer it first, then switch the mode.', description: "Switching an agent's permission mode is refused: it waits for the user's answer." }))
    if (st.status === 'starting') throw hiveError(msg({ id: 'session.mode.starting', defaultMessage: 'The session is still starting. Try again in a moment.', description: "Switching an agent's permission mode is refused for a moment: it is starting." }))
    const key = this.key(projectPath, agentId)
    // The composer is reserved while the keys go in (#649), as for a line Hive types: none is typed into the menu, nor
    // the keys into a line.
    if (this.delivering.has(key)) throw hiveError(msg({ id: 'session.mode.typing', defaultMessage: 'Hive is typing a line into this agent. Switch the mode in a moment.', description: "Switching an agent's permission mode is refused for a moment: Hive is typing into its terminal." }))
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
      if (st.status === 'working') throw hiveError(msg({ id: 'session.mode.working', defaultMessage: '{provider} is working. Switch the mode once it has finished.', description: "Switching an agent's permission mode is refused while it works. {provider} is the coding agent's name." }), { provider: name })
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
              if (!same()) return stop(msg({ id: 'session.mode.why.ended', defaultMessage: 'its session ended', description: "Why Hive stopped switching an agent's permission mode (a clause: \"Hive didn't switch to Auto, as its session ended.\")." }))
              if (asking()) return stop(withValues(msg({ id: 'session.mode.why.asking', defaultMessage: '{provider} is asking you something', description: "Why Hive stopped switching an agent's permission mode (a clause). {provider} is the coding agent's name." }), { provider: name }))
              if (st.status !== 'working' && !l.adapter.busyScreen?.(l.screen?.text() ?? '')) return true
              if (Date.now() - t0 >= 30_000) return stop(withValues(msg({ id: 'session.mode.why.busy', defaultMessage: '{seconds, plural, one {{provider} stayed busy for # second} other {{provider} stayed busy for # seconds}}', description: "Why Hive stopped switching an agent's permission mode (a clause). {provider} is the coding agent's name; {seconds} how many seconds Hive waited." }), { provider: name, seconds: 30 }))
            }
          }
        })
      } catch (e) {
        if (e instanceof KeysStopped) {
          // Nothing more typed, nothing chosen: what went in already may still be in its input.
          log.warn(`${userText(this.label(st))}: ${name}: stopped switching to ${mode}: ${e.why}`)
          return notSwitched(tr(msg({ id: 'session.mode.stopped', defaultMessage: "Hive didn't switch to {mode}, as {why}. Check its terminal, or switch there.", description: "Switching an agent's permission mode stopped part-way. {mode} is the mode's name; {why} says why, as a clause." }), { mode: permissionLabel(p, mode, tr), why: stoppedWhy ? shownText(stoppedWhy) : e.why }))
        }
        if (!(e instanceof PickNotFound)) throw e
        // The menu doesn't show the mode (another CLI version): closed again, nothing chosen, nothing assumed. Escape
        // goes only into this session, and not over a question it asks meanwhile.
        if (same() && !asking()) writePty(key, '\x1b')
        log.warn(`${userText(this.label(st))}: ${name}: couldn't find ${e.what}`)
        return notSwitched(tr(msg({ id: 'session.mode.notFound', defaultMessage: "Hive couldn't find {what}, so it didn't switch to {mode}. Check its terminal, or switch there.", description: "Switching an agent's permission mode failed: the CLI's menu didn't show what Hive looked for. {what} names it, in the CLI's words; {mode} is the mode's name." }), { what: e.what, mode: permissionLabel(p, mode, tr) }))
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
      : tr(msg({ id: 'session.mode.notOffered', defaultMessage: "{provider} didn't offer {mode} with Shift+Tab (it is now in an unknown mode). Restart the session in that mode instead.", description: "Switching an agent's permission mode with Shift+Tab failed, and Hive can't tell which mode it is in. {provider} is the coding agent's name, {mode} the mode asked for." }), { provider: name, mode: permissionLabel(p, mode, tr) })
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

  /** The user typed in a terminal (Hive's own typing goes through sendPrompt, not here). */
  noteUserInput(key: string, data: string): void {
    // xterm's own replies (focus in/out, cursor reports, colour queries) aren't typing.
    const typed = typedText(data)
    if (typed) this.userInput.set(key, { at: Date.now(), enter: typed.endsWith('\r') })
    if (typed?.includes('\r')) this.userEnter.set(key, Date.now())
  }

  /**
   * A line Hive typed into an agent wasn't taken, even after Enter again (#430: its CLI wasn't reading its input). It is
   * marked in its pane, and the user told once; nothing more is typed into it until the CLI takes it or the user types
   * there. Only for this launch.
   */
  lineNotTaken(projectPath: string, agentId: string, runId: string, text: string, retried = true): void {
    const l = this.live.get(liveId(projectPath, agentId))
    if (!l || l.state.runId !== runId || l.state.untakenLine) return
    l.state.untakenLine = { since: new Date().toISOString(), text: text.replace(/\s+/g, ' ').trim().slice(0, 160) }
    this.emitState(l.state)
    const label = this.label(l.state)
    const body = retried
      ? msg({ id: 'session.notice.untakenRetried', defaultMessage: "Hive typed it and pressed Enter twice, but its CLI wasn't reading its input. Show it, click its terminal and press Enter.", description: "The notification that an agent's CLI didn't take a line Hive typed into it." })
      : msg({ id: 'session.notice.untaken', defaultMessage: "Hive typed it, but couldn't press Enter again (the agent was busy, or you were typing there). Show it, click its terminal and press Enter.", description: "The notification that an agent's CLI didn't take a line Hive typed into it." })
    this.notify(projectPath, withValues(msg({ id: 'session.notice.untakenTitle', defaultMessage: "{agent} hasn't taken a line Hive typed", description: "A notification's title: an agent's CLI didn't take a line Hive typed into it (a wake, a message). {agent} is the agent." }), { agent: label }), body, 'waiting', l.state.agentName, agentId)
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

  /** Whether an agent has a line Hive typed that its CLI hasn't taken (#430): nothing more is typed into it meanwhile. */
  lineUntaken(projectPath: string, agentId: string): boolean {
    return !!this.live.get(liveId(projectPath, agentId))?.state.untakenLine
  }

  /**
   * Whether a line Hive typed into an agent is still waiting to be taken (#430): typed in the last PENDING_MS and not
   * taken yet, or marked as not taken. Nothing more is typed into it meanwhile (it would clear that line, or be lost).
   */
  lineWaiting(projectPath: string, agentId: string): boolean {
    return this.lineBlocked(this.live.get(liveId(projectPath, agentId)))
  }
  private lineBlocked(l: LiveSession | undefined): boolean {
    if (!l) return false
    if (l.state.untakenLine || l.confirming) return true
    // The user's draft over a line of Hive's: until a prompt is submitted there.
    if (l.draftOver && (l.prompts ?? 0) <= l.draftOver.prompts) return true
    return !!l.typed && (l.prompts ?? 0) <= l.typed.prompts && Date.now() - l.typed.at < PENDING_MS
  }

  private clearUntaken(l: LiveSession, why: string): void {
    const u = l.state.untakenLine
    if (!u) return
    log.info(`${userText(this.label(l.state))}: the line Hive typed is no longer waiting (${why}, ${Math.round((Date.now() - Date.parse(u.since)) / 1000)} s after it was marked)`)
    l.state.untakenLine = undefined
    this.emitState(l.state)
  }

  /** When the user last pressed Enter in each terminal (by pty key): a prompt its CLI takes soon after is theirs (#418). */
  private userEnter = new Map<string, number>()

  /**
   * The user sent an agent a prompt from its pane (#418): what its CLI took (UserPromptSubmit) soon after the user's own
   * Enter there, later than any line Hive typed. main/watches.ts tells the Assistant's watches.
   */
  userReplied: (projectPath: string, agentId: string, agentName: string, text: string) => void = () => undefined

  private noteUserReply(l: LiveSession, text: string | null | undefined): void {
    const st = l.state
    if (!text?.trim() || text.trim().startsWith('/') || workspace.isAssistantHome(st.projectPath)) return
    const enterAt = this.userEnter.get(this.key(st.projectPath, st.agentId)) ?? 0
    if (enterAt <= (l.typed?.at ?? 0) || Date.now() - enterAt > USER_REPLY_MS) return
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

  /**
   * The run `runId` of the Hive Assistant was told its mode `modeId`: its conversation records it, so a resume
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

  /** Types a message into an agent's terminal and sends it. */
  /** Agents Hive is typing a prompt into (one at a time each). */
  private delivering = new Set<string>()

  /**
   * Types a prompt into an agent and sends it, on one line (a new line would send it early in the CLI).
   * Refused while another is being typed there; stops if the agent stops or restarts meanwhile. `guard` throws if the
   * prompt mustn't go in any more (the agent got busy, the user typed there): it is checked before the input is
   * cleared, before each part is typed and before it is sent. Stopped part-way, what Hive typed is cleared again,
   * unless the user has typed since (their input stays).
   */
  async sendPrompt(projectPath: string, agentId: string, text: string, guard?: () => void, opts: { confirm?: boolean } = {}): Promise<void> {
    const key = this.key(projectPath, agentId)
    const l = this.live.get(liveId(projectPath, agentId))
    const runId = l?.state.runId
    if (this.delivering.has(key)) throw hiveError(M.typingBusy, undefined, { kind: 'conflict' })
    // A line typed before isn't taken yet (#430): typing more would clear it, or be lost behind it.
    const waiting = (): void => {
      if (this.lineBlocked(this.live.get(liveId(projectPath, agentId)))) throw hiveError(msg({ id: 'session.prompt.untaken', defaultMessage: "Its CLI hasn't taken the line Hive typed before; nothing more is typed until it does.", description: "Typing into an agent is refused: its CLI hasn't taken the line Hive typed before." }))
    }
    waiting()
    this.delivering.add(key)
    this.noteComposer(l, key)
    const same = (): boolean => !!runId && this.live.get(liveId(projectPath, agentId))?.state.runId === runId
    const check = (): void => {
      if (!same()) throw hiveError(M.stoppedBeforePrompt)
      waiting()
      guard?.()
    }
    const since = Date.now()
    let typed = false
    let sent: { at: number; prompts: number; from: number } | null = null
    try {
      check()
      writePty(key, '\x15')
      await new Promise((r) => setTimeout(r, 150))
      check()
      typed = true
      const line = text.replace(/\s+/g, ' ').trim()
      // A CLI busy for a moment reads what Hive typed in one go, Ctrl+U and Enter included: Claude Code takes such a
      // read as a paste with those keys in it as text, and then Enter again doesn't send it either (#597). A bracketed
      // paste is text however it arrives. A slash command is still typed: pasted, it is sent as a message.
      // Enter once the CLI has drawn the line (#600: a busy Codex drops an Enter it reads with the line): its end shows
      // on the screen once more than before it was typed.
      const drawn = l?.screen && l.adapter.descriptor.capabilities.enterOnceDrawn ? drawnLine(l.screen, line) : null
      if (l?.screen?.bracketedPaste() && l.adapter.descriptor.capabilities.bracketedPaste && !line.startsWith('/')) writePty(key, `\x1b[200~${line.replace(/[\x00-\x1f\x7f-\x9f]/g, '')}\x1b[201~`)
      else await typeInto(key, line, () => (check(), true))
      await new Promise((r) => setTimeout(r, 300))
      check()
      if (drawn && !drawn()) {
        // How long, at most: Settings → Advanced (a slower CLI may need longer).
        const most = advanced.number(drawnWaitId(l!.adapter.id)) * 1000
        // Typed, and not drawn yet (a busy CLI): e2e suites wait for this line (wakepaste-codex).
        log.info(`${userText(this.label(l!.state))}: the line Hive typed is in; Enter once it shows`)
        const t = Date.now()
        while (!drawn() && Date.now() - t < most) {
          await new Promise((r) => setTimeout(r, 50))
          check()
        }
        if (!drawn()) log.info(`${userText(this.label(l!.state))}: the line Hive typed wasn't drawn within ${most} ms: Enter anyway`)
      }
      const before = l?.prompts ?? 0
      writePty(key, '\r')
      // Waiting to be taken from here (#430), for whatever Hive types next: recorded once this call is done with it (its
      // own Enter again below is no line over it; nothing else types meanwhile, it holds `delivering`).
      sent = { at: Date.now(), prompts: before, from: since }
      // i18n-ignore: the developer console's event data, recorded like a log, stays English (#1104)
      devConsole.capture([sessionSourceId(projectPath, agentId)], () => ({ kind: 'input', name: 'Hive typed a line', provider: l?.state.provider, raw: { text: line }, made: { bracketedPaste: !!l?.screen?.bracketedPaste(), confirm: !!opts.confirm }, summary: `Hive typed a line (${line.length} chars) and Enter` }))
      // confirm: until the CLI reports the prompt submitted. One just resumed and still drawing its conversation can
      // drop the Enter, or take it as a new line (#334): Enter again, which an empty prompt ignores. Still not
      // reported (a CLI that doesn't report prompts), it counts as sent: typing it again could send it twice.
      const taken = (): boolean => (l?.prompts ?? 0) !== before || !same()
      for (let i = 0; opts.confirm && i < 3; i++) {
        const t = Date.now()
        while (!taken() && Date.now() - t < 3000) await new Promise((r) => setTimeout(r, 100))
        if (taken()) break
        if (i === 2) {
          log.warn(`${userText(this.label(l!.state))}: the CLI didn't report Hive's prompt submitted`)
          break
        }
        // Never an Enter that would send what the user has begun typing, or into a session that got busy.
        if (this.userTypedAt(projectPath, agentId) >= since) break
        try {
          check()
        } catch {
          break
        }
        writePty(key, '\r')
      }
    } catch (e) {
      if (typed && same() && this.userTypedAt(projectPath, agentId) < since) writePty(key, '\x15')
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
   * Hands one agent's work over to another (any provider): the source writes a handover with Hive's
   * hive_create_handover tool, then the target starts and picks it up with hive_read_latest_handover.
   * Conversations can't move between providers; a handover carries the work instead. To itself, it ends the agent's
   * conversation: only while it may (#1057, handOverCheck.ts: idle, not merging, on no running lane's card), checked as
   * it is asked and again just before the conversation ends.
   */
  async handOver(projectPath: string, fromAgentId: string, toAgentId: string, opts: { handover: boolean }): Promise<void> {
    projectPath = workspace.assertProject(projectPath)
    // To itself: the agent carries on in a new conversation (a long transcript made short again).
    const self = fromAgentId === toAgentId
    if (!this.hiveMcp(projectPath)) throw hiveError(msg({ id: 'session.handOver.noTools', defaultMessage: 'Handing over needs Hive\'s tools in sessions: turn on "Provide Hive tools to sessions" in Settings → Agent API.', description: 'Hand Over to… is refused: agents need Hive\'s tools to write and read a handover. "Provide Hive tools to sessions" is a setting in Settings → Agent API: keep its name as Hive shows it.' }))
    const { agent: to } = await this.agentDef(projectPath, toAgentId)
    const { agent: from } = await this.agentDef(projectPath, fromAgentId)
    // Ending its conversation only while it may (#1057): what the notice, the footer and the dialog offer, checked here
    // too, so a notice or dialog left open while the agent started work, joined a lane or took the merge slot can't.
    if (self && !(await this.handOverAllowed(projectPath, fromAgentId).catch(() => false))) throw hiveError(M.handOverNotNow, { agent: from.name }, { kind: 'conflict' })
    const source = this.live.get(liveId(projectPath, fromAgentId))?.state ?? null
    const fromSession = source?.sessionId || from.lastSessionId || ''
    // The handover the target reads, by name: a newer one appearing meanwhile isn't the one meant.
    let handover = ''
    // When the handover was asked for, and written (its file's time): the turn the request began writes it; another turn
    // begun since, or after it was written, is other work.
    let askedAt = NaN
    let writtenAt = NaN
    if (opts.handover) {
      if (!source) throw hiveError(msg({ id: 'session.handOver.notRunning', defaultMessage: "{agent} isn't running. Resume it to write a handover, or hand over the latest handover.", description: "Hand Over to… with a new handover is refused: the agent handing over isn't running. {agent} is its name." }), { agent: from.name })
      if (source.status !== 'ready' && source.status !== 'finished') throw hiveError(M.handOverBusy, { agent: from.name }, { kind: 'conflict' })
      // Proof, not status: the target starts only once a handover newer than this one exists, written in the
      // source's own conversation (its header's Session, which Hive writes), not by another agent meanwhile.
      // Among the newest few, since another agent may write one after the source does.
      const known = new Map((await this.recentHandovers(projectPath, 20)).map((h) => [h.relPath, h.modified]))
      const want = source.sessionId
      const isNew = (h: HandoverRef): boolean => (!known.has(h.relPath) || h.modified > known.get(h.relPath)!) && (!want || h.session === want)
      toast(
        'info',
        tr(msg({ id: 'session.handOver.writing', defaultMessage: '{agent} is writing a handover', description: "A notice's title: an agent writes a handover of its work (Hand Over to…). {agent} is its name." }), { agent: from.name }),
        self
          ? tr(msg({ id: 'session.handOver.self', defaultMessage: "It continues from it in a new conversation when it's done.", description: 'The notice that an agent writes a handover to itself (Hand Over to… the same agent).' }))
          : tr(msg({ id: 'session.handOver.other', defaultMessage: "{agent} continues from it when it's done.", description: "The notice that an agent writes a handover for another. {agent} is the other agent's name." }), { agent: to.name }),
        undefined,
        projectPath
      )
      // A handover delivery (#649), given now or not at all.
      askedAt = Date.now()
      await this.delivery().now(projectPath, {
        agentId: fromAgentId,
        agentName: from.name,
        conversation: source.sessionId || null,
        kind: 'handover',
        from: HIVE_SENDER,
        // i18n-ignore: typed to the agent (agent-facing text stays English)
        body: `Please write a handover of this work with the hive_create_handover tool, so that ${self ? 'you can continue it in a new conversation' : `another agent (${to.name}) can continue it`}: the goal, what is done, decisions made and why, the current state, open problems and the next steps. Then stop.`,
        need: 'free'
      })
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
        if (!st) throw hiveError(msg({ id: 'session.handOver.stopped', defaultMessage: '{agent} stopped before writing a handover.', description: "Hand Over to… failed: the agent handing over stopped. {agent} is its name." }), { agent: from.name })
        if (st.status === 'waiting') throw hiveError(msg({ id: 'session.handOver.asking', defaultMessage: '{agent} is asking you something before it can write the handover. Answer it, then hand over again without a new handover.', description: "Hand Over to… stopped: the agent handing over waits for the user. {agent} is its name." }), { agent: from.name })
        // Finished without one (the file can land a moment after the turn ends): give it 20 seconds.
        idleSince = st.status === 'finished' || st.status === 'ready' ? idleSince || Date.now() : 0
        if (idleSince && Date.now() - idleSince > 20_000 && Date.now() - t0 > 30_000) throw hiveError(msg({ id: 'session.handOver.noneWritten', defaultMessage: '{agent} finished without writing a handover. Ask it to write one, then hand over again without a new handover.', description: "Hand Over to… failed: the agent finished its turn without writing a handover. {agent} is its name." }), { agent: from.name })
        if (Date.now() - t0 > 15 * 60_000) throw hiveError(msg({ id: 'session.handOver.slow', defaultMessage: "{agent} didn't write its handover in 15 minutes.", description: "Hand Over to… gave up waiting for the handover. {agent} is the agent's name." }), { agent: from.name })
      }
    }
    if (!handover) {
      handover = (await this.latestHandover(projectPath))?.relPath ?? ''
      if (!handover) throw hiveError(msg({ id: 'session.handOver.none', defaultMessage: 'There is no handover for {project} yet. Hand over with a new handover instead.', description: "Hand Over to… with the latest handover is refused: the project has none. {project} is its name." }), { project: basename(projectPath) }, { kind: 'conflict' })
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
      const allowed = sameLaunch() && !otherWork() && (await this.handOverAllowed(projectPath, fromAgentId, true).catch(() => false))
      // And with nothing awaited between this and the stop, its launch and its work once more.
      if (!allowed || !sameLaunch() || otherWork()) throw hiveError(M.handOverMomentLost, { agent: from.name, handover }, { kind: 'conflict' })
    }
    if (self && this.live.has(liveId(projectPath, fromAgentId)) && !(await this.endConversation(projectPath, fromAgentId))) throw hiveError(msg({ id: 'session.handOver.didntStop', defaultMessage: '{agent} didn\'t stop. Stop it, then start it and ask it to read the handover "{handover}".', description: "Handing over to the same agent failed: it didn't stop to start a new conversation. {agent} is its name, {handover} the handover's path in the shared notes." }), { agent: from.name, handover })
    // The target: given the message in its running session, or started with it as its launch's task (#782), as a task
    // start is. Typed into a CLI that had only just looked ready, it could be lost under load (Codex's screen looks ready
    // before it takes input), and the next hand-over from it was refused.
    const target = this.live.get(liveId(projectPath, toAgentId))?.state ?? null
    if (target && target.status !== 'ready' && target.status !== 'finished') throw hiveError(M.handOverBusy, { agent: to.name }, { kind: 'conflict' })
    // i18n-ignore: given to the agent (agent-facing text stays English)
    const nd: NewDelivery = { agentId: toAgentId, agentName: to.name, kind: 'handover', from: HIVE_SENDER, body: `Read the handover "${handover}" with the hive_read_shared_note tool and continue the work from it. It was written by ${self ? 'you, in your previous conversation' : from.name}.` }
    // The sessions are linked with the launch's conversation as it is recorded (#782: Codex names it only with its first
    // prompt, which a question at start can hold off for minutes), never by a wait here that could give up first.
    if (target) {
      await this.delivery().now(projectPath, { ...nd, need: 'free' })
      if (fromSession) await this.linkHandover(projectPath, toAgentId, target.runId, fromSession)
    } else await this.delivery().launch(projectPath, nd, (line) => this.start(projectPath, { agentId: toAgentId, prompt: line, ...(fromSession ? { handedOverFrom: fromSession } : {}) }))
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
   * Gives an idle running agent a task in a new conversation (hive_prompt_agent with newConversation): its conversation
   * ends as when it hands over to itself (it stays in the Sessions tab), and a new one starts on the task, with no
   * handover. The caller has checked it is idle; refused while Hive is typing into it or its CLI hasn't taken a prompt
   * Hive typed (ending it would lose that prompt). Nothing awaits before the stop, so the caller's checks still hold.
   * `allowed` throws if the caller may no longer have it (the Assistant's Control or session): checked before the stop,
   * after it, and just before the new launch spawns.
   */
  async newConversation(projectPath: string, agentId: string, prompt: string, allowed?: () => void): Promise<LiveSessionState> {
    projectPath = workspace.assertProject(projectPath)
    const now = this.agentNow(projectPath, agentId)
    if (!now) throw hiveError(msg({ id: 'session.newConversation.notRunning', defaultMessage: "It isn't running.", description: 'Giving an agent a task in a new conversation is refused: it isn\'t running.' }))
    if (now.pending || this.delivering.has(this.key(projectPath, agentId))) throw hiveError(msg({ id: 'session.newConversation.pending', defaultMessage: 'It has just been given a prompt that its CLI has not taken yet.', description: "Giving an agent a task in a new conversation is refused: a prompt Hive typed hasn't been taken yet." }))
    allowed?.()
    if (!(await this.endConversation(projectPath, agentId))) throw hiveError(msg({ id: 'session.newConversation.didntStop', defaultMessage: "It didn't stop, so no new conversation was started.", description: "Giving an agent a task in a new conversation failed: it didn't stop." }))
    allowed?.()
    return this.start(projectPath, { agentId, prompt, allowed })
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
    if (!l || l.state.settingUp) throw hiveError(M.noSession, undefined, { kind: 'conflict' })
    if (!l.adapter.planToggleKey) throw hiveError(msg({ id: 'session.plan.noToggle', defaultMessage: '{provider} has no Plan mode toggle.', description: "Turning Plan mode on or off is refused: the coding agent has no such toggle. {provider} is its name." }), { provider: l.adapter.descriptor.name })
    if (l.state.status === 'waiting') throw hiveError(msg({ id: 'session.plan.asking', defaultMessage: 'The agent is asking you something. Answer it first.', description: 'Turning Plan mode on or off is refused: the agent waits for the user.' }))
    if (!!l.state.planMode === on) return
    // Not into a line Hive is typing (#649: the composer is reserved meanwhile).
    if (this.delivering.has(this.key(projectPath, agentId))) throw hiveError(msg({ id: 'session.plan.typing', defaultMessage: 'Hive is typing a line into this agent. Try again in a moment.', description: 'Turning Plan mode on or off is refused for a moment: Hive is typing into the terminal.' }))
    writePty(this.key(projectPath, agentId), l.adapter.planToggleKey)
    l.state.planMode = on
    this.emitState(l.state)
  }

  /** Stops the agent and resumes the same conversation in another permission mode. */
  async restartInMode(projectPath: string, agentId: string, mode: PermissionMode): Promise<void> {
    projectPath = workspace.assertSessionHost(projectPath)
    const id = liveId(projectPath, agentId)
    const l = this.live.get(id)
    if (!l) throw hiveError(M.noSession, undefined, { kind: 'conflict' })
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
    await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))])
    await this.start(projectPath, { resumeId: resumable ? sessionId : undefined, name: sessionName, agentId, permissionMode: mode })
  }

  // A changed mode setting applies to new sessions; for running ones, Hive offers to switch them now.
  private modeOffers = new Map<string, { label: string; mode: string }>()
  private modeOfferTimer: NodeJS.Timeout | null = null

  private noticeModeSetting(l: LiveSession, mode: PermissionMode | null): void {
    if (!mode || mode === l.configuredMode || mode === l.offeredMode) return
    if (mode === l.state.permissionMode) {
      // Already in it (switched by hand): nothing to offer.
      l.configuredMode = mode
      return
    }
    l.offeredMode = mode
    this.modeOffers.set(liveId(l.state.projectPath, l.state.agentId), { label: this.label(l.state), mode: permissionLabel(l.state.provider, mode, tr) })
    if (this.modeOfferTimer) clearTimeout(this.modeOfferTimer)
    this.modeOfferTimer = setTimeout(() => {
      this.modeOfferTimer = null
      const offers = [...this.modeOffers.values()]
      this.modeOffers.clear()
      if (!offers.length) return
      const modes = [...new Set(offers.map((o) => o.mode))]
      toast(
        'info',
        tr(msg({ id: 'session.modeOffer.title', defaultMessage: 'Permission mode changed to {modes}', description: "A notice's title: the permission mode in Settings changed for running agents. {modes} is the new mode's name (several joined by \" / \")." }), { modes: modes.join(' / ') }),
        offers.length === 1
          ? tr(msg({ id: 'session.modeOffer.one', defaultMessage: 'Switch {agent} now? Otherwise the new mode applies from its next session.', description: 'The notice that the permission mode setting changed for a running agent. {agent} is the agent.' }), { agent: offers[0].label })
          : tr(msg({ id: 'session.modeOffer.many', defaultMessage: '{n, plural, other {Switch # running agents ({agents}) now? Otherwise the new mode applies from their next session.}}', description: 'The notice that the permission mode setting changed for running agents. {n} is how many (2 or more), {agents} lists them.' }), { n: offers.length, agents: offers.map((o) => o.label).join(', ') }),
        [{ label: tr(msg({ id: 'session.modeOffer.switch', defaultMessage: 'Switch Now', description: "A notice's button: switches the running agents to the new permission mode now." })), command: 'session.applyPermissionModes' }]
      )
    }, 400)
  }

  /**
   * "Switch Now": moves every running agent whose settings now say another mode into that mode. The switches run side
   * by side (at most MODE_SWITCHES_AT_ONCE), each in its own terminal: one waiting for the user's answer to its CLI's
   * own question (Codex's Full Access warning, up to 10 minutes: #1024) doesn't hold up the others. Reported in the
   * agents' order once all have ended.
   */
  async applyModeSettings(): Promise<{ switched: string[]; skipped: string[] }> {
    const todo: { l: LiveSession; mode: PermissionMode }[] = []
    for (const l of [...this.live.values()]) {
      const st = l.state
      if (st.settingUp) continue
      const { agent } = await this.agentDef(st.projectPath, st.agentId).catch(() => ({ agent: null }))
      if (!agent) continue
      const mode = (await this.effective(st.projectPath, pinProvider(agent, st.provider))).permissionMode
      if (!mode || mode === l.configuredMode) continue
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
  async stopBackgroundAndResume(projectPath: string, agentId: string, jobId: string, sessionId: string): Promise<void> {
    projectPath = workspace.assertSessionHost(projectPath)
    const { agent, cfg } = await this.agentDef(projectPath, agentId)
    const rec = (await workspace.sessionsFile(projectPath)).sessions.find((s) => s.id === sessionId)
    const adapter = providerAdapter((await this.resumeProvider(projectPath, sessionId, rec)) ?? agentLaunchSettings(agent, cfg, config.settings).provider)
    const info = providerService.info(adapter.id)
    if (!adapter.stopBackgroundJob || !info.path) throw hiveError(msg({ id: 'session.background.cantStop', defaultMessage: "{provider} can't stop background sessions.", description: "Stop It and Resume is refused: the coding agent can't stop its background service's job. {provider} is its name." }), { provider: adapter.descriptor.name })
    await adapter.stopBackgroundJob(info.path, jobId)
    // The job lets go of the conversation as it exits.
    await new Promise((r) => setTimeout(r, 1500))
    await this.start(projectPath, { agentId, resumeId: sessionId })
  }

  /** Sessions that would be interrupted by quitting: an agent is working or waiting on a prompt. */
  busyStates(): LiveSessionState[] {
    // A watching agent is in the middle of its work (waiting on cards it will carry on with): busy too.
    return this.liveStates().filter((s) => s.status === 'working' || s.status === 'waiting' || s.status === 'background' || s.status === 'watching')
  }

  private async onExit(projectPath: string, agentId: string, runId: string, code: number, output = ''): Promise<void> {
    const id = liveId(projectPath, agentId)
    const l = this.live.get(id)
    const sessionId = l?.state.sessionId ?? ''
    // The CLI refused to open a conversation it is running as a background job (e.g. Claude Code's agent view):
    // say so, and offer to stop that job and resume here.
    const job = l && !l.stopRequested && sessionId ? l.adapter.backgroundJobIn?.(output) : null
    if (l && job) {
      toast(
        'warning',
        tr(msg({ id: 'session.background.title', defaultMessage: '{agent}: the session is running in the background', description: "A notice's title: the coding agent runs this conversation as a background job, so Hive can't open it. {agent} is the agent." }), { agent: this.label(l.state) }),
        tr(msg({ id: 'session.background.body', defaultMessage: "{provider} moved this conversation into its background service (job {job}), so it can't be opened here until that job is stopped. The conversation is kept.", description: "The notice that a conversation runs as a background job. {provider} is the coding agent's name, {job} the job's id." }), { provider: l.adapter.descriptor.name, job }),
        [{ label: tr(msg({ id: 'session.background.stopAndResume', defaultMessage: 'Stop It and Resume', description: "A notice's button: stops the coding agent's background job, then resumes the conversation in the agent." })), command: 'session.stopBackgroundAndResume', args: [projectPath, agentId, job, sessionId] }],
        projectPath
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
    if (failure) log.warn(`${userText(this.label(l!.state))}: exited with code ${code} before it started: ${userText(failure.reason.replace(/\n/g, ' | '))}`)
    if (l) {
      if (l.backupTimer) clearInterval(l.backupTimer)
      l.compacting?.end()
      await this.backup(projectPath, agentId, true).catch(() => undefined)
      // Its CLI has exited: its transcript is finished (archiving it at once is fine, inUse).
      this.noteExit(l.state.sessionId)
      this.live.delete(id)
      this.recheckTools(id)
    }
    this.runs.delete(runId)
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
    emit({ type: 'session-exit', projectPath, agentId, sessionId, exitCode: code, ...(failure ? { failure } : {}) })
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
   * runs anyway, untracked, and Hive says so (once); only one stopped while it was being tracked doesn't.
   */
  private launchWord(r: TrackResult): GateWord {
    if (r.tracked) return { go: true }
    // The gate's script prints its reason in English (launchGate.ts).
    if (r.reason === STOPPED_BEFORE_START) return { go: false, reason: r.reason }
    this.untracked(r.text ?? r.reason)
    return { go: true }
  }

  /** Whether a launch can go through its gate, its processes tracked (#507); when not, said once (untracked). */
  private async trackingReady(): Promise<boolean> {
    const ok = await trackingReady()
    if (!ok && process.platform === 'win32') this.untracked(trackingProblemText())
    return ok
  }

  /** Agents' processes can't be tracked (#507): said once a Hive run (noteUntracked); agents start all the same. */
  private untracked(reason: TextPart | null): void {
    noteUntracked(reason)
  }

  /**
   * A launch's CLI has exited: what it left running (#507) is ended, as Settings → Agents says, or offered to the user
   * to end; the agent's pane header lists it meanwhile. Quitting Hive asks about every agent's at once instead.
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
    toast(
      'warning',
      tr(msg({ id: 'session.leftovers.title', defaultMessage: '{agent} left {processes} running', description: "A notice's title: an agent's processes still run after it stopped. {agent} is the agent; {processes} how many (\"2 processes\")." }), { agent: label, processes: processCount(n, tr) }),
      failed
        ? tr(msg({ id: 'session.leftovers.notEndedBody', defaultMessage: "{processes}. {n, plural, one {It was started by the agent and may hold the project's folder or ports. Hive couldn't end it by itself.} other {They were started by the agent and may hold the project's folder or ports. Hive couldn't end them by itself.}}", description: "The notice of processes an agent left running, which Hive tried to end and couldn't. {processes} lists them (\"node serve.js, 4 × tail -f …\"); {n} is how many." }), { processes: summary, n })
        : tr(msg({ id: 'session.leftovers.body', defaultMessage: "{processes}. {n, plural, one {It was started by the agent and may hold the project's folder or ports.} other {They were started by the agent and may hold the project's folder or ports.}}", description: "The notice of processes an agent left running. {processes} lists them (\"node serve.js, 4 × tail -f …\"); {n} is how many." }), { processes: summary, n }),
      [
        { label: tr(msg({ id: 'session.leftovers.end', defaultMessage: 'End Them', description: "A notice's button: ends the processes the agent left running." })), command: 'session.settleLeftovers', args: [left.projectPath, left.agentId, 'end'] },
        { label: tr(msg({ id: 'session.leftovers.keep', defaultMessage: 'Keep Running', description: "A notice's button: keeps the processes the agent left running, and stops listing them." })), command: 'session.settleLeftovers', args: [left.projectPath, left.agentId, 'keep'] }
      ],
      left.projectPath
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

  /** Copies the live transcript into <project>/.hive/sessions so it survives the CLI's own cleanup (backupNow), each look kept on the session until it ends (LiveSession.looks). */
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
    // Fallback if hooks never arrive: a transcript means the session is up.
    if (l.state.status === 'starting') {
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
    this.settleBackground(l, await this.readBackground(l, src, size))
    await this.readSafeguards(l, src)
    if (l.compacting) {
      // Fallback if the compaction hooks never arrive: a new compaction in the transcript.
      const u = await this.usageFor(l.state.projectPath, src, sessionId, l.state.provider)
      if (u) l.compacting?.transcript(u.compactions)
    }
    if (l.defaultModel) {
      const usage = await this.usageFor(l.state.projectPath, src, sessionId, l.state.provider)
      if (usage?.model) {
        providerService.observeDefaultModel(l.state.provider, usage.model)
        l.defaultModel = false
      }
    }
    await this.liveCost(l, src, force)
  }

  /**
   * A live session's cost as the settings say now (#436): the CLI's own report (`reportedCost`, from its status line)
   * for a provider that reports one, unless the user chose their prices; else Hive's estimate, which re-reads the whole
   * transcript, so at most every 30 seconds while the agent works and at each turn's end (`force`, also after a price
   * change). With the user's prices but none for its model, the CLI's newest report (its status line's, else its
   * transcript's), never recomputed. Without a price or a report the cost is cleared, so it shows as unknown.
   */
  private async liveCost(l: LiveSession, src: string, force: boolean): Promise<void> {
    const own = usesOwnPrices(l.state.provider, config.settings)
    if (l.adapter.descriptor.capabilities.reportsCost && !own) return this.setLiveCost(l, l.reportedCost, false)
    if (!force && Date.now() - (l.costAt ?? 0) <= COST_INTERVAL_MS) return
    l.costAt = Date.now()
    const usage = await this.usageFor(l.state.projectPath, src, l.state.sessionId, l.state.provider)
    // The settings changed while it was read: the read they started decides.
    if (usesOwnPrices(l.state.provider, config.settings) !== own || !usage) return
    // An estimate is Hive's (the user's prices, or a provider that reports none); anything else is the CLI's report.
    if (usage.costUsd != null && usage.costEstimated) this.setLiveCost(l, usage.costUsd, true)
    else if (own) this.setLiveCost(l, l.reportedCost ?? usage.costUsd ?? undefined, false)
    else this.setLiveCost(l, usage.costUsd ?? undefined, false)
  }

  private setLiveCost(l: LiveSession, costUsd: number | undefined, estimated: boolean): void {
    if (l.state.costUsd === costUsd && !!l.state.costEstimated === estimated) return
    Object.assign(l.state, { costUsd, costEstimated: estimated })
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
        if (!ended.has(ev.id)) tasks.set(ev.id, { at: ev.at, expiresAt: ev.expiresAt })
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

  /** A safeguard event on the agent's state (noteSafeguard); a switch to another model is told: Hive's own notice, and a note on its Doing cards. */
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
    const next = noteSafeguard(before, ev)
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
   * it waits on, or any blocking ask naming no tool). False when Hive doesn't read its screen.
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
    return !(ev.ask.kind === 'permission' && l.adapter.descriptor.permissionModes.find((m) => m.value === l.state.permissionMode)?.reviewed)
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
      if (!turn || !this.guardSeen(l, turn, 'screen')) noted = noteSafeguard(noted, { kind: 'stop', at, model, tools: memoTools(memo) }) ?? noted
      // Kept on the session's record with its turn, so Performance counts it though the transcript may never record it
      // (HB3's didn't), and once if it does (withScreenStops), whenever Hive reads it.
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
    l.state.backgroundTasks = l.tasks?.size || undefined
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
          const stopped = dropped ? withValues(msg({ id: 'session.status.tasksDropped', defaultMessage: '{minutes, plural, one {Stopped counting its background tasks after # minute} other {Stopped counting its background tasks after # minutes}}', description: "An agent's status: Hive stopped counting the background tasks it started after the time limit in Settings. {minutes} is that limit." }), { minutes: taskMinutes() }) : null
          setStatus(st, stopped)
          st.unseen = true
          this.notify(st.projectPath, withValues(M.finished, { agent: this.label(st) }), stopped ?? msg({ id: 'session.notice.tasksEnded', defaultMessage: 'Its background tasks have ended.', description: "The notification that an agent finished once the background tasks it started ended." }), 'finished', st.agentName)
        }
        changed = true
      } else if (st.status === 'finished' && l.tasks?.size) {
        // A task the turn started, read after its end was handled.
        st.status = 'background'
        st.unseen = false
        changed = true
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
   * passes Settings → Sessions → Warn when a transcript is over: a long one slows the CLI and Hive, and only a
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
    l.sizeWarned = st.sessionId
    const label = this.label(st)
    const assistant = workspace.isAssistantHome(st.projectPath)
    log.info(`${userText(label)}: transcript is ${(bytes / 1024 ** 2).toFixed(1)} MB, over ${limitMB} MB`)
    // What it can do (#1057): told, not pushed. Hand Over to… only while it may hand over now (checked again when it is
    // clicked, and by the hand-over); else that it can when it has finished.
    void (assistant ? Promise.resolve(false) : this.handOverAllowed(st.projectPath, st.agentId).catch(() => false)).then((now) => {
      const values = { size: formatSize(bytes), limit: limitMB, when: assistant ? 'assistant' : now ? 'now' : 'other' }
      const actions: ToastAction[] | undefined = now ? [{ label: tr(msg({ id: 'session.long.handOver', defaultMessage: 'Hand Over to…', description: "A notice's button: hands the agent's work over to a new conversation (the Hand Over to… command)." })), command: 'session.handOverLongConversation', args: [st.projectPath, st.agentId] }] : undefined
      toast('warning', tr(M.longConversation, { agent: label }), tr(HAND_OVER_TEXT.notice, values), actions, st.projectPath)
      this.notify(st.projectPath, withValues(M.longConversation, { agent: label }), withValues(HAND_OVER_TEXT.notice, values), 'notice')
    })
  }

  /** Whether the agent may hand over to a new conversation of its own now (#1057): set by handOverCheck.ts, which knows the lanes. */
  handOverAllowed: (projectPath: string, agentId: string, turnOver?: boolean) => Promise<boolean> = async (projectPath, agentId, turnOver) => {
    const st = this.liveFor(projectPath, agentId)
    return handOverNow(turnOver && st ? { ...st, status: 'finished', backgroundTasks: 0 } : st, false)
  }

  /**
   * The language Hive shows changed (#797): what a live session's state says in Hive's words (where its
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
    // Its input as Hive holds it now (#648): a line typed or given up since the last report.
    const l = state.projectPath ? this.live.get(liveId(state.projectPath, state.agentId)) : undefined
    if (l?.state === state) this.fact(state, { composer: this.composerOf(l) })
    // A launch with its task on its command line: when it first became ready, before a watch shows that as watching (#721).
    if (l?.state === state && l.launchTask && l.launchReadyAt === undefined && (state.status === 'ready' || state.status === 'watching' || state.status === 'finished')) l.launchReadyAt = Date.now()
    // And any launch: its hive tools' bound runs from then (#865), which a wait for them looks at again.
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
    if (this.statusSent.get(state) !== state.status) {
      this.statusSent.set(state, state.status)
      state.statusSince = new Date().toISOString()
    }
    this.refreshSize(state)
    emit({ type: 'session-status', state: { ...state } })
  }

  /**
   * A CLI whose full-screen interface a resize while it starts can leave drawn at the wrong width (Copilot): a size
   * refresh, as resizing the window by hand gives, once it has started (its first status: ready, or a question at
   * start) and once it is ready (#486); also after Hive switches its mode live (setPermissionMode).
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

  /** A CLI refused an agent's sign-in: told once for this expiry, with every agent it has stopped by then. */
  private signInLost(provider: ProviderId): void {
    if (this.signedOut.has(provider)) return
    const out: { gather?: ReturnType<typeof setTimeout>; recheck?: ReturnType<typeof setInterval> } = {}
    this.signedOut.set(provider, out)
    out.gather = setTimeout(() => this.tellSignedOut(provider), SIGNED_OUT_GATHER_MS)
    // Agent Setup shows it signed out, and the next check that finds it signed in again ends this (providerService).
    void providerService.refresh(provider, false).catch(() => undefined)
    out.recheck = setInterval(() => {
      // Kept until it is shown signed in again: only when no agent it stopped runs any more (they exited) is there
      // nothing left to tell or carry on, and it ends quietly. An agent trying again (working) still counts.
      if (!this.liveStates().some((s) => s.provider === provider && s.signIn)) return void this.endSignedOut(provider)
      void providerService.refresh(provider, false).catch(() => undefined)
    }, SIGN_IN_RECHECK_MS)
  }

  private tellSignedOut(provider: ProviderId): void {
    const waiting = this.liveStates().filter((s) => s.provider === provider && s.status === 'signin')
    if (!waiting.length) return
    const d = providerAdapter(provider).descriptor
    const first = waiting[0]
    const title =
      waiting.length === 1
        ? withValues(msg({ id: 'session.signIn.one', defaultMessage: '{agent} needs you to sign in to {provider}', description: "A notification's title: an agent's CLI sign-in has expired. {agent} is the agent, {provider} the coding agent's name." }), { agent: this.label(first), provider: d.name })
        : withValues(msg({ id: 'session.signIn.many', defaultMessage: '{n, plural, other {# agents need you to sign in to {provider}}}', description: "A notification's title: the CLI sign-in of several agents has expired. {n} is how many (2 or more), {provider} the coding agent's name." }), { n: waiting.length, provider: d.name })
    log.info(`${d.name}: sign-in refused for ${waiting.length} agent(s)`)
    this.notify(first.projectPath, title, withValues(msg({ id: 'session.signIn.expired', defaultMessage: "{provider}'s sign-in has expired. {help}", description: "The notification that a CLI's sign-in has expired. {provider} is the coding agent's name; {help} says how to sign in again (a sentence or two)." }), { provider: d.name, help: d.text?.signInHelp ?? d.signInHelp }), 'waiting', undefined, first.agentId)
  }

  private endSignedOut(provider: ProviderId): boolean {
    const out = this.signedOut.get(provider)
    if (!out) return false
    clearTimeout(out.gather)
    clearInterval(out.recheck)
    this.signedOut.delete(provider)
    return true
  }

  /**
   * The CLI is signed in again (an agent of it works, its check says so, its Sign in task ended well): agents it
   * stopped are idle again, and Resume (n) carries them on (they keep LiveSessionState.signIn until they do).
   */
  signedInAgain(provider: ProviderId, checked = false): void {
    if (!this.endSignedOut(provider)) return
    // Agent Setup (and its banner) learn it too, unless its own check is what said so.
    if (!checked) void providerService.refresh(provider, false).catch(() => undefined)
    const stopped = this.liveStates().filter((s) => s.provider === provider && s.status === 'signin')
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
    if (!st) throw hiveError(msg({ id: 'session.carryOn.already', defaultMessage: 'It has already carried on.', description: 'Resume is refused for an agent whose turn a refused sign-in stopped: it carried on by itself meanwhile.' }))
    // A control notice for this launch (#649), given now or not at all: never once it has carried on by itself.
    await this.delivery().now(projectPath, { agentId, kind: 'control', from: HIVE_SENDER, body: CARRY_ON_PROMPT, source: 'carry-on', ref: st.runId, need: 'stalled', forRun: st.runId }, () => !!stalled())
  }

  /** The launch a hook call belongs to: named by its run id, else (older launch folders) by session id. */
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

  /** "hive" for a project with one agent, "hive · Agent 2" when it has several. */
  /** The running agent a developer console source is, or null (#698: the flight recorder's pattern trigger finds it here). */
  flightAgent(source: string): { projectPath: string; agentId: string; provider: string; label: () => string } | null {
    for (const l of this.live.values()) if (sessionSourceId(l.state.projectPath, l.state.agentId) === source) return { projectPath: l.state.projectPath, agentId: l.state.agentId, provider: l.state.provider, label: () => this.label(l.state) }
    return null
  }

  private label(st: LiveSessionState): string {
    if (workspace.isAssistantHome(st.projectPath)) return ASSISTANT_NAME
    const project = basename(st.projectPath)
    const count = workspaceOf(st.projectPath).info()?.projects.find((p) => p.path.toLowerCase() === st.projectPath.toLowerCase())?.agents.length ?? 1
    return count > 1 ? `${project} · ${st.agentName ?? 'Agent'}` : project // i18n-ignore: a fallback name, never seen (every launch has its agent's name)
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
    // launch, and only while Hive thinks it compacting (a /compact's end read later, with nothing under way, is history).
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
    // The CLI's own record that its latest turn is over (#648): kept, and acted on if Hive missed that turn's Stop. And,
    // for a CLI whose records don't name turns, when its Stops were answered (this launch's only, the latest kept).
    if (d.turnEnded !== undefined) l.turnRecord = d.turnEnded
    const started = Date.parse(l.state.startedAt)
    const answered = (d.stopsAnswered ?? []).map(Date.parse).filter((t) => t >= started)
    if (answered.length) l.stopsAnswered = [...(l.stopsAnswered ?? []), ...answered].slice(-STOPS_KEPT)
    if (d.turnEnded || answered.length) this.reconcileTurn(l)
    if (d.planUsage) reportPlanUsage(l.state.provider, d.planUsage, l.state.agentName ?? l.state.agentId)
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
    if (d.costUsd != null) l.reportedCost = d.costUsd
    const reported = d.costUsd != null && !usesOwnPrices(st.provider, config.settings)
    const next = { autoCompact, effort: d.effort ?? st.effort, modelName: d.modelName ?? st.modelName, modelId: d.modelId ?? st.modelId, costUsd: reported ? d.costUsd : st.costUsd, costEstimated: reported ? false : st.costEstimated, planMode: d.planMode ?? st.planMode, permissionMode: d.permissionMode ?? st.permissionMode, contextWindow: d.contextWindow ?? st.contextWindow }
    if (
      next.effort === st.effort &&
      next.modelName === st.modelName &&
      next.modelId === st.modelId &&
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
    Object.assign(st, next)
    if (d.permissionMode) st.modeObserved = d.permissionMode
    this.emitState(st)
    // Usage shown in the renderer carries the window: have it read again.
    if (windowChanged && st.sessionId) emit({ type: 'usage-changed', projectPath: st.projectPath, sessionId: st.sessionId })
  }

  // -------------------------------------------------------------------------
  // File locks
  // -------------------------------------------------------------------------

  private lockMode(projectPath: string): FileLockMode {
    const p = workspaceOf(projectPath).info()?.projects.find((x) => x.path.toLowerCase() === projectPath.toLowerCase())
    const own = p?.config.fileLocks
    return own && own !== 'inherit' ? own : config.settings.agents.fileLocks
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
    if (hook.event.kind !== 'toolStart' || !hook.editedPaths.length) return null
    const mode = this.lockMode(l.state.projectPath)
    const base = typeof body.cwd === 'string' && body.cwd ? body.cwd : l.state.cwd
    const files = hook.editedPaths.map((f) => resolve(isAbsolute(f) ? f : join(base, f)))
    // The folder's write log (#1214): a check running there meanwhile doesn't count, whatever the lock mode.
    observer.markEdits(files)
    if (mode === 'off') return this.editAccepted(id, files, null)
    const now = Date.now()
    for (const abs of files) {
      const held = this.locks.get(lockKey(abs))
      const holder = held && held.liveId !== id ? this.live.get(held.liveId) : undefined
      if (!holder || now - held!.at >= LOCK_TTL_MS) continue
      const rel = placeRelative(holder.state.cwd, abs) || basename(abs)
      const who = holder.state.agentName ?? 'Another agent' // i18n-ignore: in the lock's replies to the agent (agent-facing)
      log.info(`Lock: ${userText(l.state.agentName)} → ${userText(rel)} held by ${userText(who)} (${mode})`)
      if (mode === 'warn') {
        // i18n-ignore: the lock's reply to the agent (agent-facing)
        return this.editAccepted(id, files, l.adapter.lockReply({ kind: 'warn', context: `Note: ${who} is also editing ${rel} right now. Check the file's current content before changing it, and keep your edit small.` }))
      }
      if (mode === 'ask' && !l.adapter.descriptor.capabilities.lockAsk) {
        // The CLI can't show its own approval for this, so Hive asks the user and the agent waits.
        const key = `${id}|${lockKey(abs)}`
        if (this.lockAllowed.has(key)) continue
        if (!this.lockAsked.has(key)) {
          this.lockAsked.set(key, ++this.lockSeq)
          toast(
            'warning',
            tr(msg({ id: 'session.lock.title', defaultMessage: '{agent} wants to edit {file}', description: "A notice's title: an agent wants to edit a file another agent is editing (Hive's file locks, Ask me). {agent} is the agent, {file} the file's path in the project." }), { agent: this.label(l.state), file: rel }),
            tr(msg({ id: 'session.lock.body', defaultMessage: '{holder} is editing it right now. Allow {agent} to edit it too?', description: "The notice that an agent wants to edit a file another agent is editing. {holder} is the agent editing it, {agent} the agent asking." }), { holder: holder.state.agentName ?? tr(msg({ id: 'session.lock.anotherAgent', defaultMessage: 'Another agent', description: "Stands for an agent whose name isn't known, at the start of a sentence (\"Another agent is editing it right now.\")." })), agent: l.state.agentName ?? tr(msg({ id: 'session.lock.theAgent', defaultMessage: 'the agent', description: "Stands for an agent whose name isn't known, in the middle of a sentence (\"Allow the agent to edit it too?\")." })) }),
            [{ label: tr(msg({ id: 'session.lock.allow', defaultMessage: 'Allow', description: "A notice's button: lets the agent edit the file another agent is editing." })), command: 'session.allowLockedEdit', args: [l.state.projectPath, l.state.agentId, abs] }],
            l.state.projectPath
          )
        }
        return l.adapter.lockReply({
          kind: 'deny',
          // i18n-ignore: the lock's reply to the agent (agent-facing)
          reason: `${who} is editing ${rel} right now (Hive file lock). Hive has asked the user whether you may edit it too. Stop and wait: don't work around this. When the user says go ahead, try the edit again.`
        })
      }
      // i18n-ignore: the lock's reply to the agent, or its CLI's own question (agent- and CLI-facing)
      const reason = `${who} is editing ${rel} right now (Hive file lock). Work on something else, or wait until ${who} has finished its task, then try again.`
      return l.adapter.lockReply({ kind: mode === 'ask' ? 'ask' : 'deny', reason })
    }
    let fresh = false
    for (const abs of files) {
      const key = lockKey(abs)
      const held = this.locks.get(key)
      if (!held || held.liveId !== id) fresh = true
      this.locks.set(key, { liveId: id, at: now, seq: ++this.lockSeq, path: abs })
    }
    if (fresh) this.publishLocks(id)
    return this.editAccepted(id, files, null)
  }

  /**
   * An edit going ahead (every file in it): the files need no go-ahead any more, whoever held them meanwhile (the
   * holder may have finished before the retry). Returns `reply`.
   */
  private editAccepted<T>(id: string, files: string[], reply: T): T {
    for (const abs of files) this.lockGoAhead.delete(`${id}|${lockKey(abs)}`)
    return reply
  }

  /**
   * "Allow" on an "Ask me" lock notification: lets the agent edit the file, and tells it to go ahead (sendGoAheads):
   * now if it is idle, else when its turn ends (the toast shows while the blocked agent is still replying, and that
   * turn's end would otherwise drop the allowance with nothing typed).
   */
  async allowLockedEdit(projectPath: string, agentId: string, path: string): Promise<void> {
    projectPath = workspace.assertSessionHost(projectPath)
    const id = liveId(projectPath, agentId)
    const l = this.live.get(id)
    if (!l) return
    const key = `${id}|${lockKey(resolve(path))}`
    this.lockAllowed.set(key, ++this.lockSeq)
    this.lockGoAhead.set(key, path)
    this.sendGoAheads(id, l)
  }

  /**
   * Gives the agent one go-ahead for its allowed files once its turn has ended: a delivery (#649: a control notice for
   * this launch) the delivery service offers as any line of Hive's is, only while it is free and the user isn't writing
   * in its terminal (Pause after you type), checked again until Enter, so the user's input is never added to or sent. The
   * files are allowed again for the turn it starts. Not typed yet, it waits (the user's own prompt, or a wake, went
   * first; the files stay allowed for it, and the next turn's end gives it again).
   */
  private sendGoAheads(id: string, l: LiveSession): void {
    const { projectPath, agentId, runId } = l.state
    const keys = [...this.lockGoAhead.keys()].filter((k) => k.startsWith(`${id}|`))
    if (!keys.length || (l.state.status !== 'ready' && l.state.status !== 'finished') || this.live.get(id) !== l) return
    const paths = keys.map((k) => this.lockGoAhead.get(k)!)
    for (const k of keys) this.lockAllowed.set(k, ++this.lockSeq)
    // This delivery's go-aheads, still wanted: an interrupt, the edit going ahead, or the session ending or moving
    // (dropGoAheads, editAccepted) cancels it, even part-way.
    const current = (): boolean => this.live.get(id) === l && keys.every((k, i) => this.lockGoAhead.get(k) === paths[i])
    this.delivery()
      .give(projectPath, { agentId, kind: 'control', from: HIVE_SENDER, body: goAheadPrompt(l.state.cwd, paths), source: 'go-ahead', ref: runId, replace: true, need: 'free', forRun: runId }, {
        holds: current,
        received: () => keys.forEach((k, i) => this.lockGoAhead.get(k) === paths[i] && this.lockGoAhead.delete(k))
      })
      .catch((e: Error) => log.info(`${userText(this.label(l.state))}: go-ahead for a locked edit not given: ${e.message}`))
  }

  /**
   * Releases an agent's file locks, approvals and questions: all of them, or (`before`, a lockSeq) those from
   * before then, so a turn's end handled late keeps what the next turn has claimed since.
   */
  private releaseLocks(id: string, before = Infinity): void {
    for (const map of [this.lockAllowed, this.lockAsked]) {
      for (const [k, seq] of map) if (k.startsWith(`${id}|`) && seq <= before) map.delete(k)
    }
    // A go-ahead waits for the turn's end, so only releasing everything (the session ended or moved) drops it.
    if (before === Infinity) this.dropGoAheads(id)
    let changed = false
    for (const [k, v] of this.locks) {
      if (v.liveId === id && v.seq <= before) {
        this.locks.delete(k)
        changed = true
      }
    }
    if (changed) this.publishLocks(id)
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
    // i18n-ignore: a delivery's record, which agents and the log read
    if (had && l) void this.deliveries?.cancel(l.state.projectPath, 'go-ahead', l.state.runId, 'cancelled: the go-ahead was dropped').catch(() => undefined)
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
   * The notice for what the agent has unread (#650, inboxNotices.ts): Hive's fixed text, or null when there is nothing
   * to tell. At a checkpoint (a tool call of the agent's own ended) or its turn's end (the drain: a reply that carries
   * the turn on). The turn ledger counts a turn's end only from a Stop answered with nothing, as continuations fire no
   * prompt (#648).
   */
  inboxNotice: ((state: LiveSessionState, at: 'checkpoint' | 'drain') => Promise<string | null> | string | null) | null = null

  /**
   * What Hive answers a hook call with (the hook server sends it, then calls handleHook with the same body): a
   * PreToolUse's file-lock decision (made at once, before anything is awaited: it claims locks in the order hooks came);
   * for a hook that may carry a notice (a tool's end, a Stop: noticeReply), a reply decided in the launch's hook order by
   * handleHookNow, once the turn ledger has the hooks before it (#650: the ledger's verdict and turn, never a view of its
   * own); else nothing.
   */
  hookReply(runId: string | null, body: Record<string, any>): Promise<Record<string, unknown> | null> {
    if (body.hook_event_name === 'SessionStart') return this.startReply(runId, body)
    const afterCompaction = this.compactionContextReply(runId, body)
    if (afterCompaction) return afterCompaction
    const lock = body.hook_event_name === 'PreToolUse' ? this.preToolUse(runId, body) : null
    if (lock || !this.inboxNotice) return Promise.resolve(lock)
    const l = this.findLaunch(runId, body.session_id)?.[1]
    if (!l) return Promise.resolve(null)
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

  /** The start context for a launch, in its CLI's reply form, or null (none, or it couldn't be made). */
  private async startContextFor(l: LiveSession, source: string | null): Promise<Record<string, unknown> | null> {
    if (!this.startContext || !l.adapter.startContextReply) return null
    try {
      const text = await this.startContext(l.state, source)
      return text ? l.adapter.startContextReply(text) : null
    } catch (e) {
      log.warn('start context', e)
      return null
    }
  }

  /** Hook calls whose reply waits for its place in the launch's hook order (hookReply), by their body. */
  private noticeReplies = new WeakMap<object, (reply: Record<string, unknown> | null) => void>()

  /**
   * The notice for a hook in the launch's order (#650), with the turn ledger as it is just before it (nothing else of the
   * launch is handled while this is worked out): none for a hook the ledger finds stale; a checkpoint after the agent's
   * own tool call; the drain at a Stop of the running turn that Hive hasn't carried on yet (the ledger's own count, so at
   * most once a turn, whatever a Stop says of it). Null when there is nothing to tell.
   */
  private async noticeIn(runId: string | null, l: LiveSession, ledger: TurnLedger, body: Record<string, any>, woke: boolean, at: number): Promise<Record<string, unknown> | null> {
    if (!this.inboxNotice) return null
    const hook = l.adapter.normalizeHook(body)
    const ev = hook.event
    // What the ledger would make of it (a copy: it is admitted below, with what it was told).
    if (admit(structuredClone(ledger), ev, hook.ids, { woke, now: at }).verdict === 'stale') return null
    const drain = ev.kind === 'stop'
    if (drain && !(ledger.active && ledger.active.state === 'running' && ledger.active.continued === 0)) return null
    const turn = ledger.active
    const text = await this.inboxNotice(l.state, drain ? 'drain' : 'checkpoint')
    // Still that launch and that turn (the queue holds the rest of the launch's hooks, so only its end can change them).
    if (!text || this.findLaunch(runId, body.session_id)?.[1] !== l || ledger.active !== turn) return null
    const reply = l.adapter.noticeReply(String(body.hook_event_name ?? ''), text)
    // A CLI that takes the drain as a new prompt: that prompt is Hive's own, in the turn it carries on.
    if (reply && drain && l.adapter.drainIsPrompt) expectInjected(ledger, text)
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
    // When it reached Hive, before it waits its turn: a turn begins then, for comparing with the CLI's records (#648).
    const at = Date.now()
    const launch = this.findLaunch(runId, body.session_id)?.[1]
    // The launch's hooks before this one: what the old conversation had seen, if this one switches conversations.
    const before = launch?.hooksSeen ?? 0
    if (launch) launch.hooksSeen = before + 1
    return this.inHookOrder(runId ?? `session:${String(body.session_id ?? '')}`, () => this.handleHookNow(runId, body, arrived, before, reply, at))
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
      st.permissionMode = st.modeObserved = hook.mode
      this.emitState(st)
    }
    // The turn ledger first (#648): a hook about a turn that is over is old news, and a Stop Hive carried on isn't an end.
    const ledger = (l.ledger ??= newLedger())
    const ids = hook.ids
    const before = st.status
    // A CLI that wakes when its background tasks end begins that turn itself: while its transcript says one just ended
    // (never merely because one runs), a tool call it never saw may open that turn should its prompt hook be lost
    // (turnLedger rule 1).
    const woke = l.adapter.descriptor.capabilities.backgroundWakes && !!l.woke
    // Its notice (#650), from the ledger as it is now, before it is admitted with what it was told.
    if (decide) {
      reply = await this.noticeIn(runId, l, ledger, body, woke, at).catch((e) => {
        log.warn(`${userText(label)}: no inbox notice`, e)
        return null
      })
      if (!current()) return
      decide(reply as Record<string, unknown> | null)
    }
    const continued = hook.event.kind === 'stop' && !hook.event.failed && !!reply && typeof reply === 'object' && l.adapter.stopContinues(reply as Record<string, unknown>)
    const was = ledger.active
    const took = admit(ledger, hook.event, ids, { hiveContinued: continued, woke, now: at })
    if (ledger.active !== was) l.woke = false
    let actions: readonly string[] = [took.verdict === 'stale' ? 'stale' : 'continued']
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
      const step = hookStep(ev, this.statusInput(l))
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
    // The developer console (#636): the hook as it came, next to what Hive made of it (with the turn ledger's verdict).
    const made = took.verdict === 'apply' ? took.event : hook.event
    devConsole.capture([sessionSourceId(st.projectPath, st.agentId)], () => {
      const name = safeWord(body.hook_event_name) || '(unnamed)'
      return { kind: 'hook', name, provider: st.provider, raw: body, made: { event: made, status: st.status, actions, ...(reply ? { reply } : {}) }, safe: { raw: HOOK_FIELDS, made: HOOK_MADE_FIELDS }, summary: hookSummary(name, body.tool_name, made.kind, st.status, [...actions], !!reply) }
    })
    this.noteTurn(l)
    if (hook.event.kind !== 'ignore' || ids.turn) {
      // i18n-ignore: the log and the hook journal (English)
      const verdict = took.verdict === 'apply' ? (took.note ?? '') : took.verdict === 'stale' ? `stale: ${took.why}` : 'carried on by Hive'
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
    if (JSON.stringify(turn) === JSON.stringify(st.turn)) return
    st.turn = turn
    this.emitState(st)
  }

  /**
   * What the CLI's own records say ended the turn Hive has running (#648), for the log; null when they don't: its record
   * of that turn by id (Codex), or of a Stop of it Hive never got (Copilot, by when its Stops were answered).
   */
  private recordEnds(l: LiveSession): string | null {
    if (!l.ledger) return null
    const rec = l.turnRecord
    // i18n-ignore: the log and the hook journal (English)
    if (rec && reconciles(l.ledger, rec.turn)) return `${l.adapter.descriptor.name} recorded the end of turn ${rec.turn} at ${rec.at}`
    // i18n-ignore: the log and the hook journal (English)
    if (unheardStop(l.ledger, l.stopsAnswered ?? [])) return `${l.adapter.descriptor.name} recorded a Stop of its running turn answered at ${new Date(l.stopsAnswered!.at(-1)!).toISOString()} that never reached Hive`
    return null
  }

  /** The CLI recorded the end of the turn Hive has running, whose Stop never came (#642): over, as that Stop would end it, in order with the hooks. */
  private reconcileTurn(l: LiveSession): void {
    const id = liveId(l.state.projectPath, l.state.agentId)
    void this.inHookOrder(l.state.runId, async () => {
      const why = this.live.get(id) === l ? this.recordEnds(l) : null
      if (why) await this.endTurnFrom(id, l, 'transcript', why)
    })
  }

  /** Ends the running turn on other evidence than its Stop (the CLI's record, its screen), as that Stop would; logged with what Hive saw before. */
  private async endTurnFrom(id: string, l: LiveSession, by: 'transcript' | 'screen', why: string): Promise<void> {
    const st = l.state
    const before = st.status
    const turn = describeTurn(l.ledger!)
    endRunning(l.ledger!, by)
    const ev: HookEvent = { kind: 'stop', lastMessage: null }
    await this.beforeTurnEnd(l, null)
    this.carryOut(id, l, hookStep(ev, this.statusInput(l)), by, ev)
    this.noteTurn(l)
    const seen = (l.recentHooks ?? []).map((h) => `${h.kind} ${new Date(h.at).toISOString().slice(11, 19)} → ${h.status}`).join(', ')
    log.info(`${userText(this.label(st))}: ${why}, and Hive saw no Stop: its turn is over (${turn}; ${before} → ${st.status}; hooks before: ${seen || 'none'})`)
    hookJournal(`run=${st.runId} seq=${l.ledger!.seq} (no hook) turn over by ${by} ${before}→${st.status}`)
  }

  /** What the launch's CLI shows of its turn on screen (ProviderAdapter.turnScreen), null when it isn't read or isn't sure. */
  private screenTurn(l: LiveSession): ScreenReading {
    const screen = l.turnScreen ? l.screen?.text() : null
    return screen ? l.turnScreen!(screen) : null
  }

  /**
   * A running turn Hive has heard nothing of for a while (silentMs): its end, if the CLI's record or its screen shows it,
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
   * unknown; anything Hive hears of it in the meantime says more.
   */
  markIdle(projectPath: string, agentId: string): Promise<void> {
    const id = liveId(projectPath, agentId)
    const l = this.live.get(id)
    if (!l || l.state.turn?.state !== 'unknown') return Promise.resolve()
    return this.inHookOrder(l.state.runId, () => {
      if (this.live.get(id) !== l || l.state.turn?.state !== 'unknown' || !l.ledger) return
      const before = l.state.status
      // The user's word supersedes what Hive thought runs (their ends may be lost too): the turn and its open tool calls
      // (the ledger's), a compaction (markedIdle ends Hive's own), a person asked.
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
      reviewed: !!l.adapter.descriptor.permissionModes.find((m) => m.value === st.permissionMode)?.reviewed,
      titleAsks: !!l.titleAsks,
      open: l.open ?? [],
      waitingOn: l.waitingOn ?? null,
      question: !!st.question,
      reviewing: !!st.review,
      safeguardPrompt: this.guardAnswerable(l)
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
    if (st.signIn && this.signedOut.has(st.provider) && (ev?.kind === 'interrupt' || (ev?.kind === 'stop' && ev.failed)))
      step = { ...step, next: 'signin', message: null, actions: step.actions.filter((a) => a !== 'notifyFinished') }
    if (step.open !== undefined) l.open = step.open
    if (step.waitingOn !== undefined) l.waitingOn = step.waitingOn
    for (const action of step.actions) {
      switch (action) {
        case 'answered':
          this.startupAnswered(l)
          break
        case 'prompted':
          l.prompts = (l.prompts ?? 0) + 1
          if (workspace.isAssistantHome(st.projectPath)) this.onAssistantPrompt(st.projectPath)
          if (ev?.kind === 'prompt') this.noteUserReply(l, ev.text)
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
          // Compaction Hive started is already shown as "Compacting…".
          toast(
            'info',
            tr(msg({ id: 'session.autoCompact.title', defaultMessage: '{agent}: compacting conversation', description: "A notice's title: an agent's CLI compacts its conversation by itself. {agent} is the agent." }), { agent: label }),
            tr(msg({ id: 'session.autoCompact.body', defaultMessage: '{provider} is summarising the context to free up space.', description: "The notice that an agent's CLI compacts its conversation by itself. {provider} is the coding agent's name." }), { provider: l.adapter.descriptor.name }),
            undefined,
            st.projectPath
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
          this.notify(st.projectPath, withValues(M.finished, { agent: label }), (ev?.kind === 'stop' && ev.lastMessage?.slice(0, 180)) || msg({ id: 'session.notice.finishedBody', defaultMessage: 'The agent has finished its task.', description: "The notification that an agent finished, when it left no last message to show." }), 'finished', st.agentName)
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
          // Hive missed how its last turn ended (#612): what it saw before, so the next time says why. Hook kinds and
          // statuses only, no user text.
          const seen = (l.recentHooks ?? []).map((h) => `${h.kind} ${new Date(h.at).toISOString().slice(11, 19)} → ${h.status}`).join(', ')
          log.info(`${userText(label)}: ${l.adapter.descriptor.name} is idle at its prompt while Hive showed it working; idle again (hooks before: ${seen || 'none'})`)
          break
        }
        case 'signedOut':
          {
            const said = ev?.kind === 'signIn' && ev.message?.slice(0, 500)
            // The CLI's own message, or Hive's (its English for agents, its text for the window).
            const hive = said ? null : withValues(msg({ id: 'session.signIn.notSignedIn', defaultMessage: "{provider} isn't signed in.", description: "Why an agent's turn stopped, when its CLI didn't say: its sign-in was refused. {provider} is the coding agent's name." }), { provider: l.adapter.descriptor.name })
            st.signIn = { message: said || englishText(hive!), since: new Date().toISOString(), ...(hive ? { messageText: hive } : {}) }
          }
          this.signInLost(st.provider)
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
    const facts = this.fact(st, this.factsOf(l, step, ev, carriedOn))
    const stepped = applyStep(st, step)
    const guarded = this.settleSafeguard(l)
    // A turn's end is reported even when the status stays (its background task count may have changed).
    if (stepped || step.actions.includes('turnEnded') || carriedOn || facts || guarded) this.emitState(st)
    // The CLI is signed in again, for its other agents too (this one's status is already set).
    if (worked) this.signedInAgain(st.provider)
    // A turn's end types the go-ahead for an Allow given during it; an interrupt (the user stopping it) drops it.
    if (step.actions.includes('turnEnded')) this.sendGoAheads(id, l)
    else if (step.actions.includes('releaseLocks')) this.dropGoAheads(id)
    // Why you were told an agent needs you, and when it no longer does (Help → Copy Diagnostics): never what was asked.
    // i18n-ignore: the log (English)
    const told = step.actions.includes('notifyWaiting') ? 'waits for you' : step.actions.includes('notifyQuestion') ? 'asks a question' : needed && !asksYou(st) ? 'no longer needs you' : null
    if (told) log.debug(`${userText(label)}: ${told} (${cause})`)
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
    // A prompt starts a turn once a compaction has begun; before Hive's own begins, it may be the /compact Hive typed.
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
      st.transcriptBytes = undefined
      this.clearTasks(l)
      l.lastBackupAt = undefined
      st.costUsd = undefined
      st.costEstimated = undefined
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
   * Tells the user (and for finished/waiting, the chime): a banner in the Hive window they are using, else a Windows
   * notification (route()). A notice is a warning that needs no sound. Its title and body are formatted in the language
   * Hive shows; the Agent API's stream gets the title in English (`apiTitle`, #796), and never the body.
   */
  private notify(projectPath: string, titleText: Text, bodyText: TextPart, kind: 'finished' | 'waiting' | 'notice', agentName?: string, agentId?: string): void {
    const title = shownText(titleText)
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
    if (this.route(projectPath, kind) === 'none') return
    // Finishes that come together are told in one notice ("3 agents finished in hive"); a question is told at once.
    if (kind === 'finished') {
      const assistant = workspace.isAssistantHome(projectPath)
      // i18n-ignore: a fallback name, never seen (every agent that finishes has its name)
      this.finishes.add({ projectPath, project: assistant ? ASSISTANT_NAME : basename(projectPath), agent: assistant ? ASSISTANT_NAME : (agentName ?? 'Agent'), title, apiTitle, body })
      return
    }
    this.deliver(projectPath, title, body, kind, agentId, apiTitle)
  }

  /** Where a notice about this project goes now: the settings, and the Hive window the user is using (noticeRoute). */
  private route(projectPath: string, kind: 'finished' | 'waiting' | 'notice'): NoticeRoute {
    return noticeRoute(config.settings.notifications, kind, this.focusedHive(), { workspacePath: workspaceOf(projectPath)?.path ?? null, projectPath })
  }

  /** A banner in the focused window, or a Windows notification, as route() says now; `apiTitle`: its title in English, when `title` is translated. */
  private deliver(projectPath: string, title: string, body: string, kind: 'finished' | 'waiting' | 'notice', agentId?: string, apiTitle?: string): void {
    const route = this.route(projectPath, kind)
    const notice = { id: randomUUID(), kind, title, ...(apiTitle && apiTitle !== title ? { apiTitle } : {}), body, projectPath, ...(agentId ? { agentId } : {}) }
    if (route === 'windows') {
      // The Agent API's stream hears of every notice Hive tells, as a banner or a Windows notification (#620).
      tellListeners({ type: 'notice', notice, windows: true })
      return this.showNotification(projectPath, title, body)
    }
    const at = this.focusedHive()
    if (route !== 'banner' || !at) return
    emitTo(at.win, { type: 'notice', notice })
  }

  /**
   * Finishes collected by `finishes`, in one notice: those that may still be told (notifications turned off
   * meanwhile, or left out by the banner scope), counted and opened from what is left, as a banner or a Windows
   * notification as things are when it is shown.
   */
  private readonly finishes = new FinishBatcher((all) => {
    const items = all.filter((i) => this.route(i.projectPath, 'finished') !== 'none')
    if (!items.length) return
    const { title, body } = finishedNotice(items)
    this.deliver(items[0].projectPath, title, body, 'finished', undefined, finishedApiTitle(items))
  })

  /** A Windows notification; clicking it shows the project (the first one's, for finishes in several). */
  private showNotification(projectPath: string, title: string, body: string): void {
    if (!Notification.isSupported()) return
    const note = new Notification({ title, body, silent: true, icon: notificationIcon() })
    // Keep a reference: a garbage-collected Notification no longer delivers its click.
    shownNotifications.add(note)
    if (shownNotifications.size > 50) shownNotifications.delete(shownNotifications.values().next().value!)
    note.on('click', () => {
      shownNotifications.delete(note)
      const w = this.getWindow(projectPath)
      if (w) {
        presentWindow(w)
        emitTo(w, { type: 'menu-command', command: 'project.focus', args: [projectPath] })
      }
    })
    if (!showOsNotification(note, title, body)) shownNotifications.delete(note)
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
  private async usageFor(projectPath: string, path: string, sessionId: string, provider: ProviderId): Promise<SessionUsage | null> {
    try {
      const s = await stat(path)
      const seen = usageSeen.get(path)
      if (seen && seen.mtime === s.mtimeMs && seen.size === s.size && seen.sessionId === sessionId && seen.provider === provider) {
        // Most recently used last: the oldest go first when there are too many.
        usageSeen.delete(path)
        usageSeen.set(path, seen)
        // Unchanged since it was read: priced again after a price change, not read.
        return (seen.usage ??= this.priced(seen.raw))
      }
      const r = await usageHistory.read(projectPath, path, sessionId, provider)
      if (!r) return null
      this.checkUnderstood(provider, r.usage, r.size)
      // The title the CLI's own index gives it (Codex's, Copilot's), which the worker's parsers can't read.
      const raw = this.titled(r.usage)
      const c: UsageSeen = { sessionId, provider, size: r.size, mtime: r.mtime, raw, usage: this.priced(raw) }
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

  /** Launch notices already shown (launchNotice), by agent, folder and notice: once each while Hive runs. */
  private launchNotices = new Set<string>()

  /**
   * A large transcript in which Hive found no requests at all most likely means the CLI changed its
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
      tr(msg({ id: 'session.format.title', defaultMessage: 'Hive may not fully understand this {provider} version', description: "A notice's title: a coding agent's transcripts show no token use, so its format probably changed. {provider} is the coding agent's name." }), { provider: name }),
      usage.cliVersion
        ? tr(msg({ id: 'session.format.bodyVersion', defaultMessage: 'A {provider} {version} session with activity showed no token use, so the Overview and costs may be incomplete. A Hive update will fix it.', description: "The notice that a coding agent's transcripts show no token use. {provider} is the coding agent's name, {version} its version (\"2.1.299\")." }), { provider: name, version: usage.cliVersion })
        : tr(msg({ id: 'session.format.body', defaultMessage: 'A {provider} session with activity showed no token use, so the Overview and costs may be incomplete. A Hive update will fix it.', description: "The notice that a coding agent's transcripts show no token use. {provider} is the coding agent's name." }), { provider: name })
    )
  }

  /**
   * Saves the clipboard's image for the running session in its attachments folder (<host>/.hive/attachments/<sessionId>)
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
    if (!l) throw hiveError(M.noSession, undefined, { kind: 'conflict' })
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
    const d = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
    // Characters Windows refuses in a name, and control characters, become "_"; a long name keeps its end (the extension).
    const own = name ? name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(-100) : ''
    const ext = own ? extname(own) : '.png'
    const base = own ? `${stamp}_${own.slice(0, own.length - ext.length)}` : stamp
    return freeName(dir, `${base}${ext}`, (i) => `-${i + 1}`)
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

  /** The provider's transcript, or Hive's backup (active or archived) when the provider no longer has it. */
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
   * Hive's backup of a session in a folder (active or archived), as it is kept (#1110): its plain `.jsonl` while it runs
   * (and after a resume, the newer), else its compressed `.jsonl.gz`; null when it has neither.
   */
  backupCopy(projectPath: string, sessionId: string, archived = false): string | null {
    const plain = this.backupPath(projectPath, sessionId, archived)
    if (existsSync(plain)) return plain
    return existsSync(plain + GZ) ? plain + GZ : null
  }

  /**
   * The provider a conversation to resume ran in (#506): its record's, or for one Hive has no record of (started
   * outside Hive) the provider whose CLI has its transcript. Null when neither knows it: the agent's provider tries.
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
  async usage(projectPath: string, sessionId: string, ctx?: ListContext): Promise<SessionUsage | null> {
    assertSessionId(sessionId)
    const records = ctx?.records ?? (await workspace.sessionsFile(projectPath)).sessions
    const rec = records.find((s) => s.id === sessionId)
    const running = this.projectStates(projectPath).some((s) => s.sessionId === sessionId)
    let usage: SessionUsage | null = null
    if (running && ctx?.stored) {
      // As its pane has it; unchanged since the last read, the worker isn't asked at all (usageFor).
      const p = await this.anyTranscript(projectPath, sessionId, ctx)
      if (p) usage = await this.usageFor(projectPath, p, sessionId, await this.sessionProvider(projectPath, sessionId, ctx))
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
      usage = await this.usageFor(projectPath, p, sessionId, await this.sessionProvider(projectPath, sessionId, ctx))
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

  async list(projectPath: string): Promise<SessionListItem[]> {
    projectPath = workspace.assertSessionHost(projectPath)
    const file = await workspace.sessionsFile(projectPath)
    // Read once for the whole list, not once per session.
    const ctx: ListContext = { records: file.sessions, cfg: await workspace.projectConfig(projectPath), stored: await usageHistory.storedUsage(projectPath).catch(() => new Map()) }
    const ttl = config.settings.sessions.cacheTtl
    const items: SessionListItem[] = []
    // Deleted sessions stay hidden, though the CLI still has their transcripts.
    const known = new Set([...file.sessions.map((s) => s.id), ...(file.deleted ?? [])])
    // Records from before sub-sessions were told apart (a guardian review adopted then): found now, and kept on them.
    const found = new Map<string, SubSession>()
    for (const rec of file.sessions) {
      const provider = recordProvider(rec)
      let transcript: string | null = null
      try {
        transcript = await providerAdapter(provider).transcriptPath(rec.cwd ?? projectPath, rec.id, rec.transcriptPath)
      } catch {
        // A provider this version doesn't know.
      }
      const hasTranscript = !!transcript
      const hasBackup = this.backupFiles(projectPath, rec.id).length > 0
      const usage = await this.usage(projectPath, rec.id, ctx)
      const { keptUsage: _kept, ...fields } = rec
      const sub = rec.sub ?? (await this.recordSub(projectPath, rec))
      if (sub && !rec.sub) found.set(rec.id, sub)
      items.push({
        ...fields,
        ...(sub ? { sub } : {}),
        provider,
        source: 'hive',
        title: usage?.title ?? null,
        lastActivity: usage?.lastActivity ?? rec.lastActiveAt,
        hasTranscript,
        hasBackup,
        transcriptBytes: await transcriptSize(transcript),
        ...(!ctx.stored?.has(rec.id) && (hasTranscript || hasBackup) ? { pending: true } : {}),
        usage,
        recache: usage && providerDescriptor(provider).capabilities.promptCacheTtl ? recacheEstimate(usage, ttl) : null
      })
    }
    if (found.size) await this.keepSubs(projectPath, found)
    // Sessions started outside Hive in the project folder; and from the other folders its sessions ran in (agents'
    // worktrees, the Assistant's workspace folder), only the sub-sessions of sessions listed here.
    const folders = this.sessionFolders(projectPath, file.sessions, ctx.cfg)
    for (const adapter of allProviders()) {
      for (const [i, folder] of folders.entries()) {
        for (const ext of await adapter.listSessions(folder).catch(() => [])) {
          if (known.has(ext.id) || (i > 0 && !(ext.sub?.parentId && items.some((x) => x.id === ext.sub!.parentId)))) continue
          known.add(ext.id)
          // From the usage history only (#1106): one it doesn't have, or has from before its file changed, is queued for the
          // worker (the window is told when it has it), and shows as the history has it meanwhile, or not yet.
          const st = await stat(ext.transcriptPath).catch(() => null)
          const kept = ctx.stored?.get(ext.id)
          const same = !!st && !!kept?.read.path && samePlace(kept.read.path, ext.transcriptPath) && kept.read.size === st.size && kept.read.mtime === st.mtimeMs
          const usage = kept ? this.titled(kept.usage) : null
          if (!same) void usageHistory.ingestExternal(projectPath, { id: ext.id, provider: adapter.id, transcriptPath: ext.transcriptPath }).catch(() => undefined)
          // Known to be empty: not listed. Not known yet: listed without figures until the worker has it.
          if (usage && usage.requests === 0) continue
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
    }
    return items.sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''))
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
    for (const a of projectAgents(cfg)) add(a.worktree?.path)
    for (const r of records) add(r.cwd)
    return [...out.values()]
  }

  /** Whether one of Hive's records is a sub-session, from its transcript's first line (the CLI's, else Hive's copy). */
  private async recordSub(projectPath: string, rec: SessionRecord): Promise<SubSession | null> {
    if (rec.sub) return rec.sub
    try {
      const adapter = providerAdapter(recordProvider(rec))
      const path = (await adapter.transcriptPath(rec.cwd ?? projectPath, rec.id, rec.transcriptPath).catch(() => null)) ?? this.backupCopy(projectPath, rec.id) ?? this.backupCopy(projectPath, rec.id, true)
      return path ? await adapter.subSessionOf(path, rec.id) : null
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
   * Archives or unarchives one of Hive's sessions (its backup moves to or from .hive/archive), all or nothing: with the
   * session reserved (nothing reads, resumes or moves it meanwhile) and nothing having it in use (assertFree), the new
   * archive is built aside, then each copy is moved; a failure at any step (a copy another program holds, the record
   * not saved) moves everything back, and the record changes only once the files have.
   */
  async archive(projectPath: string, sessionId: string, archived: boolean): Promise<void> {
    projectPath = workspace.assertSessionHost(projectPath)
    assertSessionId(sessionId)
    if (!(await workspace.sessionsFile(projectPath)).sessions.some((s) => s.id === sessionId)) throw hiveError(msg({ id: 'session.archive.notKept', defaultMessage: 'Only sessions Hive keeps can be archived: adopt it first.', description: "Archiving a session is refused: it was started outside Hive, so Hive has no copy of it (Adopt keeps one)." }))
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
   * Backup retention (#1110, Settings → Sessions → Keep transcript backups; off by default): Hive's copies of a host's
   * sessions last active more than that many days ago go to the Recycle Bin (trash()), only where the CLI still has the
   * session's transcript (it can still be opened and resumed from there), and only once the usage history has what it
   * used. A session whose only copy is Hive's is never touched (the Assistant for Darren, 20 Oct): deleting those stays
   * the user's (Delete, Clean Up). Running sessions and those whose files are moving are skipped; each is checked again
   * with its backups locked, just before they go. Returns how many sessions' copies went.
   */
  async applyRetention(projectPath: string): Promise<number> {
    if (!retentionDays()) return 0
    const recs = (await workspace.sessionsFile(projectPath).catch(() => null))?.sessions ?? []
    // Whether a session's copies may go, as things are now: the setting, its record's last activity, not running, with
    // backups, and the CLI still having it. Asked before, and again under its reservation and locks, then once more
    // after what it used is recorded (that waits), just before they go: any of it can change meanwhile.
    // The record is read last, and nothing is awaited between these checks and the copies going.
    const eligible = async (id: string): Promise<boolean> => {
      if (!(await this.providerTranscript(projectPath, id).catch(() => null))) return false
      const rec = (await workspace.sessionsFile(projectPath).catch(() => null))?.sessions.find((r) => r.id === id)
      const days = retentionDays()
      return !!rec && !!days && Date.now() - Date.parse(rec.lastActiveAt) > days * 86_400_000 && !this.liveAnywhere(id) && this.backupFiles(projectPath, id).length > 0
    }
    let n = 0
    for (const rec of recs) {
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
   * Compresses the backups of a host's sessions that ended before this Hive did it (#1110): one at a time, in the
   * background, the oldest first; those running or active in the last ten minutes are left for their end.
   */
  async compressIdleBackups(projectPath: string): Promise<number> {
    const recs = (await workspace.sessionsFile(projectPath).catch(() => null))?.sessions ?? []
    const idle = recs.filter((r) => Date.now() - Date.parse(r.lastActiveAt) > 10 * 60_000).sort((a, b) => (a.lastActiveAt < b.lastActiveAt ? -1 : 1))
    let n = 0
    for (const r of idle) {
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
    if (this.liveAnywhere(sessionId)) throw new SessionInUse('live', withValues(M.stopFirst, { action }))
  }

  /** When Hive saw each session's CLI exit (its own sessions): their transcripts are finished. At most 500, the oldest go. */
  private exitedAt = new Map<string, number>()

  private noteExit(sessionId: string | undefined): void {
    if (!sessionId) return
    this.exitedAt.delete(sessionId)
    this.exitedAt.set(sessionId, Date.now())
    if (this.exitedAt.size > 500) this.exitedAt.delete(this.exitedAt.keys().next().value!)
  }

  /**
   * Why a session's files can't be archived or deleted now, or null. Run with the session reserved, so no read,
   * resume or other move can start after it: it is running or starting (in any window); Hive is reading its transcript
   * (a search, an export, the viewer loading it); its transcript is open in a Sessions view, in any window (the window
   * asking closes its own first, and says so); another program holds the CLI's transcript open (checked by opening it to
   * read, never changing it); or (`writing`) its CLI is still writing it: changed in the last SESSION_WRITING_MS and
   * not since Hive saw that CLI exit (a session started outside Hive, or a Codex guardian review, still going). A copy
   * of Hive's another program holds is found when it is moved (inUseOnFail).
   */
  private async inUse(projectPath: string, sessionId: string, opts: { writing: boolean }): Promise<SessionInUse | null> {
    if (this.liveAnywhere(sessionId)) return new SessionInUse('live', msg({ id: 'session.inUse.running', defaultMessage: 'It is running. Stop it first.', description: 'A session is left alone (archive, delete): it is running.' }))
    if (beingRead(projectPath, sessionId)) return new SessionInUse('reading', msg({ id: 'session.inUse.reading', defaultMessage: 'Hive is reading its transcript (an export or a search). Try again in a moment.', description: "A session is left alone (archive, delete) for a moment: Hive is reading its transcript." }))
    if (viewingWindows(projectPath, sessionId).length) return new SessionInUse('open', msg({ id: 'session.inUse.open', defaultMessage: 'Its transcript is open in Hive. Close it, then try again.', description: "A session is left alone (archive, delete): its transcript is open in Hive's Sessions tab." }))
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
    // Unarchiving moves only Hive's copy back: the CLI still writing its own transcript doesn't matter to it.
    const why = await this.inUse(projectPath, sessionId, { writing: action !== 'unarchive' })
    if (why?.reason === 'live') throw new SessionInUse('live', withValues(M.stopFirst, { action }))
    if (why) throw why
  }

  /**
   * Archives, unarchives or deletes several sessions (a branch of the Sessions tab). Each is all or nothing, with the
   * same checks as one at a time; those in use, running, open in another window or started outside Hive (nothing of
   * Hive's to archive) are skipped and listed with why. The CLIs' own transcripts are never touched.
   */
  async bulk(projectPath: string, action: SessionBulkAction, sessionIds: string[]): Promise<SessionBulkResult> {
    projectPath = workspace.assertSessionHost(projectPath)
    // i18n-ignore: refusals no person sees (the window sends only these)
    if (action !== 'archive' && action !== 'unarchive' && action !== 'delete') throw new Error(`Unknown action: ${String(action)}`)
    if (!Array.isArray(sessionIds)) throw new Error('sessionIds: a list of session ids') // i18n-ignore: a refusal no person sees (the window sends a list)
    const out: SessionBulkResult = { done: [], skipped: [] }
    for (const id of [...new Set(sessionIds)]) {
      if (!isSessionId(id)) {
        out.skipped.push({ id: String(id), reason: 'failed', message: tr(msg({ id: 'session.bulk.notAnId', defaultMessage: 'Not a session id.', description: "Why a session was left alone by Archive or Delete in the Sessions tab: its id isn't one." })) }) // i18n-ignore: a reason's key
        continue
      }
      try {
        if (action === 'delete') await this.deleteOne(projectPath, id)
        else if (!(await workspace.sessionsFile(projectPath)).sessions.some((s) => s.id === id)) {
          out.skipped.push({ id, reason: 'external' }) // i18n-ignore: a reason's key, which the window words
          continue
        } else await this.archive(projectPath, id, action === 'archive')
        out.done.push(id)
      } catch (e) {
        // A failure's message in the window's language: bulk is the window's (session:bulk).
        out.skipped.push(e instanceof SessionInUse ? { id, reason: e.reason } : { id, reason: 'failed', message: shownError(e) }) // i18n-ignore: a reason's key
      }
    }
    log.info(`Sessions: ${action} ${out.done.length}, skipped ${out.skipped.length} (${[...new Set(out.skipped.map((s) => s.reason))].join(', ') || 'none'}) in ${userText(projectPath)}`)
    workspaceOf(projectPath).scheduleRefresh()
    return out
  }

  /** Hive's copies of a session's transcript that exist (the active backup, the archived one). */
  backupFiles(projectPath: string, sessionId: string): string[] {
    return [false, true].flatMap((archived) => [this.backupPath(projectPath, sessionId, archived), this.backupPath(projectPath, sessionId, archived) + GZ]).filter((b) => existsSync(b))
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
    if (this.cleaning.has(k)) throw hiveError(msg({ id: 'session.cleanUp.already', defaultMessage: "Clean Up is already removing this session's files.", description: 'Clean Up… is refused for a session: it is removing its files already.' }))
    if (this.sessionOpen(projectPath, sessionId)) throw hiveError(M.sessionRunning)
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
      if (this.liveAnywhere(sessionId)) throw new SessionInUse('live', msg({ id: 'session.inUse.attaching', defaultMessage: 'It is running, and may attach more files. Stop it first.', description: "Removing a session's attachments is refused: it is running." }))
      return fn()
    })
  }

  /** Runs fn (an archive or delete) with the session reserved, as whileCleaning; one already reserved is in use. */
  private async whileReserved<T>(projectPath: string, sessionId: string, fn: () => Promise<T>): Promise<T> {
    const k = `${projectPath.toLowerCase()}|${sessionId.toLowerCase()}`
    if (this.cleaning.has(k)) throw new SessionInUse('in-use', msg({ id: 'session.inUse.reserved', defaultMessage: 'Hive is already archiving, deleting or cleaning up this session.', description: 'A session is left alone (archive, delete) for a moment: Hive is moving or removing its files already.' }))
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
    if (!rec?.archived) throw hiveError(msg({ id: 'session.cleanUp.unarchived', defaultMessage: 'The session is no longer archived.', description: 'Clean Up… left a session alone: it was unarchived since the preview.' }))
    if (this.sessionOpen(projectPath, sessionId)) throw hiveError(M.sessionRunning)
    const want = new Set(expected.map((e) => e.toLowerCase()))
    const has = this.backupFiles(projectPath, sessionId).map((b) => b.toLowerCase())
    if (has.length !== want.size || !has.every((b) => want.has(b))) throw hiveError(msg({ id: 'session.cleanUp.changed', defaultMessage: "The session's copies changed since the preview.", description: "Clean Up… left a session alone: Hive's copies of its transcript changed since the preview." }))
  }

  /**
   * Moves Hive's backups of an archived session the CLI still has to the Recycle Bin (Clean Up…), what it used recorded
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
        if (!(await this.providerTranscript(projectPath, sessionId))) throw hiveError(msg({ id: 'session.cleanUp.cliGone', defaultMessage: "The CLI no longer has this session's transcript.", description: "Clean Up… kept a session's backups: the coding agent's own transcript is gone since the preview." }))
        if (!(await usageHistory.recordNow(projectPath, sessionId).catch(() => false))) throw hiveError(msg({ id: 'session.cleanUp.unreadBackups', defaultMessage: "Hive couldn't read what the session used, so its backups are kept.", description: "Clean Up… kept a session's backups: Hive couldn't read its usage, which the project's totals keep." }))
        await this.assertCleanable(projectPath, sessionId, expected)
        for (const b of this.backupFiles(projectPath, sessionId)) await trash(b)
      })
    )
    log.info(`Clean Up: removed the backups of session ${sessionId} in ${userText(projectPath)}`)
  }

  /**
   * Purge… (#1138): removes what Hive keeps of one of its sessions as the preview listed it (`listed`: its backups,
   * leftovers of them, its attachments folder, the old usage on its record). The session is reserved (nothing resumes it
   * meanwhile) with its backups locked, and checked again just before anything goes: not running or starting, its
   * transcript not being read by Hive (nor shown, when its last copy goes), and its copies exactly those listed. What it used is recorded in the usage
   * history first, so totals don't change. Backups that are its last copy (`lastCopy`: the CLI no longer has its
   * transcript, checked again) go with its record, all or nothing, as Delete does. `remove` removes a file (to the
   * Recycle Bin, or for good); `attachments` its listed attachments; `unchanged` throws when a listed file changed since. The CLI's own files are never touched.
   */
  async purge(projectPath: string, sessionId: string, listed: { backups: string[]; leftovers: string[]; attachments: boolean; keptUsage: boolean; lastCopy: boolean }, remove: (file: string) => Promise<void>, attachments: () => Promise<void>, unchanged?: () => Promise<void>): Promise<{ deleted: boolean }> {
    assertSessionId(sessionId)
    const check = async (): Promise<void> => {
      if (this.liveAnywhere(sessionId)) throw new SessionInUse('live', msg({ id: 'session.purge.running', defaultMessage: 'It is running.', description: 'Purge left a session alone: it is running (or starting) now.' }))
      if (beingRead(projectPath, sessionId)) throw new SessionInUse('reading', msg({ id: 'session.purge.reading', defaultMessage: 'Hive is reading its transcript (an export or a search). Try again in a moment.', description: 'Purge left a session alone for a moment: Hive is reading its transcript.' }))
      // A view reads the CLI's transcript while the CLI has it: only a last copy going takes what it shows.
      if (listed.lastCopy && viewingWindows(projectPath, sessionId).length) throw new SessionInUse('open', msg({ id: 'session.purge.open', defaultMessage: 'Its transcript is open in Hive. Close it, then try again.', description: "Purge left a session alone: its transcript is open in Hive's Sessions tab." }))
      const rec = (await workspace.sessionsFile(projectPath)).sessions.find((s) => s.id === sessionId)
      if (!rec) throw hiveError(msg({ id: 'session.purge.gone', defaultMessage: 'The session is no longer in Hive.', description: 'Purge left a session alone: it was deleted since the preview.' }))
      const want = new Set(listed.backups.map((b) => b.toLowerCase()))
      const has = this.backupFiles(projectPath, sessionId).map((b) => b.toLowerCase())
      if (want.size && (has.length !== want.size || !has.every((b) => want.has(b)))) throw hiveError(msg({ id: 'session.purge.changed', defaultMessage: "The session's copies changed since the preview.", description: "Purge left a session alone: Hive's copies of its transcript changed since the preview." }))
    }
    const deleted = await this.whileCleaning(projectPath, sessionId, () =>
      this.withBackupsLocked(projectPath, sessionId, async () => {
        await check()
        if (listed.backups.length && !!(await this.providerTranscript(projectPath, sessionId).catch(() => null)) === listed.lastCopy) {
          throw hiveError(listed.lastCopy ? msg({ id: 'session.purge.cliBack', defaultMessage: "The CLI has this session's transcript again.", description: "Purge left a session alone: the coding agent's own transcript is back since the preview, so Hive's backups are no longer its last copy." }) : msg({ id: 'session.purge.cliGone', defaultMessage: "The CLI no longer has this session's transcript.", description: "Purge left a session alone: the coding agent's own transcript went since the preview, so Hive's backups are now its last copy." }))
        }
        if ((listed.backups.length || listed.keptUsage) && !(await usageHistory.recordNow(projectPath, sessionId).catch(() => false))) {
          throw hiveError(msg({ id: 'session.purge.unread', defaultMessage: "Hive couldn't record what the session used, so it is kept.", description: "Purge left a session alone: Hive couldn't save its usage in the usage history, which the totals keep." }))
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
   * Deletes a session from Hive: its record and Hive's copies of the transcript (to the Recycle Bin). The CLI's
   * own transcript is left alone (Hive doesn't change the CLIs' files), so Hive remembers the id to keep it hidden.
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
   * nothing having it in use (assertFree; running checked again with its copies locked), Hive's copies go to the
   * Recycle Bin and the record goes with trashAllOrNothing: if a copy fails to go, or the record can't be saved, the
   * copies already gone are put back (a copy stays in the Recycle Bin).
   */
  private async deleteOne(projectPath: string, sessionId: string, expected?: string[]): Promise<void> {
    assertSessionId(sessionId)
    const remove = (): Promise<void> =>
      this.withBackupsLocked(projectPath, sessionId, async () => {
        // Clean Up… (a session whose only copies are Hive's): only as the preview listed it, and only once what it used is saved.
        if (expected) {
          await this.assertCleanable(projectPath, sessionId, expected)
          if (await this.providerTranscript(projectPath, sessionId)) throw hiveError(msg({ id: 'session.cleanUp.cliBack', defaultMessage: "The CLI has this session's transcript again.", description: "Clean Up… kept a session: the coding agent's own transcript is back since the preview." }))
        } else await this.assertFree(projectPath, sessionId, 'delete')
        // What it used stays in the project's totals: recorded in the usage history (#1106) before its copies go, where
        // it stays once the record is gone.
        const rec = (await workspace.sessionsFile(projectPath)).sessions.find((s) => s.id === sessionId)
        // Not recorded (the worker ended, a write another Hive held): the session stays, Delete and Clean Up alike.
        const recorded = rec ? await usageHistory.recordNow(projectPath, sessionId).catch(() => false) : true
        if (!recorded) throw hiveError(msg({ id: 'session.cleanUp.unread', defaultMessage: "Hive couldn't read what the session used, so it is kept.", description: "Clean Up… kept a session: Hive couldn't read its usage, which the project's totals keep." }))
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
    for (const a of projectAgents(await workspace.projectConfig(projectPath))) {
      if (a.lastSessionId === sessionId) await workspace.updateAgent(projectPath, a.id, { lastSessionId: undefined }).catch(() => undefined)
    }
  }

  /**
   * Hive's sessions of a host (and deleted ones') with only what totals need, for the Workspace Overview and Performance:
   * their usage from the usage history (#1106), no transcript read. Until the history has imported the host's sessions,
   * what it has so far: a record it hasn't reached yet counts its kept usage, or none (the Overview says the figures
   * are partial meanwhile). Sessions started outside Hive aren't in it.
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
        source: 'hive',
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
      source: 'hive' as const,
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
    // Sessions started outside Hive are kept for the Sessions list, never counted.
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
    const src = await this.providerTranscript(projectPath, sessionId)
    const provider = src?.provider ?? 'claude-code'
    const usage = src ? await this.usageFor(projectPath, src.path, sessionId, provider) : null
    // A sub-session (a Codex guardian review, say) stays one: never an agent's session to resume.
    const sub = src ? (await providerAdapter(provider).listSessions(projectPath).catch(() => [])).find((e) => e.id === sessionId)?.sub : undefined
    await workspace.upsertSession(projectPath, {
      ...(sub ? { sub } : {}),
      id: sessionId,
      agent: provider,
      name: usage?.title ?? `Adopted session ${sessionId.slice(0, 8)}`, // i18n-ignore: a session's stored name, which agents read and the user can rename
      titleAtRename: usage?.customTitle ?? null,
      createdAt: usage?.firstActivity ?? new Date().toISOString(),
      lastActiveAt: usage?.lastActivity ?? new Date().toISOString(),
      ...(src && !providerDescriptor(provider).capabilities.fixedSessionId ? { transcriptPath: src.path } : {})
    })
    if (src && config.settings.sessions.backupTranscripts) await syncCopy(src.path, this.backupPath(projectPath, sessionId)).catch(() => undefined)
  }
}

export const sessions = new SessionManager()
onLanguageChange(() => sessions.relabel())
