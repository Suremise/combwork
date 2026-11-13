import http, { type IncomingMessage, type ServerResponse } from 'http'
import { AsyncLocalStorage } from 'async_hooks'
import { randomBytes, timingSafeEqual } from 'crypto'
import { app } from 'electron'
import { basename, dirname, join, resolve as resolvePath } from 'path'
import { attachableSource, cardAttachments, cardHost, checkBatch, readCardAttachment, stage as stageFiles, type AttachCaller } from './cardAttachments'
import { withAttachmentPaths, type CardAttachment } from '../shared/cardAttachments'
import { existsSync } from 'original-fs'
import { stat } from 'original-fs/promises'
import { LISTEN_RETRY_BOUND_MS, listenWithRetry } from './listenRetry'
import type { AgentApiInfo, AgentDef, AgentInfo, Connection, ConnectionLaunch, AssistantControl, AssistantUndoResult, LaneInfo, EffortLevel, CombworkEvent, LiveSessionState, McpServerInfo, PermissionMode, ProgressRun, ProjectConfig, ProviderId, SkillInfo, TaskCard, TaskColumn, TaskComment, TaskPatch, TaskStartTarget, ToastLevel, ToastMessage, ToastTarget, WorkspaceConnections } from '../shared/types'
import { callsMade } from '../shared/activity'
import { DEFAULT_API_PORT, CW_DIR, projectAgents, stopAsksUser, transcriptWarnLimit } from '../shared/defaults'
import { PROVIDERS, agentProvider, isProviderEnabled, offeredModes, providerDescriptor, providerName } from '../shared/providers'
import type { SafeguardNote } from '../shared/safeguards'
import { agentChoosesMcp, agentGetsMcp, cleanMcpServers, serverOnIn } from '../shared/agentMcp'
import { publicReason, UNDO_FINAL, type ActivityAgent, type ActivityKind, type ActivityTarget } from '../shared/assistantActivity'
import { branchChange, changeGroups, noteAgent, noteChange, recordedHere, recordingChanges } from './assistantChanges'
import { undoChanges, UndoNotFound } from './assistantUndo'
import { cardAgent, knownAgent } from './activityTargets'
import { routePattern } from './routePattern'
import { fallbackEfforts, infoAt, listedConnections, offeredModels } from '../shared/models'
import { agentRuntime, hooksMissingText, retryWaitText, unknownStateText } from '../shared/runtime'
import { ASSISTANT_AGENT_ID, ASSISTANT_DIR, ASSISTANT_NAME } from '../shared/assistant'
import { timeLeft } from '../shared/progress'
import { ProgressError, admitReport, type ProgressCaller } from './progress'
import { progress, progressGate } from './progressService'
import { cardOfRef, isCardRef, keysForSearch, withCardNames } from './projectKeys'
import { admitLinked, commitIn, folderHead, IssuedLinks, linkOwner, publicLink, resolveRunLink, type RunLink, type RunLinkDeps } from './workflow/runLink'
import { assignIsolated, copiesFor, copyAt, isolatedLinked, isolatedRequest, isolatedRunEnded, takeStopped } from './copiesApp'
import { reviewCopyOnStart, reviewCopyOnVerdict } from './reviewCopies'
import { COLUMN_CHOICES, columnLabel, commentSummary, isTaskColumn, reviewStalled } from '../shared/tasks'
import type { HandoverAuthor } from '../shared/combworkGuidance'
import { inDefaultDialect, inRequestScope } from '../shared/agentText/asyncScope'
import { apiChainReady, inApiWorkspace, requestApiWorkspace } from './dialects/apiChain'
import { isSaid, say, sayWithId, type AgentMsg, type AgentValues, type Said as SaidText } from '../shared/agentText'
import { API } from './apiText'
import { cardRequests, commentsParam, laneOrderNote, modelInUse, newestComments, progressLabel, retryWaitsView, taskRow, withoutHistory, type CardRequest, type IntentDone, type ProjectRow, type SkillRow, type TaskBatch, type TaskChange, type TaskReorder, type TaskView, type AccountUsagePublic } from '../shared/toolReplies'
import * as assistant from './assistantControl'
import { STOP_ASK_MS } from './mcp/agentApiCall'
import { SettingRefused, applySetting, checkedValue, entryOf, projectOf, restartText, settingDetail, settingRows } from './settingsTools'
import { agentTitle, settingChangeTexts, settingPath, settingReadOnly, type SettingEntry, type SettingScope } from '../shared/settingsCatalog'
import { addAgent, updateAgent } from './projectAgents'
import { DOC_MAX, SHARED_PREFIX, readDoc } from './docSections'
import { docOutline, findHeading, sectionText, type DocHeading } from '../shared/docSections'
import { providerService } from './providerService'
import { agentInstallInfo } from './providers/common'
import { config } from './config'
import { refusal, refusalBody } from '../shared/workflow/refusals'
import { ACCEPT_MAX, testsGiven, validTestId, type FocusedTest } from '../shared/workflow/focused'
import { askAssistant, AskRefused } from './assistantAsk'
import { agentWorkflowRole, isWorkflowRole, workflowPairs, type WorkflowRole } from '../shared/workflow/roles'
import { deleteEntry, JournalBusy, JournalError, readEntry, recall, updateEntry, writeEntry } from './journal'
import { journalSettingsOf, journalSuggestion } from './journalService'
import { recordBuild } from './buildFacts'
import { buildFactOf } from '../shared/buildFacts'
import type { JournalSettings } from '../shared/journal'
import { emit, onCombworkEvent, toast } from './events'
import { msg, tr } from '../shared/i18n'
import { addUsageToWatch, cancelWatch, encodeSince, onWatchPlacing, registerAgentWatch, registerLaneWatch, registerUsageWatch, registerWatch, scopedCard } from './watches'
import { USAGE_WATCH_MAX, type UsageWatch } from '../shared/usageWatch'
import { readLaneCards, readLaneCondition } from '../shared/laneWatch'
import { agentBusy, AGENT_WATCH_MAX_AGENTS, type AgentNow, type WatchedAgent } from '../shared/agentWatch'
import { alreadyThere, cardChange, cardOver, changesBetween, decodeSince, handoffsSince, markOf, movedIntoSince, readCondition, WATCH_DEFAULT_LIMIT_MINUTES, WATCH_MAX_LIMIT_MINUTES, type CardChange, type CardMark } from '../shared/watch'
import { advanced, waitMaxSeconds } from './advanced'
import { titleNudge } from './titleNudge'
import { insideReal, placeMatcher, placeRelative, readCapped, readJson, samePlace, writeJsonAtomic } from './fsutil'
import { GUIDANCE_REVISION, skillRevisions } from './guidance'
import agentApiDoc from '../../docs/AGENT_API.md?raw'
import { createLogger } from './logger'
import { listMcp } from './mcp'
import { assertInShared, createHandover, handoversFor, NoteConflict, notesTree, readNote, writeNote } from './notes'
import { mergeSlots, slotTestEvent } from './mergeSlotHost'
import * as lanes from './lanes'
import { checkLanePool, launchRecordedLane, recordedLaneNote, resumeLaneBuilder, retryFreshStart } from './laneStart'
import { LANE_BRIEF_MAX, laneCards, laneName, laneNumber, laneStateText, type LaneChange } from '../shared/lanes'
import { briefNote, settleLaneBriefs } from './laneBriefs'
import { DEFAULT_WAIT_MS, MAX_WAIT_MS, MergeSlotError, slotBranch, slotCards, type SlotAgent } from './mergeSlots'
import { clashingNumber, watchWhilePlaced } from './watchGuards'
import { writePty } from './ptyHost'
import { isResuming } from './restartResume'
import { sessions, type HookObservation } from './sessions'
import { agentPlace, folderFacts } from './agentFolders'
import { releasableSlots, releaseSlot, SlotReleaseRefused, type HeldRow } from './slotRelease'
import { applyForAssistant, findTemplate, loadForAssistant, planReply, templateRows } from './templateApi'
import { slotAt } from '../shared/agentFolders'
import { agentNowOf, cardStall, laneOrderView, reviewDueOf, stepWaitOf, type StallAgent } from './cardStall'
import { forwardWaitOf } from './queueReturn'
import { cancelMessages, leaveMessage, MESSAGE_MAX_CHARS } from './agentMessages'
import { giveUnseen } from './cardFreshness'
import { ackCardTask, ackDeliveries, ackThenRead, onCardTaskReceived, deliveriesOf, deliverNow, deliveryView, inboxSwitch, launchWith, NotGiven, readInbox } from './deliveries'
import { INBOX_SWITCHES, type InboxSwitch } from '../shared/inboxSwitches'
import { isDoorbell } from '../shared/doorbell'
import type { DeliverySender, InboxItem } from '../shared/deliveries'
import * as tasks from './tasks'
import { runCardIntent, type CardIntent, type CardRefIn } from './cardIntents'
import { armIntentWatch } from './intentWatch'
import { offeredItems, offeredRetarget, offerRetarget, retargetApply, retargetPreview } from './workflow/retarget'
import { NextVersionPartial, startNextVersion } from './workflow/nextVersion'
import { cardTargetSaid } from './cardTargetReply'
import { withRepoLock } from './repoLock'
import type { NextVersionResult } from '../shared/types'
import { lineRepoOps } from './platform/repoOpsPorts'
import { branchStartArg } from '../shared/nextVersion'
import type { Value } from './assistantChanges'
import { ForwardRefused, forwardMerge, pauseQueue, queueCardChange, queueViews, resolveForward, resumeQueue } from './workflow/queueControls'
import type { QueuePublic, QueueView } from '../shared/workflow/queue'
import * as taskBatch from './taskBatch'
import { startTask } from './taskStart'
import { combworkSkills, listSkills, skillFiles, validSkillName } from './skills'
import { transcripts } from './transcripts'
import { contextWorkspace, inWorkspace, openWorkspaces, workspace, workspaceFor, workspaceOf, type WorkspaceService } from './workspace'
import { accountOnIn, connectionRef, connectionsFor, connectionsOn, usableConnections, workspaceAccounts, type ConnectionPatch } from '../shared/accounts'
import { accountById, addConnection, allAccounts, allConnections, connectionProblem, firstUsableAccount, getConnection, combworkAccounts, updateConnection } from './accounts'
import { changeConnection } from './connectionLaunch'
import { cleanLaunch, policySummary, terminalPreset } from '../shared/launchPolicy'
import { workspaceNotesFile } from './workspaceNotes'
import { WORKSPACE_NOTES_PATH } from '../shared/workspaceNotes'
import { cardStages } from './boardStore'
import { cardFacts, cardKind, cardReviewSkip, cardTarget, factRow, forYouOfCards } from './workflow/cardWork'
import type { ForYouItem } from '../shared/workflow/workView'
import { bracketFinished, bracketFor, bracketResolved, bracketStarted, cardRunRevision, takeResolved, type Bracket, type Recorded } from './workflow/runChecks'
import { workflowSummary } from './workflow/optionsForm'
import { detect, initialOf, platformIdOf } from './platform/registry'
import { hasCapability, revisionShort, type PlatformId, type ProjectPlatform } from '../shared/platform/descriptors'
import { ASK_ACTIONS, ASK_ACTIONS_MAX, CATEGORY_STAGE, LOOP_STEPS, type AskAction, type ForYouKind } from '../shared/workflow/facts'
import { lastCardRead, newDecisions, noteCardRead, noticeText } from './decisionNotices'
import { actorOf, recordDecisionsReceived } from './workflow/recorder'
import { workflowFor } from './workflow/service'
import { unsubmittedOf } from './unsubmitted'
import { idleOwnWatchOf } from './idleWatch'
import { apiOutcome, appMetrics, clock as metricsClock, knownRoute, metricsHandle, reasonOf, recordApi, recordCatalog, recordMcp, MCP_REPORT_LIMITS, type MetricsHandle } from './metrics'
import { metricsReport } from './metricsUsage'
import { apiLabel, beginWork, hookLabel } from './mainStalls'
import type { GuidanceSeries, MetricOutcome, MetricsPart, MetricsQuery, MetricsReport } from '../shared/metrics'
import { agentForToken, agentToken, agentTokenFile, onAgentTokenEnded, type AgentIdentity, type EndedLaunch } from './agentTokens'
import { API_EVENTS, apiEventFor, publicRun } from './apiEvents'
import { clearDiscovery, writeDiscovery } from './apiDiscovery'
import { createViewerToken, loadViewerTokens, revokeViewerToken, viewerForToken, viewerTokens } from './viewerTokens'
import { hookTokenMatches, refusedHookNote, runForHookToken } from './hookTokens'
import { answering, carrying, claimTwin, hasContext, type TwinEntry } from './hookTwins'
import { fixedHookUrl, type ClaudeSnippetFacts } from '../shared/claudeHookHandlers'
import { launchHookTimeouts } from './providers/claude/adapter'
import { unusedWorktreeCounts } from './unusedWorktrees'
import { devConsole, combworkSourceId, sessionSourceId } from './devConsole'
import { consoleSources } from './devConsoleSources'
import { agentError, CombworkError, SaidError, shownError } from './combworkError'
import { KindedError } from '../shared/kindedError'
import { agentField, agentText, type TextPart } from '../shared/advanced'
import { storedForAgents } from '../shared/taskHistory'
import { CONSOLE_KINDS, combworkName, mayRead, type ConsoleEvent, type ConsoleKind, type ConsoleReader, type ConsoleSource } from '../shared/devConsole'
import { cardLabel, cardName, cardRef, namesOf } from '../shared/projectKeys'
import { pauseTeam, resumeTeam } from './teamPause'
import { scanWorkspace } from './teamParked'

const log = createLogger('servers')
const MAX_BODY = 2 * 1024 * 1024

function tokenMatches(header: string | undefined, token: string): boolean {
  const got = Buffer.from((header ?? '').replace(/^Bearer\s+/i, ''))
  const want = Buffer.from(token)
  return got.length === want.length && timingSafeEqual(got, want)
}

/** A request's body as text. `onChunk` hears each chunk's bytes as they arrive (a partial or refused body too). */
function readBody(req: IncomingMessage, onChunk?: (bytes: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      onChunk?.(c.length)
      if (size > MAX_BODY) {
        reject(new HttpError(413, apiSaid(API.http.bodyTooLarge)))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** An agent message said for an error reply, with its id kept beside the text (HI-2681): what Performance records as its reason. */
type ApiSaid = SaidText
const apiSaid = (m: AgentMsg, values?: AgentValues): ApiSaid => sayWithId(m, values)

class HttpError extends Error {
  /** The agent message it says, by id (HI-2681, metrics.ts reasonOf): never its text. */
  public saidId?: string
  constructor(
    public status: number,
    message: string | ApiSaid,
    /** More of the reply's body, beside `error` (a conflict's current revision). */
    public extra?: Record<string, unknown>,
    /** The text of the CombworkError it answers (httpFrom), said in the request's dialect (dialects, HI-2440). */
    public text?: TextPart
  ) {
    super(typeof message === 'string' ? message : message.said)
    if (typeof message !== 'string') this.saidId = message.id
  }
}

/** An error answered with another status: its message, and a CombworkError's text, so the reply says it in the caller's dialect. */
const httpFrom = (status: number, e: unknown, extra?: Record<string, unknown>): HttpError => {
  const h = new HttpError(status, (e as Error).message, extra, e instanceof CombworkError ? e.text : undefined)
  // An agent message's id (HI-2691, combworkError.ts SaidError): Performance's reason for it, the status still this one.
  if (e instanceof SaidError) h.saidId = e.saidId
  return h
}

/** A reply's body as sent: its JSON as it is, whatever names its data uses (a console event's raw payload, #845). */
export const replyText = (body: unknown): string => (body === undefined ? '' : JSON.stringify(body))

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = replyText(body)
  const m = apiRequests.get(res)
  if (m) m.responseBytes = Buffer.byteLength(text, 'utf8')
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers })
  res.end(text)
}

// ---------------------------------------------------------------------------
// Hook server: receives the agents' CLI hooks. Random port; ?run=<runId> names the launch, whose own token it needs. With
// no run named, the token tells it (HI-2777). Claude Code's hooks post to the fixed hook URL on the Agent API's port
// (serveFixedHook), where only the token tells the run.
// ---------------------------------------------------------------------------

let hookServer: http.Server | null = null

/** How long a duplicate delivery waits for its first one's reply, or for the response carrying its context (HI-2777). */
const TWIN_WAIT_MS = 15_000

/** Whether the fixed hook URL's ignored calls were logged (once a run of Combwork). */
let ignoredTold = false

/**
 * The fixed hook URL (HI-2777): `POST /hook` on the Agent API's port, the run told only by its hook token. A call with no
 * token of a running launch of this Combwork (another Claude Code session on the PC, the other build's, an ended launch's)
 * is answered 200 `{}` and nothing else happens: refusing it would show every session that isn't Combwork's a hook error.
 * Never with a run named in the URL, never for an Agent API or viewer token.
 */
async function serveFixedHook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // agent-protocol: the hook server answers a CLI hook, not an agent
  if (req.method !== 'POST') return send(res, 404, { error: 'not found' })
  const run = runForHookToken(req.headers.authorization)
  if (!run) {
    await readBody(req).catch(() => '')
    if (!ignoredTold) {
      ignoredTold = true
      log.info("Ignored a call to the fixed hook URL that carried no hook token of a running launch (another Claude Code session's, or the other build's)")
    }
    if (!res.headersSent) send(res, 200, {})
    return
  }
  return serveHook(req, res, run)
}

export async function startHookServer(): Promise<string> {
  hookServer = http.createServer(async (req, res) => {
    // agent-protocol: the hook server answers a CLI hook, not an agent
    if (req.method !== 'POST' || !req.url?.startsWith('/hook')) return send(res, 404, { error: 'not found' })
    const query = new URL(req.url, 'http://127.0.0.1').searchParams
    const named = query.get('run')
    // No run named: its token tells it (HI-2777: Claude Code's hooks when the Agent API isn't listening).
    const run = named ?? runForHookToken(req.headers.authorization)
    // Only the launch's own token, while it runs (#345).
    if (!hookTokenMatches(run, req.headers.authorization)) {
      // The developer console (#636): a hook refused (an ended launch's, or a wrong token), in every workspace watched.
      // agent-protocol: the developer console's record of a refused hook (a log line)
      devConsole.capture(devConsole.capturedLike('combwork:'), () => ({ kind: 'hook-server', name: 'refused', raw: { statusline: query.has('statusline'), run: !!run }, made: { status: 401 }, summary: `hook refused (${run ? "not this launch's token, or it has ended" : 'no launch named'})` }))
      // In the log too, once a run (#711): a hook the CLI sent but Combwork refused leaves a trace on Combwork's side.
      const note = refusedHookNote(run)
      if (note) log.info(note)
      // agent-protocol: the hook server answers a CLI hook, not an agent
      return send(res, 401, { error: 'unauthorized' })
    }
    return serveHook(req, res, run!)
  })
  await new Promise<void>((resolve) => hookServer!.listen(0, '127.0.0.1', resolve))
  const addr = hookServer.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  sessions.hookUrl = `http://127.0.0.1:${port}/hook`
  sessions.fixedHookUrl = () => (apiServer?.listening ? fixedHookUrl(apiPort()) : null)
  log.info(`Hook server listening on ${sessions.hookUrl}`)
  return sessions.hookUrl
}

/** A hook call of the launch `run`, its token checked: handled in the launch's order, answered with its reply. */
async function serveHook(req: IncomingMessage, res: ServerResponse, run: string): Promise<void> {
  const query = new URL(req.url ?? '/hook', 'http://127.0.0.1').searchParams
  {
    // Tests lose every hook while the file CW_TEST_DROP_HOOKS names is there (#1371: a CLI whose hooks Combwork can't
    // stop at its end, Copilot), answered as if Combwork had taken them; unpackaged builds only.
    const drop = !app.isPackaged ? process.env.CW_TEST_DROP_HOOKS : undefined
    if (drop && existsSync(drop)) {
      await readBody(req).catch(() => '')
      return send(res, 200, {})
    }
    let done: (() => void) | null = null
    // What Combwork observes of it, for the launch's Hooks dialog (HI-982): from here, on its own authenticated route, so
    // a body Combwork can't read is recorded too.
    let obs: HookObservation | null = null
    let step = 'read'
    // Its occurrence's first delivery (HI-2777), whose reply its duplicates are answered from: settled whatever happens.
    let first: TwinEntry | null = null
    try {
      const raw = await readBody(req)
      let body: Record<string, any>
      try {
        body = JSON.parse(raw || '{}')
      } catch (e) {
        obs = query.has('statusline') ? null : sessions.observeHook(run, {})
        throw e
      }
      // A CLI whose hook bodies don't name their event (HI-2545: the Antigravity CLI): its hook command names it in the
      // URL, as Combwork wrote it for the launch. Only a plain event name, and never in place of one the body carries.
      const event = query.get('event')
      if (body && typeof body === 'object' && !Array.isArray(body) && body.hook_event_name === undefined && event && /^[A-Za-z]{1,32}$/.test(event)) body.hook_event_name = event
      done = beginWork(hookLabel(query.has('statusline'), body))
      if (query.has('statusline')) {
        // The reply becomes Claude Code's status line, so send nothing; or, chaining the user's own status line (#1285),
        // the JSON as it came, for their command's input.
        if (query.has('echo')) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(raw)
        } else {
          res.writeHead(204)
          res.end()
        }
        sessions.handleStatusLine(run, body)
        return
      }
      // A hook about to edit files waits for Combwork's file-lock decision (made at once, in the order hooks came); a tool's
      // end and a Stop that may carry a notice wait for their place in the launch's hook order, where the turn ledger
      // decides whose turn they are (#650: a notice of what is unread, or the drain carrying the turn on); other hooks
      // are answered at once so they never slow the agent down. Each is handled in the launch's order from when it came,
      // with its reply: the turn ledger learns what the Stop was told (#648).
      // A delivery of an occurrence already taken (HI-2777: Claude Code ran both Combwork's and a differing admin snippet's
      // handler): answered from the first one's reply, its decision always and its context only if no response carried it.
      // Only a copy, its body the same; of a prompt, only while the first is being answered (HI-2850).
      const claim = claimTwin(run, sessions.hookOccurrence(run, body), body, () => sessions.hooksDoubled(run))
      if (claim?.first) answering(res, claim.entry)
      if (claim && !claim.first) {
        const twin = await claim.entry.twinReply(TWIN_WAIT_MS)
        if (twin.carries) carrying(res, claim.entry)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(twin.reply ?? {}))
        return
      }
      first = claim?.entry ?? null
      obs = sessions.observeHook(run, body)
      step = 'reply'
      const reply = sessions.hookReply(run, body)
      step = 'handle'
      const handled = sessions.handleHook(run, body, reply)
      let failed: { step: string; error: unknown } | undefined
      const answer = await reply.catch((e) => {
        log.warn('hook reply', e)
        failed = { step: 'reply', error: e }
        return null
      })
      if (first) {
        first.computed(answer)
        if (hasContext(answer)) {
          first.sending()
          carrying(res, first)
        }
        first = null
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(answer ?? {}))
      await handled
      if (obs) sessions.hookHandled(obs, answer, failed)
      obs = null
    } catch (e) {
      log.warn('hook error', e)
      if (obs) sessions.hookHandled(obs, null, { step, error: e })
      // agent-protocol: the hook server answers a CLI hook, not an agent
      if (!res.headersSent) send(res, 400, { error: 'bad request' })
    } finally {
      first?.computed(null)
      done?.()
    }
  }
}

// ---------------------------------------------------------------------------
// Agent API: documented REST API for agents and scripts. See docs/AGENT_API.md.
// ---------------------------------------------------------------------------

let apiServer: http.Server | null = null
let apiToken = ''

/**
 * Who made a request: a caller with the Agent API's token (agents' Combwork tools, scripts), which Settings → Agent
 * API governs, or a workspace's Combwork Assistant with its own token, which Settings → Assistant → Control governs.
 */
/** Who is calling: a script with the workspace token, the Assistant, or a project agent (by its own token). */
/** An Assistant caller keeps the token it came with: one launch's, which its later work is checked against (#186). */
/** A viewer (#620) reads and follows like the workspace token and changes nothing: every request but a GET is refused. */
type Caller = { kind: 'api' } | { kind: 'viewer'; id: string; name: string } | { kind: 'assistant'; workspace: string; token: string } | ({ kind: 'agent'; runId: string } & AgentIdentity)
const callerStore = new AsyncLocalStorage<Caller>()

function viewerCaller(): { id: string; name: string } | null {
  const c = callerStore.getStore()
  return c?.kind === 'viewer' ? c : null
}

/** The project agent making the call (known by its token), or null. */
function agentCaller(): AgentIdentity | null {
  const c = callerStore.getStore()
  return c?.kind === 'agent' ? c : null
}

/** The launch a project agent's call comes from (its token's), or null for another caller. */
function agentCallerRun(): string | null {
  const c = callerStore.getStore()
  return c?.kind === 'agent' ? c.runId : null
}

function assistantCaller(): string | null {
  const c = callerStore.getStore()
  return c?.kind === 'assistant' ? c.workspace : null
}

/** The token the Assistant's request came with (its launch's), or null for another caller. */
function assistantCallerToken(): string | null {
  const c = callerStore.getStore()
  return c?.kind === 'assistant' ? c.token : null
}
let apiError: string | undefined
/**
 * Event-stream clients: the project agent each is (null: a script or a viewer, which gets every event) with the launch
 * whose token it came with (`run`), and the viewer token it came with.
 */
/** Each events stream: its agent (null: the workspace token or a viewer); for one with none, the .combwork folder of the workspace its request was for (`apiDir`, HI-2465), whose API chain its lines are said in. */
const sseClients = new Map<ServerResponse, { agent: AgentIdentity | null; apiDir: string | null; run: string | null; viewer: string | null }>()

/** What an Agent API request is measured as (metrics.ts), filled in as it is handled and recorded when it ends. */
interface ApiRequest {
  route: string
  /** The workspace's metrics as they were when the request came in: recorded there, or not at all if it has closed. */
  handle: MetricsHandle | null
  project: string | null
  role: 'agent' | 'assistant' | 'api' | 'viewer' | 'unknown'
  requestBytes: number
  responseBytes: number
  /** Not counted as API traffic: the bridge's own metrics reports, event streams (counted as streams), the health check. */
  skip: boolean
  authenticated: boolean
  /** Answered with a wait (HI-1831: an error status whose body says to ask again): recorded as `waiting`, not a failure. */
  waiting: boolean
  /** A refusal's or a wrong call's reason (HI-2553, metrics.ts reasonOf): its rule's or message's id. */
  reason?: string
  /** The request's workspace, as far as it was known (the developer console's Combwork events). */
  ws: string | null
}
const apiRequests = new WeakMap<ServerResponse, ApiRequest>()

/** How a request ended, for its metrics: an aborted one is cancelled, one answered with a wait waiting, else by its status. */
function outcomeOf(res: ServerResponse, m: ApiRequest): MetricOutcome {
  return apiOutcome({ finished: res.writableFinished, status: res.statusCode, waiting: m.waiting })
}

function tokenFile(): string {
  return join(app.getPath('userData'), 'agent-api.json')
}

async function loadToken(): Promise<string> {
  const saved = await readJson<{ token?: string }>(tokenFile(), {})
  if (saved.token && saved.token.length >= 32) return saved.token
  return regenerateToken()
}

export async function regenerateToken(): Promise<string> {
  apiToken = randomBytes(32).toString('hex')
  await writeJsonAtomic(tokenFile(), { token: apiToken, note: inDefaultDialect(() => say(API.http.tokenFileNote)) })
  return apiToken
}

/** CW_API_PORT overrides the setting; development builds default to the next port so they don't clash with the installed app. */
function apiPort(): number {
  const env = Number(process.env.CW_API_PORT)
  if (env > 0) return env
  const port = config.settings.agentApi.port
  return !app.isPackaged && port === DEFAULT_API_PORT ? port + 1 : port
}

/**
 * What the Claude Code admin snippet is made from (HI-2777): this Combwork's Agent API port, the other build's default
 * one (an installed app's 47821, a development build's 47822) and the hooks' timeouts as Settings → Advanced has them,
 * so a snippet made now matches the handlers Combwork's launches pass.
 */
export function claudeSnippetFacts(): ClaudeSnippetFacts {
  const port = apiPort()
  const other = app.isPackaged ? DEFAULT_API_PORT + 1 : DEFAULT_API_PORT
  return { port, otherPort: other === port ? null : other, packaged: app.isPackaged, listening: !!apiServer?.listening, timeouts: launchHookTimeouts() }
}

export function apiInfo(): AgentApiInfo {
  const s = config.settings.agentApi
  // With the Agent API off, the server still runs for the Combwork Assistant alone.
  const running = s.enabled && !!apiServer?.listening
  return {
    enabled: s.enabled,
    running,
    url: running ? `http://127.0.0.1:${apiPort()}` : null,
    token: apiToken,
    error: apiError,
    viewers: viewerTokens()
  }
}

/** The server's address for the Combwork Assistant, which reaches it whether or not the Agent API is turned on. */
export function assistantApiUrl(): string | null {
  return apiServer?.listening ? `http://127.0.0.1:${apiPort()}` : null
}

/**
 * Environment passed to an agent's session so it (and its Combwork tools) can reach the API: the file holding the agent's
 * own token for this launch (agentTokens.ts), never the workspace's, so the API knows which project's agent is calling.
 * Never the token itself (HI-2262, Darren's decision): an agent listing its environment printed it (HI-2259).
 */
export function apiEnv(projectPath: string, agentId: string): Record<string, string> {
  const info = apiInfo()
  const token = agentToken(projectPath, agentId)
  if (!info.running || !info.url || !token) return {}
  // How long cw-progress waits for the API's answers (HI-1892: Settings → Advanced, its reply time).
  return { CW_API_URL: info.url, CW_API_TOKEN_FILE: agentTokenFile(projectPath, agentId),CW_PROGRESS_REPLY_SECONDS: String(advanced.number('cw.progress.replySeconds')) }
}

/** An open workspace by its folder path or its name. A name two open workspaces share is refused (409): use the path. */
export function findWorkspace(want: string): WorkspaceService | null {
  const v = want.toLowerCase()
  // By path, the same place by any other name: a junction, an 8.3 short name (#494).
  const at = /[\\/]/.test(want) ? placeMatcher(resolvePath(want)) : null
  const hits = openWorkspaces().filter((w) => (at ? at(w.path!) : basename(w.path!).toLowerCase() === v))
  if (hits.length > 1) {
    throw new HttpError(409, apiSaid(API.workspace.severalNamed, { name: want, paths: hits.map((w) => w.path).join(', ') }))
  }
  return hits[0] ?? null
}

/** The workspace a request names (X-Combwork-Workspace header, or ?workspace=), else the only open one. */
function requestWorkspace(req: IncomingMessage, url: URL): WorkspaceService | null {
  const own = assistantCaller()
  if (own) {
    const w = openWorkspaces().find((x) => x.path!.toLowerCase() === own)
    if (!w) throw new HttpError(409, apiSaid(API.workspace.assistantNotOpen))
    return w
  }
  // An agent's calls are about its own workspace, whatever the request names.
  const agent = agentCaller()
  if (agent) {
    const w = openWorkspaces().find((x) => x.path!.toLowerCase() === agent.workspace.toLowerCase())
    if (!w) throw new HttpError(409, apiSaid(API.workspace.agentNotOpen))
    return w
  }
  const header = req.headers['x-combwork-workspace']
  const raw = typeof header === 'string' && header ? decodeURIComponent(header) : url.searchParams.get('workspace')
  if (raw) {
    const w = findWorkspace(raw)
    if (!w) throw new HttpError(404, apiSaid(API.workspace.unknown, { name: raw }))
    return w
  }
  const open = openWorkspaces()
  return open.length === 1 ? open[0] : null
}

/** The workspace's project keys, current and old, for a title naming a card (HI-2061). */
const titleKeys = (): string[] => keysForSearch(requireWorkspace()).flatMap((k) => [k.key, ...k.aliases])

/** The request's workspace, for calls about a whole workspace (shared notes, MCP servers…). */
function requireWorkspace(): WorkspaceService {
  const w = contextWorkspace()
  if (w) return w
  if (!openWorkspaces().length) throw new HttpError(409, apiSaid(API.workspace.noneOpen))
  throw new HttpError(400, apiSaid(API.workspace.sayWhich))
}

/**
 * A project by name: "<project>" in the request's workspace (or, with none named, in whichever open
 * workspace has it: 409 if several do), or "<workspace>/<project>" (encoded as %2F in a URL path).
 */
function projectByName(name: string): string {
  const raw = decodeURIComponent(name)
  if (!openWorkspaces().length) throw new HttpError(409, apiSaid(API.workspace.noneOpen))
  const slash = raw.search(/[\\/]/)
  let project = raw
  let candidates: WorkspaceService[]
  if (slash > 0) {
    const w = findWorkspace(raw.slice(0, slash))
    if (!w) throw new HttpError(404, apiSaid(API.workspace.unknown, { name: raw.slice(0, slash) }))
    candidates = [w]
    project = raw.slice(slash + 1)
  } else {
    const ctx = contextWorkspace()
    candidates = ctx ? [ctx] : openWorkspaces()
  }
  const own = assistantCaller()
  // The Assistant looks after its own workspace only.
  if (own) candidates = candidates.filter((w) => w.path!.toLowerCase() === own)
  const hits = candidates.map((w) => join(w.path!, project)).filter((p) => workspace.isProjectPath(p))
  if (!hits.length) throw new HttpError(404, apiSaid(API.workspace.unknownProject, { name: raw }))
  if (hits.length > 1) throw new HttpError(409, apiSaid(API.workspace.projectInSeveral, { project, workspace: basename(dirname(hits[0])) }))
  return hits[0]
}

/** A watching agent's watch, as every status reply gives it (small: what for and until when); undefined otherwise. */
const watchingOf = (live: LiveSessionState | null | undefined) =>
  live?.status === 'watching' && live.watch ? { cards: live.watch.cards, ...(live.watch.agents ? { agents: live.watch.agents } : {}), ...(live.watch.column ? { column: live.watch.column } : {}), changes: live.watch.changes, label: live.watch.label, limitAt: live.watch.limitAt } : undefined
/** An agent's open progress run, as status replies give it (small: what, how far, what it waits for, time left); undefined without one. */
function progressOf(projectPath: string, agentId: string) {
  const r = progress.openRunOf(projectPath, agentId)
  if (!r) return undefined
  const etaMs = timeLeft(r, Date.now())
  return { title: r.title, ...(r.total !== null ? { step: r.step ?? 0, total: r.total } : {}), ...(r.stepName ? { stepName: r.stepName } : {}), ...(r.waiting ? { waiting: r.waiting } : {}), ...(etaMs !== null ? { etaMs } : {}), ...(r.state === 'stale' ? { stale: true } : {}) }
}

/**
 * What of Combwork's an agent launches with (HI-2670), in short; null: everything. Its connection's, or, Independent, as
 * from a terminal whatever its connection says (HI-2731).
 */
const launchSummaryOf = (a: AgentInfo): string | null => {
  const c = getConnection(a.connection)
  const cli = accountById(c?.account)?.provider ?? a.provider
  // Its own role (one a tools-off connection makes Independent launches as that connection says).
  if (cli && a.workflowRole === 'independent') return policySummary({ launch: terminalPreset(cli) }, cli)
  return c && cli ? policySummary(c, cli) : null
}

/**
 * An agent's status message: a watching agent's is what it waits for; one whose state is unknown says so (#648), as
 * does one whose hooks aren't reaching Combwork (#1336) and one whose CLI waits to retry its model request (HI-1972).
 */
const statusMessageOf = (live: LiveSessionState | null | undefined): string | null =>
  live?.hooksMissing
    ? say(API.status.hooksMissing, { state: hooksMissingText(live) ?? '' })
    : live?.status === 'watching'
    ? (live.watch?.label ?? null)
    : live?.status === 'signin'
      ? say(API.status.signInExpired, { reason: agentField(live.signIn?.message, live.signIn?.messageText) ?? say(API.status.notSignedIn) })
      : retryWaitText(live)
        ? say(API.status.retryWait, { state: retryWaitText(live) ?? '' })
        : unknownStateText(live)
          ? say(API.status.unknownState, { state: unknownStateText(live) ?? '' })
          : (agentField(live?.statusMessage, live?.statusText) ?? agentField(live?.mergeSlot, live?.mergeSlotText) ?? null)

async function projectSummary(p: string) {
  const info = await workspace.projectInfo(p)
  // Where each agent is (#1451, #1434's contract): read once for all of them.
  const facts = await folderFacts(p)
  const places = new Map(await Promise.all(info.agents.map(async (a) => [a.id, await agentPlace(p, a, a.live ? { cwd: a.live.cwd } : null, facts)] as const)))
  // The workspace's servers, available to every project, and those added to this one (HI-2059): each agent gets them
  // all, or those of them it was given (#537).
  const servers = await inWorkspace(workspaceOf(p), () => listMcp()).catch(() => [])
  const legacy = workspaceOf(p).config.mcp.enabled
  const mcpOn = servers.filter((m) => serverOnIn(m, info.config.mcp, legacy)).map((m) => m.name)
  return {
    name: info.name,
    path: info.path,
    workspace: basename(workspaceOf(p).path ?? ''),
    active: info.active,
    branch: info.branch,
    status: info.live?.status ?? 'stopped',
    sessionId: info.live?.sessionId ?? null,
    statusMessage: statusMessageOf(info.live),
    restartNeeded: info.restartNeeded,
    agents: info.agents.map((a) => ({
      id: a.id,
      name: a.name,
      provider: a.live?.provider ?? agentProvider(a, config.settings),
      // Its role in the workflow (#1430): its own, else the guess from its note or name.
      workflowRole: agentWorkflowRole(a),
      // What of Combwork's its connection launches it with (HI-2670), when not everything: "plain" or "partly plain: …".
      ...(launchSummaryOf(a) ? { launch: launchSummaryOf(a) } : {}),
      // Where it works now (#1451): its running session's folder, else where a new conversation would start, short (a
      // slot's name, project, or home: <name>); its slot, and that slot's line.
      folder: places.get(a.id)!.now.at,
      ...(places.get(a.id)!.now.slot ? { slot: places.get(a.id)!.now.slot } : {}),
      branch: places.get(a.id)!.branch,
      status: a.live?.status ?? 'stopped',
      sessionId: a.live?.sessionId ?? null,
      statusMessage: statusMessageOf(a.live),
      ...(watchingOf(a.live) ? { watching: watchingOf(a.live) } : {}),
      ...(progressOf(p, a.id) ? { progress: progressOf(p, a.id) } : {}),
      // An action under the CLI's automatic review (as asked); never a question for the user.
      reviewing: a.live?.review ?? null,
      backgroundTasks: a.live?.backgroundTasks ?? 0,
      // The project's MCP servers it gets (the built-in combwork server besides): all of them, or only those it was given.
      mcpServers: mcpOn.filter((n) => agentGetsMcp(a, n)),
      mcpChoice: agentChoosesMcp(a) ? 'only' : 'all',
      // The guidance and skill revisions it launched with (compare with GET /v1/status's to spot an old launch).
      launched: a.live?.launched ?? null,
      // Its connection (HI-1771, for a CLI with connections): the one chosen (null: the default), the one its run is on, and a switch waiting.
      ...agentConnectionFields(p, a, a.live?.provider ?? agentProvider(a, config.settings))
    })),
    // Its builder and reviewer pairs (#1531): its running lanes', each with its state as cw_lane list says it (HI-2271:
    // the card it is on), then by name; empty without either.
    pairs: workflowPairs(info.agents, await lanes.listLanes(workspaceOf(p), { project: basename(p) }).catch(() => []), laneStateText),
    // The workspace's MCP servers (HI-2059): all available to the project, those added to it running; `on` is `added`'s
    // old name, kept for 1.0 (deprecated).
    mcp: { available: servers.filter((m) => m.def).map((m) => m.name), added: mcpOn, on: mcpOn },
    // Its version control, what Combwork finds in its folder now, and the switch it offers when they differ (#1419): never
    // switched silently; the user switches it (the Assistant within Control: project.workflow.platform).
    ...(info.platform ? { versionControl: versionControlOf(info.platform) } : {}),
    // The workflow options in force (#1278), and which the project, the workspace or Combwork's settings set.
    workflow: await inWorkspace(workspaceOf(p), () => workflowSummary(workspaceOf(p), p)).catch(() => null),
    // The project's configuration; its workflow options are `workflow`'s, resolved (not again here, raw).
    // Its MCP list as what is added (HI-2059), never its stored form (a list not yet converted means something else).
    settings: { ...withoutWorkflow(info.config), mcp: { added: mcpOn } }
  }
}

const withoutWorkflow = ({ workflow: _w, ...rest }: ProjectConfig): Omit<ProjectConfig, 'workflow'> => rest

/** A project's version control for agents, lean: in force, found, and the offer when they differ. */
function versionControlOf(p: ProjectPlatform): Record<string, unknown> {
  const d = p.detected
  const found = d.other ? say(API.project.vcsUnsupported, { name: d.other }) : d.platform === 'git' ? say(API.project.vcsGit, { root: d.root ?? '', subfolder: d.subfolder ? 'yes' : 'no' }) : d.platform === 'jj' ? say(API.project.vcsJj, { root: d.root ?? '', colocated: d.jj?.colocated ? 'yes' : 'no' }) : 'none'
  return { platform: p.id, found, ...(p.offer ? { offers: p.offer.offer, why: p.offer.why } : {}) }
}

/** The agent an API call is for: an agent id or name, else the project's only agent (400 with several, 409 with none). */
async function agentParam(p: string, value: unknown): Promise<string> {
  if (typeof value !== 'string' || !value) {
    const agents = projectAgents(await workspace.projectConfig(p))
    if (agents.length === 1) return agents[0].id
    throw agents.length ? new HttpError(400, apiSaid(API.agent.sayWhich)) : new HttpError(409, apiSaid(API.agent.none))
  }
  const a = projectAgents(await workspace.projectConfig(p)).find((x) => x.id === value || x.name.toLowerCase() === value.toLowerCase())
  if (!a) throw new HttpError(404, apiSaid(API.agent.unknownNamed, { name: value }))
  return a.id
}

/** `signal` aborts when the client goes away before its reply (a long wait it no longer waits for). */
type Handler = (ctx: { params: string[]; query: URLSearchParams; body: any; signal: AbortSignal }) => Promise<unknown>


/** The status a refusal answers with (an HttpError's, the change boundary's, a setting's), for its public reason (#763). */
const statusOf = (e: unknown): number => (e instanceof assistant.ChangeRefused || e instanceof SettingRefused || e instanceof lanes.LaneError ? e.status : errorStatus(e))

/**
 * A message and its values, kept as data where one text is said in more than one scope (HI-2433 round 1): what the
 * Assistant's change is called is said in its caller's scope in a refusal, and in the Default where it is recorded.
 */
type Said = readonly [AgentMsg, AgentValues?]
/** Said in the request's scope: what its caller reads. */
const sayNow = ([m, values]: Said): string => say(m, values)
/** Said in the Default: text stored for any reader (the Assistant's activity, undo's records), until stored records are said when read (5b, 6b). */
const sayStored = ([m, values]: Said): string => inDefaultDialect(() => say(m, values))

/** A refusal of the Assistant's change boundary, or of a batch's request, as the Agent API answers it. */
const httpOf = (e: unknown): unknown => (e instanceof assistant.ChangeRefused ? httpFrom(e.status, e, e.extra) : e)

async function asRefused<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    throw httpOf(e)
  }
}

/**
 * A change the Combwork Assistant asks for: admitted by the Assistant's change boundary (control level, limit), run, and
 * recorded (its panel's list and combwork.log) with `act`, its kind and targets (#763), and what `fn` adds to them once
 * known (`act`: a new card's number, a new agent). `fn` gets the boundary's guard, to run again as each write is made.
 * Other callers can't make these changes through the API.
 */
async function assistantChange<T>(need: AssistantControl, what: Said, act: ActivityTarget, fn: (guard: () => void) => Promise<{ done: Said; said?: string; brief?: Said; act?: Partial<ActivityTarget>; result: T } & UndoNotes>): Promise<T> {
  const ws = assistantCaller()
  if (!ws) throw new HttpError(403, apiSaid(API.change.onlyAssistant, { what: sayNow(what) }))
  // What is recorded (its activity, undo's records) is said in the Default; its refusals in the caller's scope.
  const stored = sayStored(what)
  const line = stored.charAt(0).toUpperCase() + stored.slice(1)
  const guard = await asRefused(async () => assistant.admit(ws, assistantCallerToken() ?? '', need, what, act))
  try {
    // `said`: what the line quotes (a prompt, a message), which the Agent API's event stream leaves out.
    // `brief`: the line in Combwork's own words when `done` carries an error's text (#763: the stream never does).
    // Recorded for undo as it is made (#1282): a card's fields as the card is saved, the rest here once it is done.
    const changed = await recordingChanges(ws, act.kind, stored, async () => {
      const out = await fn(guard)
      await noteDone(requireWorkspace(), { ...act, ...out.act }, out)
      return out
    })
    const { said, act: more, result } = changed
    const done = sayStored(changed.done)
    const pub = changed.brief ? sayStored(changed.brief) : said ? done : undefined
    assistant.record(ws, { ...act, ...more }, done + (said ?? ''), undefined, pub !== undefined ? { brief: pub } : {})
    return result
  } catch (e) {
    assistant.record(ws, act, line, (e as Error).message, { reason: publicReason(statusOf(e)) })
    throw httpOf(e)
  }
}

/**
 * Why each kind of the Assistant's change that undo can't take back can't be (#1282, SPEC §16.14), as the window and the
 * undo tool say it. Card changes, lanes, agents' settings and settings are recorded by what made them; an agent it started
 * here, so undo can stop it.
 */
const FINAL_WHY: Partial<Record<ActivityKind, string>> = {
  'prompt-agent': UNDO_FINAL.prompt,
  'message-agent': UNDO_FINAL.message,
  'comment-task': UNDO_FINAL.comment,
  'hand-over': UNDO_FINAL.handOver,
  'create-project': UNDO_FINAL.projectMade,
  'activate-project': UNDO_FINAL.projectOpened,
  'deactivate-project': UNDO_FINAL.projectClosed,
  'add-agent': UNDO_FINAL.agentAdded,
  'stop-agent': UNDO_FINAL.agentStopped,
  'reorder-tasks': UNDO_FINAL.cardsOrder,
  'cancel-messages': UNDO_FINAL.withdrawn,
  'lane-end': UNDO_FINAL.laneEnded,
  'lane-fresh-start': UNDO_FINAL.freshRetried,
  'queue-pause': UNDO_FINAL.queuePaused,
  'queue-resume': UNDO_FINAL.queueResumed,
  'queue-forward': UNDO_FINAL.queueForwarded,
  retarget: UNDO_FINAL.retargeted,
  'team-pause': UNDO_FINAL.teamPaused,
  'team-resume': UNDO_FINAL.teamResumed,
  'release-slot': UNDO_FINAL.slotReleased,
  'add-connection': UNDO_FINAL.connectionMade,
  'update-connection': UNDO_FINAL.connectionChanged
}

/**
 * What a change of the Assistant's tells its recorder for undo (#1282): the launch it started, as the start returned it
 * (undo stops only that one, while it runs), and what of it stays whatever undo does (an intent's facts: its
 * submission, verdict, question), said beside what can be undone.
 */
interface UndoNotes {
  started?: { project: string; agentId: string; run: string }
  stays?: string
}

/** Said of a change that changed nothing undo puts back, when its kind has no words of its own. */
const NOTHING_TO_UNDO = UNDO_FINAL.nothing

/**
 * What the change running here leaves for undo once done (#1282 round 3): an agent it started (the launch the start
 * returned), what of it stays, and, for any change that recorded nothing else, why it can't be undone: every change is
 * listed, none left out. Undo itself is never recorded (it is deliberately not undoable).
 */
async function noteDone(ws: WorkspaceService, act: ActivityTarget, notes: UndoNotes): Promise<void> {
  if (act.kind === 'undo') return
  if (notes.started) await noteChange(ws, { kind: 'started', project: notes.started.project, target: notes.started.agentId, card: act.card ?? null, fields: [{ field: 'run', old: null, new: notes.started.run }] })
  if (notes.stays) await noteChange(ws, { kind: 'final', project: act.project ?? null, card: act.card ?? null, final: notes.stays })
  if (!recordedHere()) await noteChange(ws, { kind: 'final', project: act.project ?? null, card: act.card ?? null, final: FINAL_WHY[act.kind] ?? NOTHING_TO_UNDO })
}

/** An agent as an action names it (#763). */
const actAgent =(a: { id: string; name: string }): ActivityAgent => ({ id: a.id, name: a.name })
/** A lane as an action names it: its id, project, cards and builder. */
const laneAct = (l: Pick<LaneInfo, 'id' | 'project' | 'cards' | 'builder'>): Partial<ActivityTarget> => ({ lane: l.id, project: l.project, cards: l.cards.map((c) => c.number), agent: actAgent(l.builder) })

/** For routes that change something and that other callers may use too: the Assistant needs the control level. */
function assistantMay(need: AssistantControl, what: Said, act: ActivityTarget): void {
  const ws = assistantCaller()
  if (!ws) return
  try {
    assistant.refuseUnlessAllowed(ws, need, what, act)
  } catch (e) {
    throw httpOf(e)
  }
}

const routes: { method: string; pattern: RegExp; template: string; handler: Handler }[] = []
function route(method: string, path: string, handler: Handler): void {
  routes.push({ method, pattern: routePattern(path), template: path, handler })
  // The template (/v1/tasks/:n), never the path asked for, is what a request is counted under.
  knownRoute(path)
}

/** The Agent API's contract version: goes up when a route or field changes in a way a client would notice. */
export const API_VERSION = 15

/** Who Combwork takes a request's caller for, and what it may reach (GET /v1/status). */
async function callerInfo(): Promise<Record<string, unknown>> {
  const own = assistantCaller()
  if (own) return { role: 'assistant', workspace: basename(own), control: assistant.controlLevel() }
  const a = agentCaller()
  if (a) {
    const def = await workspace
      .projectConfig(a.projectPath)
      .then((cfg) => projectAgents(cfg).find((x) => x.id === a.agentId))
      .catch(() => undefined)
    return { role: 'agent', project: basename(a.projectPath), agent: def?.name ?? a.agentId, scope: 'project' }
  }
  const v = viewerCaller()
  if (v) return { role: 'viewer', name: v.name, scope: 'workspace', readOnly: true }
  return { role: 'api', scope: 'workspace' }
}

/**
 * The request's workspace's Combwork skills (null without one), read once its open has brought them up to date, as a launch
 * reads them (HI-1781: during the update after an open, a list half copied).
 */
async function combworkSkillsNow(): Promise<Awaited<ReturnType<typeof skillRevisions>> | null> {
  const ws = contextWorkspace()
  if (!ws) return null
  await ws.itemsUpToDate()
  return inWorkspace(ws, () => skillRevisions())
}

route('GET', '/v1/status', async () => ({
  // agent-protocol: the app's name
  app: { name: 'Combwork', version: app.getVersion() },
  api: { version: API_VERSION },
  caller: await callerInfo(),
  // The guidance this Combwork gives sessions, and the request's workspace's Combwork skills (null without one).
  guidance: { revision: GUIDANCE_REVISION, skills: await combworkSkillsNow() },
  // Combwork's words in them in the caller's dialect (dialects, HI-2440).
  providers: Object.fromEntries(Object.entries(providerService.all()).map(([id, info]) => [id, agentInstallInfo(info)])),
  /** The request's workspace (or the only open one); `workspaces` lists every window's. */
  workspace: contextWorkspace()?.path ? { name: basename(contextWorkspace()!.path!), path: contextWorkspace()!.path } : null,
  workspaces: openWorkspaces().map((w) => ({ name: basename(w.path!), path: w.path })),
  // The Combwork Assistant belongs to its workspace, not a project; it sees its own workspace's sessions only.
  liveSessions: sessions.liveStates().filter((s) => !assistantCaller() || workspaceOf(s.projectPath).path?.toLowerCase() === assistantCaller()).map((s) => ({ workspace: basename(workspaceOf(s.projectPath).path ?? ''), project: workspace.isAssistantHome(s.projectPath) ? null : basename(s.projectPath), agent: s.agentName ?? null, provider: s.provider, sessionId: s.sessionId || null, status: s.status }))
}))

route('GET', '/v1/workspace', async () => {
  if (!openWorkspaces().length) return null
  const w = requireWorkspace()
  // Its MCP settings aren't in it (HI-2059): the servers and where they are added are GET /v1/mcp's.
  const { mcp: _mcp, ...cfg } = w.config
  return { name: basename(w.path!), path: w.path, config: cfg }
})

route('GET', '/v1/workspaces', async () => openWorkspaces().map((w) => ({ name: basename(w.path!), path: w.path })))

/** A project in a short listing (?view=short): its state and agents, without ids, paths or settings. */
async function projectRow(p: string): Promise<ProjectRow> {
  const s = await projectSummary(p)
  return { name: s.name, workspace: s.workspace, active: s.active, branch: s.branch, agents: s.agents.map((a) => ({ name: a.name, provider: a.provider, workflowRole: a.workflowRole, ...(a.launch ? { launch: a.launch } : {}), status: a.status, branch: a.branch, backgroundTasks: a.backgroundTasks, ...(a.watching ? { watching: a.watching.label } : {}), ...(a.progress ? { progress: progressLabel(a.progress) } : {}) })) }
}

route('GET', '/v1/projects', async ({ query }) => {
  // The request's workspace, else every open workspace's projects (each says its workspace).
  const ctx = contextWorkspace()
  const short = query.get('view') === 'short'
  const out = []
  for (const w of ctx ? [ctx] : openWorkspaces()) for (const p of await w.listProjectPaths()) out.push(short ? await projectRow(p) : await projectSummary(p))
  return out
})

// One project, with its unused worktrees (#353) when it has any, for the Assistant to mention: counts only, here alone
// (a git check per worktree, too much for every listing). Removing them is the user's (no route).
route('GET', '/v1/projects/:name', async ({ params }) => {
  const p = projectByName(params[0])
  const unused = await unusedWorktreeCounts(p)
  return { ...(await projectSummary(p)), ...(unused ? { unusedWorktrees: unused } : {}) }
})

// A project agent turns only its own project on or off (HI-2330: another project is its own agents', the Assistant's and the user's).
route('POST', '/v1/projects/:name/activate', async ({ params }) => {
  const p = projectByName(params[0])
  ownProjectOnly(p, [API.own.activating])
  if (assistantCaller()) {
    return assistantChange('agents', [API.change.activateProject, { project: basename(p) }], { kind: 'activate-project', project: basename(p) }, async (guard) => {
      // Its guard checked again just before the write (HI-2420), which is synchronous: nothing comes between.
      guard()
      workspace.setActive(p, true)
      await workspaceOf(p).refresh()
      return { done: [API.done.activated, { project: basename(p) }], result: await projectSummary(p) }
    })
  }
  workspace.setActive(p, true)
  await workspaceOf(p).refresh()
  return projectSummary(p)
})

route('POST', '/v1/projects/:name/deactivate', async ({ params }) => {
  const p = projectByName(params[0])
  ownProjectOnly(p, [API.own.deactivating])
  assistantMay('agents', [API.change.deactivateProject, { project: basename(p) }], { kind: 'deactivate-project', project: basename(p) })
  if (sessions.liveFor(p)) throw new HttpError(409, apiSaid(API.project.stopBeforeDeactivating))
  workspace.setActive(p, false)
  await workspaceOf(p).refresh()
  return projectSummary(p)
})

/**
 * A project agent (by its own token) looks into, types into, starts, stops and hands over only its own project's agents: another project's
 * conversations can hold that project's cards (a card started on an agent is its prompt), which are not its to see.
 * Status stays open to it (projects, project status, waiting for agents); the Assistant and scripts see everything.
 */
function ownProjectOnly(p: string, what: Said): void {
  const a = agentCaller()
  if (a && resolvePath(a.projectPath).toLowerCase() !== resolvePath(p).toLowerCase()) {
    throw new HttpError(403, apiSaid(API.agent.ownProjectOnly, { what: sayNow(what), project: basename(a.projectPath) }))
  }
}

route('GET', '/v1/projects/:name/sessions', async ({ params }) => {
  const p = projectByName(params[0])
  ownProjectOnly(p, [API.own.readingSessions])
  return sessions.list(p)
})

route('POST', '/v1/projects/:name/sessions', async ({ params, body }) => {
  const p = projectByName(params[0])
  if (assistantCaller()) throw new HttpError(400, apiSaid(API.agent.useStartAgent))
  ownProjectOnly(p, [API.own.starting])
  return sessions.start(p, { resumeId: body?.resumeId, name: body?.name, agentId: await agentParam(p, body?.agent) })
})

route('POST', '/v1/projects/:name/stop', async ({ params, query, body }) => {
  const p = projectByName(params[0])
  if (assistantCaller()) throw new HttpError(400, apiSaid(API.agent.useStopAgent))
  ownProjectOnly(p, [API.own.stopping])
  const agent = query.get('agent') ?? body?.agent
  // Its cause from the caller's token (HI-1881): an agent's; a script's or another caller's unknown, just "stopped".
  sessions.stop(p, agent ? await agentParam(p, agent) : undefined, agentCaller() ? 'agent' : undefined)
  return { ok: true }
})

route('GET', '/v1/projects/:name/usage', async ({ params, query }) => {
  const p = projectByName(params[0])
  const agent = query.get('agent')
  const id = query.get('sessionId') ?? sessions.liveFor(p, agent ? await agentParam(p, agent) : undefined)?.sessionId ??(await sessions.list(p)).find((s) => s.source === 'combwork')?.id
  if (!id) throw new HttpError(404, apiSaid(API.agent.noSessions))
  const usage = await sessions.usage(p, id)
  // Where it ran (#1434): its folder, and the slot that is, if any.
  const rec = usage ? await workspace.sessionRecord(p, id).catch(() => undefined) : undefined
  const folder = rec ? (rec.cwd ?? p) : null
  const slot = folder ? slotAt(await folderFacts(p).catch(() => ({ projectPath: p, migrated: false, migratedAgents: [], homes: [], slots: [] })), folder)?.name : undefined
  const where = folder ? { folder, ...(slot ? { slot } : {}) } : {}
  // ?days=false: without the usage by day, which grows with every day the session runs.
  if (usage && query.get('days') === 'false') {
    const { days: _days, ...rest } = usage
    return { ...rest, ...where }
  }
  return usage && { ...usage, ...where }
})

route('POST', '/v1/projects/:name/input', async ({ params, body }) => {
  if (assistantCaller()) throw new HttpError(400, apiSaid(API.agent.usePromptAgent))
  if (!config.settings.agentApi.allowSessionInput) throw new HttpError(403, apiSaid(API.agent.inputDisabled))
  const p = projectByName(params[0])
  ownProjectOnly(p, [API.own.typing])
  const agentId = await agentParam(p, body?.agent)
  if (!sessions.liveFor(p, agentId)) throw new HttpError(409, apiSaid(API.agent.notRunning))
  const text = String(body?.text ?? '')
  writePty(sessions.key(p, agentId),text + (body?.submit === false ? '' : '\r'))
  return { ok: true }
})

/** The window's notice that a hand-over an agent or the Assistant asked for failed: in the window's language, the
    error's text too (the Assistant's activity keeps its English). */
export const handOverFailedToast = (projectPath: string, to: string, e: unknown): ToastMessage =>
  toast('error', tr(msg({ id: 'session.handOver.apiFailed', defaultMessage: 'Could not hand over to {agent}', description: "A notice's title: handing an agent's work to another ({agent}) failed, when an agent or the Assistant asked for it; the error follows." }), { agent: to }), shownError(e), undefined, projectPath)

route('POST', '/v1/projects/:name/handover', async ({ params, body }) => {
  const own = assistantCaller()
  if (!own && !config.settings.agentApi.allowSessionInput) throw new HttpError(403, apiSaid(API.agent.inputDisabled))
  const p = projectByName(params[0])
  // A hand-over prompts its agent (HI-2327): another project's agents are not a project agent's to type into, as /input.
  ownProjectOnly(p, [API.own.handingOver])
  const from = await agentParam(p, body?.from)
  if (typeof body?.to !== 'string' || !body.to) throw new HttpError(400, apiSaid(API.handover.toRequired))
  const to = await agentParam(p, body.to)
  const handover = body?.handover !== false
  // Known at once rather than later in a notification: from the latest handover, there has to be one.
  if (!handover && !(await sessions.latestHandover(p))) throw new HttpError(409, apiSaid(API.handover.noneYet, { project: basename(p) }))
  const names = projectAgents(await workspace.projectConfig(p))
  const name = (id: string): string => names.find((a) => a.id === id)?.name ?? id
  // To itself it ends its conversation (#1057): not while it works, merges or is on a running card loop's card.
  if (from === to && !(await sessions.handOverAllowed(p, from))) throw new HttpError(409, apiSaid(API.handover.busy, { agent: name(from) }))
  const act: ActivityTarget = { kind: 'hand-over', project: basename(p), agent: { id: from, name: name(from) }, toAgent: { id: to, name: name(to) } }
  // `allowed`: the Assistant's guard, carried into the hand-over (HI-2420, HR1's round 1): checked before each of its steps.
  const start = async (allowed?: () => void): Promise<void> => {
    // It can take minutes (the handover is written first): answer now, report failures in Combwork.
    void sessions.handOver(p, from, to, { handover, ...(allowed ? { allowed } : {}) }).catch((e) => {
      handOverFailedToast(p, name(to), e)
      if (own) assistant.record(own, act, sayStored([API.handover.failedLine, { project: basename(p) }]), (e as Error).message, { reason: publicReason(undefined) })
    })
  }
  if (!own) {
    await start()
    return { ok: true }
  }
  return assistantChange('agents', [API.change.handOver, { from: name(from), to: name(to), project: basename(p) }], act, async (guard) => {
    // Known at once rather than minutes later: without Combwork's tools agents can't write or read a handover.
    if (!sessions.combworkMcp(p)) throw new HttpError(409, apiSaid(API.handover.noTools))
    for (const id of [from, to]) {
      if (sessions.userMayBeTyping(p, id)) throw new HttpError(409, apiSaid(API.handover.userTyping, { agent: name(id) }))
    }
    // Its guard checked as it is set off (HI-2420), and carried into it: the hand-over takes minutes, and each of its steps
    // (asking for the handover, ending a conversation, giving or launching the target) checks it again.
    guard()
    await start(guard)
    return {
      done: [API.done.handingOver, { from: name(from), to: name(to), project: basename(p), latest: handover ? 'no' : 'yes' }],
      result: { ok: true, note: say(API.handover.started, { from: name(from), to: name(to), ask: handover ? 'yes' : 'no' }) }
    }
  })
})

// ---------------------------------------------------------------------------
// Agents and projects for the Combwork Assistant (Settings → Assistant → Control). Reading is open to every caller.
// ---------------------------------------------------------------------------

/** The providers agents can run: whether each is on and installed, and its models, effort levels and modes. */
route('GET', '/v1/providers', async () => {
  // Installed or not is only known once Combwork has looked for the CLIs (#506).
  await providerService.detected()
  const s = config.settings
  const here = contextWorkspace()
  return PROVIDERS.map((p) => {
    const info = providerService.info(p.id)
    // The models of the GitHub host the caller's workspace resolves to (HI-2779), for a CLI signing in on one.
    const at = infoAt(info, { workspacePath: here?.path ?? null })
    // What the pickers offer: the CLI's own models, else the fallback list in Settings (#125).
    const models = offeredModels(p.id, at, s)
    return {
      id: p.id,
      name: p.name,
      enabled: isProviderEnabled(s, p.id),
      installed: info.found,
      version: info.version,
      // The version this Combwork release was tested with, and how the installed one compares (#365).
      tested: info.tested ? { version: info.tested.version, installed: info.found ? info.tested.installed : say(API.provider.notInstalled) } : null,
      problem: agentInstallInfo(info).readiness?.find((r) => r.level === 'error')?.message ?? null,
      // The CLI's own home's; each connection says its own account's (HI-2856).
      defaultModel: at?.defaultModel ?? null,
      models,
      efforts: fallbackEfforts(p.id, s),
      // Whether agents can be given context200k (a 200K window instead of the model's 1M).
      context200k: p.capabilities.contextLimit,
      modes: offeredModes(p.id, s).map((m) => ({ value: m.value, label: m.label, description: m.description })),
      // Its connections usable in the caller's workspace (HI-2108), in the order: what cw_add_agent's connection names. Each
      // with its own account's default and, where they aren't the provider's, its models (HI-2856).
      ...(here ? { connections: listedConnections(p.id, connectionsHere(here).filter((c) => accountById(c.account)?.provider === p.id), accountById, at, s, models) } : {})
    }
  })
})

// --- Combwork's settings (#186): anyone with a token reads them (the settings catalog's entries with their values); only
// the Combwork Assistant changes them, with Settings → Assistant → Control → Change settings on, and never a sensitive one.
const SETTING_SCOPES: readonly SettingScope[] = ['app', 'provider', 'workspace', 'project']

/** A settings call's project, by name (null without one). */
const settingsProject = (name: unknown): string | null => (typeof name === 'string' && name.trim() ? projectByName(name.trim()) : null)

/** Runs a settings call, turning what settingsTools refuses into the API's answer. */
async function settingsCall<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    throw e instanceof SettingRefused ? httpFrom(e.status, e) : e
  }
}

route('GET', '/v1/settings', ({ query }) =>
  settingsCall(async () => {
    const scope = query.get('scope') || undefined
    if (scope && !SETTING_SCOPES.includes(scope as SettingScope)) throw new HttpError(400, apiSaid(API.settings.scopeIs, { scopes: SETTING_SCOPES.join(', ') }))
    const p = settingsProject(query.get('project'))
    if (scope === 'project' && !p) throw new HttpError(400, apiSaid(API.settings.projectNeedsName))
    return settingRows({ query: query.get('query') ?? '', scope: scope as SettingScope | undefined, project: await projectOf(p) })
  })
)

route('GET', '/v1/settings/:id', ({ params, query }) => settingsCall(async () => settingDetail(entryOf(decodeURIComponent(params[0])), await projectOf(settingsProject(query.get('project'))))))

route('PATCH', '/v1/settings/:id', ({ params, body }) =>
  settingsCall(async () => {
    const e = entryOf(decodeURIComponent(params[0]))
    const p = settingsProject(body?.project)
    if (e.scope === 'project' && !p) throw new HttpError(400, apiSaid(API.settings.sayProject, { setting: e.id }))
    return settingsChange(e, body?.value, e.scope === 'project' ? p : null)
  })
)

/**
 * A setting the Combwork Assistant changes: only with Change settings on, never a sensitive one (its own Control included),
 * and listed in its panel with old → new for Revert. Other callers can't.
 */
async function settingsChange(e: SettingEntry, value: unknown, projectPath: string | null) {
  // Where it is, as the caller reads it; and as records keep it, in the Default (dialects, HI-2441).
  const path = settingPath(e)
  const storedPath = inDefaultDialect(() => settingPath(e))
  // Where: a project's setting names its project (` in webapp`).
  const where = projectPath ? { where: 'project', project: basename(projectPath) } : { where: 'none', project: '' }
  const ws = assistantCaller()
  if (!ws) throw new HttpError(403, apiSaid(API.settings.onlyAssistant, { path }))
  // Recorded lines are said in the Default (stored); refusals in the caller's scope.
  const line = sayStored([API.settings.line, { path: storedPath, ...where }])
  // Which setting, never its value (#763).
  const act: ActivityTarget = { kind: 'setting', settingId: e.id, ...(projectPath ? { project: basename(projectPath) } : {}) }
  if (config.settings.assistant?.changeSettings !== true) {
    assistant.record(ws, act, line, sayStored([API.settings.notAllowed]), { reason: sayStored([API.settings.notAllowedReason]) })
    throw new HttpError(403, apiSaid(API.settings.controlOff, { path }))
  }
  if (e.sensitive) {
    assistant.record(ws, act, line, sayStored([API.settings.userOnly]), { reason: sayStored([API.settings.userOnlyReason]) })
    throw new HttpError(403, apiSaid(API.settings.readOnly, { readOnly: settingReadOnly(e) ?? '' }))
  }
  // Checked before the change: a value it can't take is the Assistant's to fix.
  await settingsCall(() => checkedValue(e, value, projectPath))
  // Asked again at the moment of the change (a project's under its lock, after any wait for it): Change settings may have
  // been turned off, or the Assistant stopped, meanwhile.
  // The same session, too: one started since (a restart) mustn't carry out this one's pending change.
  const token = assistantCallerToken() ?? ''
  const stillAllowed = (): void => {
    if (config.settings.assistant?.changeSettings !== true) throw new SettingRefused(403, say(API.settings.turnedOff, { path }))
    if (!assistant.isCurrentToken(ws, token)) throw new SettingRefused(409, say(API.settings.sessionEnded))
  }
  try {
    // The value as sent (applySetting checks it again): a provider's prices take null, Combwork's own, as more than {}.
    const r = await applySetting(e, value, projectPath, stillAllowed)
    // What changed, as the list and the reply show it: a table's changed entries, not its size.
    const { oldText, newText } = settingChangeTexts(e, r.old, r.new, r.removed)
    const stored = inDefaultDialect(() => settingChangeTexts(e, r.old, r.new, r.removed))
    const changed = JSON.stringify(r.old) !== JSON.stringify(r.new) || !!r.removed
    if (changed) {
      // The event stream says which setting, not its values (`brief`).
      assistant.record(ws, act, sayStored([API.settings.changedLine, { path: storedPath, ...where, old: stored.oldText, new: stored.newText }]), undefined, { brief: sayStored([API.settings.changedBrief, { path: storedPath, ...where }]), setting: { id: e.id, ...(projectPath ? { project: projectPath } : {}), path: storedPath, old: r.old, new: r.new, ...(r.removed ? { removed: r.removed } : {}), oldText: stored.oldText, newText: stored.newText } })
      // For undo (#1282): its value (and a provider's removed models) as it was and as set.
      const fields = [{ field: 'value', old: r.old, new: r.new }, ...(r.removed ? [{ field: 'removed', old: r.removed.old, new: r.removed.new }] : [])]
      await recordingChanges(ws, 'setting', sayStored([API.change.setting, { path: storedPath, ...where }]), () => noteChange(requireWorkspace(), { kind: 'setting', project: projectPath ? basename(projectPath) : null, target: e.id, fields }))
    }
    const restart = restartText(e)
    return { id: e.id, title: agentTitle(e), path, ...(projectPath ? { project: basename(projectPath) } : {}), changed, old: oldText, new: newText, ...(restart ? { restart } : {}), ...(r.note ? { note: r.note } : {}) }
  } catch (err) {
    assistant.record(ws, act, line, (err as Error).message, { reason: publicReason(statusOf(err)) })
    throw err instanceof SettingRefused ? httpFrom(err.status, err) : err
  }
}

/** How many of its messages' changes the Assistant's list gives (its newest; GET /v1/assistant/changes). */
const CHANGE_GROUPS_LISTED = 10

/**
 * The Assistant's own changes, kept for undo (#1282, SPEC §16.14): its newest messages' groups, each change with its id,
 * its line, its card, the fields it set, whether it was undone, and why one can't be (`final`). Only the Assistant's.
 */
route('GET', '/v1/assistant/changes', async () => {
  if (!assistantCaller()) throw new HttpError(403, apiSaid(API.undo.onlyAssistant))
  return changeGroups(requireWorkspace())
    .slice(0, CHANGE_GROUPS_LISTED)
    .map((g) => ({ group: g.id, at: g.at, changes: g.changes.map((c) => ({ id: c.id, what: c.what, ...(c.card !== undefined ? { card: c.card } : {}), fields: c.fields, ...(c.final ? { final: c.final } : {}), ...(c.undoneAt ? { undone: true } : {}) })) }))
})

/**
 * The Assistant undoes changes of its own (#1282): `change` (an id from GET /v1/assistant/changes), or `group` (a message's,
 * or "latest": its newest message with a change not undone). Never another's: only its own are kept. A change of its
 * own, listed in its panel; what was skipped (changed since, gone) is said.
 */
route('POST', '/v1/assistant/undo', async ({ body }) => {
  const ws = requireWorkspace()
  const change = typeof body?.change === 'string' && body.change ? body.change : undefined
  let group = typeof body?.group === 'string' && body.group ? body.group : undefined
  if (!change === !group) throw new HttpError(400, apiSaid(API.undo.nameOne))
  if (group === 'latest') {
    group = changeGroups(ws).find((g) => g.changes.some((c) => !c.undoneAt && !c.final))?.id
    if (!group) throw new HttpError(404, apiSaid(API.undo.noneLeft))
  }
  return assistantChange('agents', [change ? API.change.undoOne : API.change.undoMessage], { kind: 'undo' }, async (guard) => {
    let results: AssistantUndoResult[]
    try {
      // Its control level and its launch, checked again at each change's write (#1282 round 1): turned down or ended
      // meanwhile, the rest isn't undone.
      results = await undoChanges(ws, change ? { change } : { group }, 'assistant', guard)
    } catch (e) {
      throw e instanceof UndoNotFound ? httpFrom(404, e) : e
    }
    const undone = results.filter((r) => r.undone.length).length
    const skipped = results.reduce((n, r) => n + r.skipped.length, 0)
    const cards = [...new Set(results.flatMap((r) => (r.card !== undefined ? [r.card] : [])))]
    return { done: [API.done.undid, { undone: String(undone), count: results.length, total: String(results.length), skipped, skippedTotal: String(skipped) }], act: cards.length === 1 ? { card: cards[0] } : cards.length ? { cards } : {}, result: { results } }
  })
})

route('POST', '/v1/projects', async ({ body }) => {
  const name = String(body?.name ?? '').trim()
  if (!name) throw new HttpError(400, apiSaid(API.project.nameRequired))
  return assistantChange('projects', [API.change.createProject, { name }], { kind: 'create-project', project: name }, async (guard) => {
    // Its guard checked again just before the write (HI-2420): createProject makes the folder before its first await.
    // What follows only sets up the project that is then there (activated, listed), never left half made.
    guard()
    await workspace.createProject(name)
    const p = join(workspace.path!, name)
    workspace.setActive(p, true)
    await workspace.refresh()
    return { done: [API.done.createdProject, { name }], result: await projectSummary(p) }
  })
})

const busy = (s: LiveSessionState | null): boolean => !!s && (s.status === 'working' || s.status === 'waiting' || s.status === 'starting' || s.status === 'background' || s.status === 'signin')
const clip = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n)}…` : t)

async function agentDefOf(p: string, agentId: string) {
  const a = projectAgents(await workspace.projectConfig(p)).find((x) => x.id === agentId)
  if (!a) throw new HttpError(404, apiSaid(API.agent.unknown))
  return a
}

/** An agent's MCP servers from a request body ("*", null or empty: all of the project's again). */
function agentMcpArg(body: any): { mcpServers?: string[] | null } {
  const m = body?.mcpServers
  if (m === undefined) return {}
  const all = m === null || m === '' || m === '*' || (Array.isArray(m) && m.length === 1 && m[0] === '*')
  try {
    return { mcpServers: all ? null : cleanMcpServers(m)! }
  } catch (e) {
    throw new HttpError(400, apiSaid(API.agent.mcpServersArg, { error: (e as Error).message }))
  }
}

/** A workspace's connections per CLI, as they apply (dropping ids gone or another CLI's). */
function workspaceConnections(ws: WorkspaceService): Partial<Record<ProviderId, WorkspaceConnections>> {
  const all = combworkAccounts()
  return Object.fromEntries(PROVIDERS.flatMap((x) => (x.capabilities.connections ? [[x.id, workspaceAccounts(ws.config, x.id, all) ?? { on: [], default: null }]] : [])))
}

/** The connections usable in a workspace (HI-2108), in the order: what an agent's `connection` may name there. */
const connectionsHere = (ws: WorkspaceService): Connection[] => usableConnections(ws.config, allAccounts(), allConnections())

/** A connection's values as the Agent API shows them (HI-2108): only those set (each absent: the CLI decides); its extra arguments to `wide` callers only. */
function connectionValues(c: Connection, wide: boolean): Record<string, unknown> {
  return { ...(c.model ? { model: c.model } : {}), ...(c.effort ? { effort: c.effort } : {}), ...(c.use200kContext ? { context200k: true } : {}), ...(c.permissionMode ? { mode: c.permissionMode } : {}), ...(wide && c.extraArgs ? { extraArgs: c.extraArgs } : {}), ...(c.tag ? { tag: c.tag } : {}) }
}

/** A connection as the Agent API lists it (HI-2108): its id, name, account (its name and CLI), its values, and `usable: false` where it can't be used here. */
function connectionRow(c: Connection, usable: boolean, wide: boolean): Record<string, unknown> {
  const a = accountById(c.account)
  // Its launch settings in short (HI-2670), when not everything.
  const launch = a ? policySummary(c, a.provider) : null
  return { id: c.id, name: c.name, account: a?.name ?? c.account, cli: a?.provider ?? null, ...connectionValues(c, wide), ...(launch ? { launch } : {}), ...(usable ? {} : { usable: false }) }
}

/** An account's connections by name, for a refusal (HI-2108): "On Personal: Personal, Personal · High." */
function connectionNamesOn(accountId: string | undefined): string {
  const a = accountById(accountId)
  if (!a) return say(API.connection.noAccountOn)
  return say(API.connection.namesOn, { account: a.name, connections: connectionsOn(a.id, allConnections()).map((c) => c.name).join(', ') })
}

/**
 * The settings an agent had before HI-2108, refused (decision D: removed, not aliased): a connection holds its model,
 * effort, context and mode, and its CLI follows from it. The reply names the connections on the account concerned (the
 * agent's, or the one a new agent would go on), so an old script fails once and says what to do.
 */
const OLD_AGENT_FIELDS = ['provider', 'model', 'effort', 'mode', 'context200k'] as const
export function refuseOldFields(body: any, account: string | undefined): void {
  const old = OLD_AGENT_FIELDS.filter((k) => body && typeof body === 'object' && k in body)
  if (!old.length) return
  throw new HttpError(400, apiSaid(API.connection.oldFields, { fields: old.join(', '), on: connectionNamesOn(account) }))
}

/**
 * A request's `connection` (HI-2108): a connection's id, or a name unique among those usable in the project's workspace
 * (several: 409, use its id; none: 404); null or "" for its CLI's first usable one. With its CLI. Saving it checks it
 * again (usable here) with the write.
 */
function connectionArg(body: any, projectPath: string): { connection: string | null; cli?: ProviderId } | undefined {
  const v = body?.connection
  if (v === undefined) return undefined
  if (v === null || v === '') return { connection: null }
  const here = connectionsHere(workspaceOf(projectPath)).map((c) => c.id)
  const r = connectionRef(String(v), allConnections(), here)
  if (!r.ok) throw r.why === 'ambiguous' ? new HttpError(409, apiSaid(API.connection.severalNamed, { name: v, ids: r.ids!.join(', ') })) : new HttpError(404, apiSaid(API.connection.noneNamedUsable, { name: v }))
  return { connection: r.id, cli: accountById(getConnection(r.id)?.account)?.provider }
}

/**
 * An agent row's connection fields (HI-2108): `connection`, the one chosen as saved (its id, its name, and `problem`
 * when it can't be used here: removed, or its account off here, so it runs on its CLI's first usable one), or null for
 * none; `launchedConnection`, the account its run is on, with the connection on it the run launched with (HI-2406:
 * `connection`, its id, and its name, now or as then); `switchPending`. A project agent is never told the name of one
 * that can't be used in its workspace.
 */
function agentConnectionFields(p: string, a: AgentInfo, cli: ProviderId): Record<string, unknown> {
  const c = getConnection(a.connection)
  const problem = a.connection ? (c ? connectionProblem(c.account, cli, p) : 'missing') : null
  const shown = !!c && (!problem || !agentCaller())
  const lc = a.live?.launchedConnection
  // The connection the run launched with (HI-2397): its name as now, or as then once removed, never one not usable here to an agent.
  const ran = lc?.connection
  const ranNow = ran ? getConnection(ran.id) : undefined
  const ranNamed = !agentCaller() || (!!ranNow && !connectionProblem(ranNow.account, cli, p))
  return {
    connection: a.connection ? { id: a.connection, name: shown ? c!.name : null, ...(problem ? { problem } : {}) } : null,
    launchedConnection: lc ? { id: lc.id, name: lc.name, ...(ran ? { connection: { id: ran.id, name: ranNamed ? (ranNow?.name ?? ran.name) : null } } : {}), ...(lc.note ? { note: lc.note } : {}) } : null,
    ...(a.live?.switchPending ? { switchPending: true } : {})
  }
}

/**
 * Combwork's connections as the caller may see them (HI-2108): `connections`, the setups agents choose (a project agent only
 * those usable in its workspace; the user's token and the Assistant every one, `usable: false` on the rest, with their
 * extra arguments); `accounts`, the sign-ins and servers they are on (a project agent only those on in its workspace: id,
 * name, CLI, kind, signed in; the others with on here and who each is signed in as). Never a token, a key or where a login
 * is kept.
 */
route('GET', '/v1/connections', async () => {
  const ws = requireWorkspace()
  const wide = !agentCaller()
  const here = new Set(connectionsHere(ws).map((c) => c.id))
  const accounts = connectionsFor(combworkAccounts(), workspaceConnections(ws), wide)
  return { connections: allConnections().filter((c) => wide || here.has(c.id)).map((c) => connectionRow(c, here.has(c.id), wide)), accounts, usage: accountUsageRows(accounts.map((a) => a.id)) }
})

/**
 * Each account's plan usage as kept now (HI-2195): its weekly and 5-hour limits' shares and resets (those still in their
 * period), and its usage move. Accounts with neither are left out.
 */
function accountUsageRows(ids: readonly string[]): AccountUsagePublic[] {
  const now = Date.now()
  const rows: AccountUsagePublic[] = []
  for (const id of ids) {
    const a = accountById(id)
    if (!a) continue
    const limits = (config.get().connectionPlanUsage?.[id]?.limits ?? []).filter((l) => !l.unlimited && !l.notIncluded && (!l.resetsAt || Date.parse(l.resetsAt) > now)).map((l) => ({ label: l.label, usedPercent: Math.round(l.usedPercent * 10) / 10, resetsAt: l.resetsAt }))
    const m = a.usageMove
    const move = m ? { percent: m.percent, limit: m.limit, to: accountById(m.to)?.name ?? m.to } : undefined
    if (limits.length || move) rows.push({ account: a.name, limits, ...(move ? { move } : {}) })
  }
  return rows
}

route('GET', '/v1/connections/:ref', async ({ params }) => {
  const ws = requireWorkspace()
  const here = connectionsHere(ws).map((c) => c.id)
  const ref = decodeURIComponent(params[0] ?? '')
  const r = connectionRef(ref, allConnections(), here)
  // A project agent asking after one not usable in its workspace, by id or by name: as if there were none.
  const c = r.ok ? getConnection(r.id) : undefined
  if (r.ok === false && r.why === 'ambiguous') throw new HttpError(409, apiSaid(API.connection.severalNamed, { name: ref, ids: r.ids!.join(', ') }))
  if (!c || (agentCaller() && !here.includes(c.id))) throw new HttpError(404, apiSaid(API.connection.noneNamedUsableShort, { name: ref }))
  return connectionRow(c, here.includes(c.id), !agentCaller())
})

/**
 * A connection's name and values from a request body (HI-2108: cw_connection add and update): model, effort, mode,
 * context200k and extraArgs, each "" or null for the CLI's own (on an update: cleared). Saving checks them as the
 * connection dialog's save does (a mode the CLI has, an effort the model takes: decision E).
 */
export function connectionValuesArg(body: any): ConnectionPatch {
  const out: ConnectionPatch = {}
  const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v).trim() || null)
  if (body?.name !== undefined) {
    const n = String(body.name ?? '').trim()
    if (!n) throw new HttpError(400, apiSaid(API.connection.needsName))
    out.name = n
  }
  if (body?.model !== undefined) out.model = text(body.model)
  if (body?.effort !== undefined) out.effort = text(body.effort) as EffortLevel | null
  if (body?.mode !== undefined) out.permissionMode = text(body.mode) as PermissionMode | null
  if (body?.extraArgs !== undefined) out.extraArgs = text(body.extraArgs)
  // Its tag (HI-2530): free text, "" or null for none; its length is checked as Settings' save does.
  if (body?.tag !== undefined) out.tag = text(body.tag)
  const c = body?.context200k
  if (c !== undefined) {
    if (c === true || c === 'on') out.use200kContext = true
    else if (c === false || c === 'off' || c === null || c === '') out.use200kContext = null
    else throw new HttpError(400, apiSaid(API.connection.context200k))
  }
  return out
}

/**
 * The Assistant makes or changes a connection (HI-2108, cw_connection): only with Settings → Assistant → Control →
 * Change settings on, asked again at the change, and listed in its panel. Accounts (sign-ins, servers, keys) stay the
 * user's: a connection goes only on an account that exists.
 */
async function connectionChange<T>(act: ActivityTarget, what: Said, fn: (atTheChange: <R>(change: () => R) => R) => Promise<{ done: Said; act?: Partial<ActivityTarget>; result: T }>): Promise<T> {
  connectionsAllowed()
  return assistantChange('look', what, act, async (guard) => {
    connectionsAllowed()
    return fn((change) => atTheChange(guard, change))
  })
}

/** Change settings on (HI-2108): else a connection change is refused, saying where the user changes it. */
function connectionsAllowed(): void {
  if (config.settings.assistant?.changeSettings !== true) throw new HttpError(403, apiSaid(API.connection.controlOff))
}

/**
 * A connection's change, its checks made at the moment of it (HI-2108 round 1), after every await: Change settings still
 * on, and the Assistant's control and its session still current (`guard`, assistantChange's: one stopped or restarted
 * since it asked refuses it). Only then the change, which is synchronous, so nothing comes between.
 */
export function atTheChange<R>(guard: () => void, change: () => R): R {
  connectionsAllowed()
  guard()
  return change()
}

/** A connection change, a refusal it makes (decision E, a mode the CLI lacks, an account gone) answered as the caller's to fix. */
async function connectionsCall<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof HttpError) throw e
    throw httpFrom(e instanceof CombworkError && e.kind === 'notFound' ? 404 : 409, e)
  }
}

route('POST', '/v1/connections', async ({ body }) =>
  connectionChange({ kind: 'add-connection' }, [API.change.addConnection], async (checked) => {
    const ref = String(body?.account ?? '').trim()
    if (!ref) throw new HttpError(400, apiSaid(API.connection.nameAccount))
    const accounts = allAccounts()
    const byName = accounts.filter((a) => a.name.trim().toLowerCase() === ref.toLowerCase())
    const account = accounts.find((a) => a.id === ref) ?? (byName.length === 1 ? byName[0] : undefined)
    if (!account) throw byName.length > 1 ? new HttpError(409, apiSaid(API.connection.severalAccounts, { name: ref, ids: byName.map((a) => a.id).join(', ') })) : new HttpError(404, apiSaid(API.connection.noAccount, { name: ref }))
    const v = connectionValuesArg(body)
    if (!v.name) throw new HttpError(400, apiSaid(API.connection.needsName))
    const c = await checked(() => connectionsCall(() => addConnection(account.id, { ...v, name: v.name! })))
    return { done: [API.done.addedConnection, { connection: c.name, account: account.name }], act: { connection: c.id }, result: connectionRow(c, connectionsHere(requireWorkspace()).some((x) => x.id === c.id), true) }
  })
)

route('PATCH', '/v1/connections/:ref', async ({ params, body }) =>
  connectionChange({ kind: 'update-connection' }, [API.change.updateConnection], async (checked) => {
    const ref = decodeURIComponent(params[0] ?? '')
    const r = connectionRef(ref, allConnections(), allConnections().map((c) => c.id))
    if (!r.ok) throw r.why === 'ambiguous' ? new HttpError(409, apiSaid(API.connection.severalNamed, { name: ref, ids: r.ids!.join(', ') })) : new HttpError(404, apiSaid(API.connection.noneNamed, { name: ref }))
    const v = connectionValuesArg(body)
    // Its launch settings (HI-2670): `launch`, and `confirm` naming what it takes out of the workflow, when it does.
    const launch = body?.launch === undefined ? undefined : launchArg(body.launch, r.id)
    if (!Object.keys(v).length && launch === undefined) throw new HttpError(400, apiSaid(API.connection.nothingToChange))
    // Values and launch settings together (HR1 on s44): what it affects read first, then, after every await, Change
    // settings and the Assistant's session checked at the write (atWrite), and both saved or neither.
    const c = Object.keys(v).length && launch === undefined ? await checked(() => connectionsCall(() => updateConnection(r.id, v))) : await connectionsCall(() => changeConnection(r.id, { values: v, launch, confirmed: typeof body?.confirm === 'string' ? body.confirm : null, atWrite: () => checked(() => undefined) }))
    const cli = accountById(c.account)?.provider
    const done: [AgentMsg, Record<string, string>] = launch !== undefined && !Object.keys(v).length ? [API.done.launchedConnection, { connection: c.name, how: (cli && policySummary(c, cli, true)) || '' }] : [API.done.updatedConnection, { connection: c.name }]
    return { done, act: { connection: c.id }, result: connectionRow(c, connectionsHere(requireWorkspace()).some((x) => x.id === c.id), true) }
  })
)

/** A launch argument (HI-2670): the connection's switches, `{ preset: 'terminal' }` for all off, or {} for all on. */
function launchArg(v: unknown, id: string): ConnectionLaunch {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, apiSaid(API.connection.launchArg))
  const cli = accountById(getConnection(id)?.account)?.provider
  if ((v as { preset?: unknown }).preset === 'terminal') return cli ? terminalPreset(cli) : { guidance: false, tools: false, typing: false }
  return (cli && cleanLaunch(v, cli)) || {}
}

/** A workflowRole argument (#1430): builder, reviewer, either, generalist (HI-686) or independent (HI-2670). */
function workflowRoleArg(v: unknown): WorkflowRole {
  if (isWorkflowRole(v)) return v
  throw new HttpError(400, apiSaid(API.agent.workflowRoleArg))
}

/** Why a worktree of an agent's own is refused (#1451): the Agent API's short note. */
const NOT_PINNED = API.agent.notPinned

route('POST', '/v1/projects/:name/agents', async ({ params, body }) => {
  const p = projectByName(params[0])
  const project = basename(p)
  return assistantChange('agents', [API.change.addAgent, { project }], { kind: 'add-agent', project }, async (guard) => {
    const conn = connectionArg(body, p)
    const ws = workspaceOf(p)
    // Decision D (HI-2108): provider, model, effort, mode and context are a connection's now, refused naming those there.
    refuseOldFields(body, getConnection(conn?.connection)?.account ?? firstUsableAccount(ws.path ? ws.config : null)?.id)
    const mcp = agentMcpArg(body)
    if (conn?.cli && !isProviderEnabled(config.settings, conn.cli)) throw new HttpError(409, apiSaid(API.agent.providerOff, { provider: PROVIDERS.find((x) => x.id === conn.cli)?.name ?? conn.cli }))
    // 1.0 (#1451): no agent has a worktree of its own (slots are lent per card or lane): the old arguments are refused.
    if (body?.worktree || body?.existingWorktree || body?.branch || body?.base || (body?.location && body.location !== 'project')) throw new HttpError(400, apiSaid(NOT_PINNED))
    // Its connection: the one named, else the first usable here (decision A), its CLI following from it.
    const def = await addAgent(p, {
      name: body?.name ? String(body.name) : undefined,
      ...(body?.workflowRole !== undefined ? { workflowRole: workflowRoleArg(body.workflowRole) } : {}),
      location: 'project',
      mcpServers: mcp.mcpServers ?? undefined,
      ...(conn?.connection ? { connection: conn.connection } : {}),
      // Control and the Assistant's session checked again with the write, and just before its start (HI-2328).
      check: guard
    })
    // The view stays where the user has it; the new agent is marked for them.
    emit({ type: 'agent-added', projectPath: p, agentId: def.id })
    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : ''
    let startError = ''
    let didStart: boolean | null = null
    // The launch it started, for undo (#1282): stopped only while that one runs.
    let launched: string | null = null
    if (body?.start || prompt) {
      try {
        launched = (prompt ? await startOnTask(p, def.id, def.name, prompt, (line) => sessions.start(p, { agentId: def.id, prompt: line, allowed: guard })) : await sessions.start(p, { agentId: def.id, allowed: guard }))?.runId ?? null
        didStart = true
      } catch (e) {
        startError = (e as Error).message
        didStart = false
      }
    }
    const said = prompt && didStart ? ` on: ${clip(prompt.replace(/\s+/g, ' '), 80)}` : undefined
    // The stream's line is Combwork's own words: never why it didn't start.
    const started = didStart === true ? 'yes' : didStart === false ? 'no' : 'notAsked'
    const brief: Said = [API.done.addedAgentBrief, { agent: def.name, project, started }]
    return { done: [API.done.addedAgent, { agent: def.name, project, started, error: startError }], said, brief, act: { agent: actAgent(def) }, ...(launched ? { started: { project, agentId: def.id, run: launched } } : {}), result: { agent: addedForAgents(def), project: await projectSummary(p) } }
  })
})

route('PATCH', '/v1/projects/:name/agents/:agent', async ({ params, body }) => {
  const p = projectByName(params[0])
  const agentId = await agentParam(p, params[1] && decodeURIComponent(params[1]))
  const a = await agentDefOf(p, agentId)
  return assistantChange('agents', [API.change.updateAgent, { agent: a.name, project: basename(p) }], { kind: 'update-agent', project: basename(p), agent: actAgent(a) }, async (guard) => {
    // What of its settings changed, for undo (#1282): as saved when the change was made, under the project's lock.
    let was: AgentDef | undefined
    const role = body?.workflowRole !== undefined ? { workflowRole: workflowRoleArg(body.workflowRole) } : {}
    const conn = connectionArg(body, p)
    // Decision D (HI-2108): refused, naming the connections on its account.
    refuseOldFields(body, getConnection(a.connection)?.account)
    // Another CLI's connection is a change of CLI: only while it is stopped (updateAgent refuses it otherwise).
    const def = await updateAgent(p, agentId, { ...(body?.name !== undefined ? { name: String(body.name) } : {}), ...agentMcpArg(body), ...(conn ? { connection: conn.connection } : {}), ...role }, {
      // What it takes out of the workflow (HI-2670), as a refusal named it, once the user agreed.
      confirmed: typeof body?.confirm === 'string' ? body.confirm : null,
      // Control and the Assistant's session checked again under the lock, with the write (HI-2328).
      check: (current) => {
        guard()
        was = structuredClone(current)
      }
    })
    if (was) await noteAgent(requireWorkspace(), basename(p), was, def)
    const live = sessions.liveFor(p, agentId)
    // A role change (HI-2664): updateAgent restarted it if idle; asked again, what became of it (one restart, never two).
    const side = live && body?.workflowRole !== undefined ? await sessions.restartForTools(p, agentId, { when: 'ifIdle' }).catch(() => 'same' as const) : 'same'
    return { done: [API.done.updatedAgent, { agent: def.name, project: basename(p), live: side === 'restarting' || side === 'busy' ? side : live ? 'yes' : 'no' }], act: { agent: actAgent(def) }, result: def }
  })
})

route('POST', '/v1/projects/:name/agents/:agent/start', async ({ params, body }) => {
  const p = projectByName(params[0])
  const agentId = await agentParam(p, decodeURIComponent(params[1]))
  const a = await agentDefOf(p, agentId)
  return assistantChange('agents', [API.change.startAgent, { agent: a.name, project: basename(p) }], { kind: 'start-agent', project: basename(p), agent: actAgent(a) }, async (guard) => {
    if (sessions.liveFor(p, agentId)) throw new HttpError(409, apiSaid(API.agent.alreadyRunning, { agent: a.name }))
    let resumeId: string | undefined
    if (typeof body?.resume === 'string' && body.resume) resumeId = body.resume
    else if (body?.resume) {
      resumeId = (await workspace.projectInfo(p)).agents.find((x) => x.id === agentId)?.resume?.id
      if (!resumeId) throw new HttpError(409, apiSaid(API.agent.noConversation, { agent: a.name }))
    }
    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : ''
    const st = prompt ? await startOnTask(p, agentId, a.name, prompt, (line) => sessions.start(p, { agentId, resumeId, prompt: line, allowed: guard })) : await sessions.start(p, { agentId, resumeId, allowed: guard })
    // A resume that started a new conversation says so, and why (HI-2540).
    return { done: [API.done.startedAgent, { agent: a.name, project: basename(p), resumed: resumeId && !st?.startedFresh ? 'yes' : 'no', fresh: st?.startedFresh ?? 'none' }], said: prompt ? ` on: ${clip(prompt.replace(/\s+/g, ' '), 80)}` : undefined, result: st, ...(st?.runId ? { started: { project: basename(p), agentId, run: st.runId } } : {}) }
  })
})

route('POST', '/v1/projects/:name/agents/:agent/stop', async ({ params, body, signal }) => {
  const p = projectByName(params[0])
  const agentId = await agentParam(p, decodeURIComponent(params[1]))
  const a = await agentDefOf(p, agentId)
  const ws = assistantCaller()
  return assistantChange('agents', [API.change.stopAgent, { agent: a.name, project: basename(p) }], { kind: 'stop-agent', project: basename(p), agent: actAgent(a) }, async (guard) => {
    const st = sessions.liveFor(p, agentId)
    if (!st) return { done: [API.done.notRunning, { agent: a.name, project: basename(p) }], result: { ok: true, wasRunning: false } }
    // Stopping an agent in the middle of something is the user's call; one only watching is idle (HI-1994).
    if (stopAsksUser(st.status) && ws) {
      // The user's question, in the window's language (HI-2449).
      const reason = typeof body?.reason === 'string' ? clip(body.reason.trim(), 300) : ''
      const how = await assistant.ask(ws, assistant.stopQuestion({ agent: a.name, project: basename(p), status: st.status, reason }), { timeoutMs: STOP_ASK_MS, signal })
      // Its question closed, whatever ended it: never left open in the panel with nobody waiting on it (HI-1994).
      if (how === 'timedOut') throw new HttpError(408, apiSaid(API.agent.stopAskTimedOut, { agent: a.name, seconds: String(STOP_ASK_MS / 1000) }))
      if (how === 'gone') throw new HttpError(409, apiSaid(API.agent.stopAskWithdrawn, { agent: a.name }))
      if (how === 'no') throw new HttpError(409, apiSaid(API.agent.stopAskDeclined, { agent: a.name }))
      // The answer can come minutes later: only the run the user was asked about, and only if Control still allows it.
      if (sessions.liveFor(p, agentId)?.runId !== st.runId) return { done: [API.done.alreadyStopped, { agent: a.name, project: basename(p) }], result: { ok: true, wasRunning: false } }
      if (!assistant.allows('agents')) throw new HttpError(403, apiSaid(API.agent.stopNotAllowed, { level: assistant.levelName(assistant.controlLevel()) }))
    }
    // Control and the Assistant's session that asked, checked again just before the stop (HI-2328).
    guard()
    // Its cause from the caller's token (HI-1881): the Assistant's, an agent's, or unknown (a script).
    sessions.stop(p, agentId, ws ? 'assistant' : agentCaller() ? 'agent' : undefined)
    return { done: [API.done.stoppedAgent, { agent: a.name, project: basename(p) }], result: { ok: true, wasRunning: true } }
  })
})

route('POST', '/v1/projects/:name/agents/:agent/prompt', async ({ params, body }) => {
  const p = projectByName(params[0])
  const agentId = await agentParam(p, decodeURIComponent(params[1]))
  const a = await agentDefOf(p, agentId)
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  if (!text) throw new HttpError(400, apiSaid(API.agent.textRequired))
  // A new conversation for the task (a new lane, say): the current one ends, as when it hands over to itself.
  const fresh = body?.newConversation === true
  return assistantChange<{ ok: boolean; id?: string; newConversation?: boolean }>('agents', [API.change.promptAgent, { agent: a.name, project: basename(p), fresh: fresh ? 'yes' : 'no' }], { kind: 'prompt-agent', project: basename(p), agent: actAgent(a) }, async (guard) => {
    const st = sessions.liveFor(p, agentId)
    // Never over the top of the agent's work, a question to the user, or the user's own typing.
    if (!st) throw new HttpError(409, apiSaid(API.agent.promptNotRunning, { agent: a.name }))
    if (st.status === 'starting') throw new HttpError(409, apiSaid(API.agent.promptStarting, { agent: a.name }))
    if (st.status === 'waiting') throw new HttpError(409, apiSaid(API.agent.promptWaiting, { agent: a.name, said: st.statusMessage ? 'yes' : 'no', message: st.statusMessage ?? '' }))
    if (st.status === 'working') throw new HttpError(409, apiSaid(API.agent.promptWorking, { agent: a.name }))
    if (st.status === 'signin') throw new HttpError(409, apiSaid(API.agent.promptSignIn, { agent: a.name }))
    if (st.status === 'watching') throw new HttpError(409, apiSaid(API.agent.promptWatching, { agent: a.name, waiting: st.watch?.label.replace(/^Waiting/, 'waiting') ?? say(API.agent.waitingOnCards), watch: st.watch?.agents && !st.watch.lanes ? 'agents' : 'cards' }))
    if (st.status === 'background') {
      throw new HttpError(409, apiSaid(API.agent.promptBackground, { agent: a.name, tasks: st.backgroundTasks ?? 0, total: String(st.backgroundTasks ?? 0) }))
    }
    if (sessions.userMayBeTyping(p, agentId)) throw new HttpError(409, apiSaid(API.agent.promptUserTyping, { agent: a.name }))
    // A line Combwork typed that its CLI hasn't taken (#430): more typing would be lost behind it, or clear it.
    if (sessions.lineUntaken(p, agentId)) throw new HttpError(409, apiSaid(API.agent.promptNotTaken, { agent: a.name }))
    if (agentNowFor(p, agentId).pending) throw new HttpError(409, apiSaid(API.agent.promptPending, { agent: a.name }))
    if (fresh) {
      // The Assistant's authority (Control, its session) again after the stop and at the launch: it may end meanwhile.
      await startOnTask(p, agentId, a.name, text, (line) => sessions.newConversation(p, agentId, line, guard)).catch((e: Error) => {
        const stopped = !sessions.liveFor(p, agentId)
        if (e instanceof assistant.ChangeRefused) {
          if (!stopped) throw e
          const why = say(e.status === 403 ? API.agent.freshWhyControl : API.agent.freshWhySession)
          throw new HttpError(e.status, apiSaid(API.agent.freshNotStarted, { agent: a.name, why }))
        }
        throw new HttpError(409, apiSaid(API.agent.freshFailed, { agent: a.name, error: e.message, stopped: stopped ? 'yes' : 'no' }))
      })
      return { done: [API.done.promptedFresh, { agent: a.name, project: basename(p) }], said: `: ${clip(text.replace(/\s+/g, ' '), 80)}`, result: { ok: true, newConversation: true } }
    }
    // A task delivery (#649), given now or not at all: never queued behind the agent's work.
    const r = await deliverNow(p, { agentId, agentName: a.name, conversation: st.sessionId || null, kind: 'task', from: callerSender(), body: text, need: 'free' }).catch((e: Error) => {
      if (e instanceof NotGiven) throw new HttpError(409, apiSaid(API.agent.promptFailed, { agent: a.name, error: e.message }))
      throw e
    })
    return { done: [API.done.prompted, { agent: a.name, project: basename(p), given: r ? 'yes' : 'no', id: r?.id ?? '' }], said: `: ${clip(text.replace(/\s+/g, ' '), 80)}`, result: { ok: true, ...(r ? { id: r.id } : {}) } }
  })
})

// A message for a running agent that may not take a prompt now (#530): a delivery (#647) offered at once when it can be
// (idle, or watching: its watch carries on), else queued and offered as its next line once it is idle; the agent can also
// fetch it with cw_inbox. cancel=true cancels those waiting.
route('POST', '/v1/projects/:name/agents/:agent/message', async ({ params, body }) => {
  const p = projectByName(params[0])
  const agentId = await agentParam(p, decodeURIComponent(params[1]))
  const a = await agentDefOf(p, agentId)
  if (body?.cancel === true) {
    return assistantChange<{ cancelled: number }>('agents', [API.change.cancelMessages, { agent: a.name, project: basename(p) }], { kind: 'cancel-messages', project: basename(p), agent: actAgent(a) }, async (guard) => {
      // Checked again in the deliveries' own transaction (HI-2420): revoked while it waited for their lock, none is cancelled.
      const n = await cancelMessages(p, agentId, sayStored([API.delivery.byAssistant]), guard)
      return { done: [API.done.cancelledMessages, { agent: a.name, project: basename(p), n, total: String(n) }], result: { cancelled: n } }
    })
  }
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  if (!text) throw new HttpError(400, apiSaid(API.agent.textRequired))
  if (text.length > MESSAGE_MAX_CHARS) throw new HttpError(400, apiSaid(API.agent.messageTooLong, { max: String(MESSAGE_MAX_CHARS), length: String(text.length) }))
  // Tied to a card's round (#652): stale, never given, once the card has moved on.
  const card = body?.card === undefined || body?.card === null ? undefined : Number(cardRefIn(body.card))
  if (card !== undefined && !(Number.isInteger(card) && card > 0)) throw new HttpError(400, apiSaid(API.agent.messageCardArg))
  return assistantChange<{ id: string; typed: boolean; queued: number; status: string; tells?: InboxSwitch[]; round?: number; card?: number; names?: Record<string, string> }>('agents', [API.change.messageAgent, { agent: a.name, project: basename(p) }], { kind: 'message-agent', project: basename(p), agent: actAgent(a), ...(card !== undefined ? { card } : {}) }, async (guard) => {
    const st = sessions.liveFor(p, agentId)
    if (!st) throw new HttpError(409, apiSaid(API.agent.messageNotRunning, { agent: a.name }))
    guard()
    // Its sender saved with it: the Assistant's launch, whose permission is worked out again at every step (#645).
    const r = await leaveMessage(p, agentId, a.name, callerSender(), text, card).catch((e: Error) => {
      throw httpFrom(409, e)
    })
    if (r.fate === 'cancelled' || r.fate === 'expired' || r.fate === 'refused' || r.fate === 'stale') throw new HttpError(409, apiSaid(API.agent.messageNotTyped, { agent: a.name, why: r.fate === 'cancelled' ? (r.detail ?? 'cancelled') : `${r.fate}, ${r.detail ?? ''}` }))
    const typed = r.fate === 'typed'
    const tied = r.round && card !== undefined ? { tied: 'yes', card: cardRef(card), round: String(r.round) } : { tied: 'no', card: '', round: '' }
    // Queued: the ways Combwork tells it, by the carrying-on switches on for it now (#1497: its project's own, else Settings').
    const on = typed ? null : await Promise.all(INBOX_SWITCHES.map((s) => inboxSwitch(p, s)))
    const tells = on ? INBOX_SWITCHES.filter((_s, i) => on[i]) : null
    return { done: [API.done.messaged, { agent: a.name, project: basename(p), id: r.id, typed: typed ? 'yes' : 'no', ...tied }], said: `: ${clip(text.replace(/\s+/g, ' '), 80)}`, result: { id: r.id, typed, queued: r.queued, status: typed ? (sessions.liveFor(p, agentId)?.status ?? 'stopped') : st.status, ...(tells ? { tells } : {}), ...(r.round ? { round: r.round, ...(card !== undefined ? { card, ...withNames([card]) } : {}) } : {}) } }
  })
})

/**
 * Who an Agent API call's delivery is from (#645, #649): the Assistant's launch, whose permission is worked out again at
 * every step; else the user (their own scripts).
 */
function callerSender(): DeliverySender {
  const ws = assistantCaller()
  // Stored with the delivery: said in the Default.
  if (!ws) return { kind: 'user', name: sayStored([API.delivery.fromUser]) }
  const launch = sessions.liveFor(assistant.assistantHome(ws), ASSISTANT_AGENT_ID)?.runId ?? ''
  return { kind: 'assistant', name: sayStored([API.delivery.fromAssistant]), workspace: ws, launch }
}

/** Starts an agent on a task (#649): a task delivery its launch carries as its prompt, received once its CLI takes it. */
const startOnTask = <T extends LiveSessionState>(p: string, agentId: string, agentName: string, prompt: string, start: (line: string) => Promise<T>): Promise<T> =>
  launchWith(p, { agentId, agentName, kind: 'task', from: callerSender(), body: prompt }, start).then((x) => x.launched)

// The Assistant's journal (#1031): its tools (cw_journal_*) only, only while it is on (Settings → Assistant → Journal).
// The tools come and go with the Assistant's start; each call checks again, so one turned off meanwhile is refused.
function journalHome(): { home: string; settings: JournalSettings } {
  if (!assistantCaller()) throw new HttpError(403, apiSaid(API.journal.onlyAssistant))
  const ws = requireWorkspace()
  const settings = journalSettingsOf(ws)
  if (!settings.enabled) throw new HttpError(409, apiSaid(API.journal.off))
  return { home: ws.assistantHome, settings }
}
/** A journal call: the caller's mistakes are 400s, said plainly; one while the journal is being deleted, 409. */
function journalCall<T>(fn: () => T): T {
  try {
    return fn()
  } catch (e) {
    if (e instanceof JournalBusy) throw httpFrom(409, e)
    if (e instanceof JournalError) throw httpFrom(400, e)
    throw e
  }
}
const entryId = (raw: string): number => {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, apiSaid(API.journal.entryId))
  return n
}
/**
 * A card link's ref as the journal keeps it (HI-1661): the card's number, as Combwork's own facts link it, so an entry the
 * Assistant links by key (`HI-12`, an old key, `#12`) is found by the same card's recall and shows its chip. A ref no card
 * has is kept as it was given.
 */
function cardLinksByNumber(ws: WorkspaceService, links: unknown): unknown {
  if (!Array.isArray(links)) return links
  return links.map((l) => {
    if (!l || typeof l !== 'object' || (l as { type?: unknown }).type !== 'card' || typeof (l as { ref?: unknown }).ref !== 'string') return l
    const n = cardOfRef(ws, (l as { ref: string }).ref)
    return n === null ? l : { ...l, ref: String(n) }
  })
}
function withCardLinks<T>(ws: WorkspaceService, body: T, fields: string[]): T {
  const b = { ...((body ?? {}) as Record<string, unknown>) }
  for (const f of fields) if (f in b) b[f] = f === 'link' ? (cardLinksByNumber(ws, [b[f]]) as unknown[])[0] : cardLinksByNumber(ws, b[f])
  return b as T
}
route('POST', '/v1/journal', async ({ body }) => {
  const { home, settings } = journalHome()
  const input = withCardLinks(requireWorkspace(), body, ['links'])
  return { id: journalCall(() => writeEntry(home, settings, input, 'assistant')) }
})
route('POST', '/v1/journal/recall', async ({ body }) => {
  const { home } = journalHome()
  const query = withCardLinks(requireWorkspace(), body, ['link'])
  return { entries: journalCall(() => recall(home, query)) }
})
route('GET', '/v1/journal/:id', async ({ params }) => {
  const { home } = journalHome()
  const e = journalCall(() => readEntry(home, entryId(params[0])))
  if (!e) throw new HttpError(404, apiSaid(API.journal.noEntry, { entry: params[0] }))
  return e
})
route('PATCH', '/v1/journal/:id', async ({ params, body }) => {
  const { home, settings } = journalHome()
  const id = entryId(params[0])
  const patch = withCardLinks(requireWorkspace(), body, ['addLinks'])
  if (!journalCall(() => updateEntry(home, settings, id, patch))) throw new HttpError(404, apiSaid(API.journal.noEntry, { entry: String(id) }))
  return { id, updated: true }
})
route('DELETE', '/v1/journal/:id', async ({ params }) => {
  const { home } = journalHome()
  const id = entryId(params[0])
  if (!journalCall(() => deleteEntry(home, id))) throw new HttpError(404, apiSaid(API.journal.noEntry, { entry: String(id) }))
  return { id, deleted: true }
})

// A successful build of Combwork itself (#1534): scripts/buildFact.mjs, from npm run dist or npm run release, with the
// workspace token or the agent's own (an agent running the build). Combwork writes it into the workspace's journal as its fact.
route('POST', '/v1/builds', async ({ body }) => {
  const f = buildFactOf(body)
  if ('error' in f) throw new HttpError(400, f.error)
  return recordBuild(requireWorkspace(), f)
})

/** Who is calling cw_inbox: a project agent (its own), or the Assistant (its home's). */
function inboxOwner(): { host: string; agentId: string } {
  const me = agentCaller()
  if (me) return { host: me.projectPath, agentId: me.agentId }
  if (assistantCaller()) return { host: requireWorkspace().assistantHome, agentId: ASSISTANT_AGENT_ID }
  throw new HttpError(400, apiSaid(API.inbox.noInbox))
}

// cw_inbox (#647): the caller's deliveries not received yet (a card's events in one item), now received; with ack, marks
// those ids acked and lists nothing. With ack and read: true (#1531, opt-in), both in one call: the ack first, by the
// ack's own rules, then the read, whose items are received only (an item is never acked by being read). An id that
// isn't the caller's is unknown, like one that doesn't exist.
route('POST', '/v1/inbox', async ({ body }) => {
  const { host, agentId } = inboxOwner()
  if (body?.read !== undefined && typeof body.read !== 'boolean') throw new HttpError(400, apiSaid(API.inbox.readArg))
  // Its rows name cards by key, for the Combwork tools' words (#1219).
  const named = <T extends { items: InboxItem[] }>(inbox: T) => ({ ...inbox, ...withNames(inbox.items.flatMap((i) => (i.card ? [i.card] : []))) })
  if (body?.ack !== undefined) {
    if (!Array.isArray(body.ack) || !body.ack.length || body.ack.length > 200 || !body.ack.every((x: unknown) => typeof x === 'string' && x.length <= 32)) throw new HttpError(400, apiSaid(API.inbox.ackArg))
    const ids = (body.ack as string[]).map((x) => x.trim())
    return body.read === true ? named(await ackThenRead(host, agentId, ids)) : ackDeliveries(host, agentId, ids)
  }
  return named(await readInbox(host, agentId))
})

// An agent's deliveries with their states and times (#647): the newest `limit` (default 20, at most 200).
route('GET', '/v1/projects/:name/agents/:agent/deliveries', async ({ params, query }) => {
  const p = projectByName(params[0])
  ownProjectOnly(p, [API.own.readingDeliveries])
  const agentId = await agentParam(p, decodeURIComponent(params[1]))
  const limit = Math.min(200, Math.max(1, Number(query.get('limit')) || 20))
  return deliveryView(p, agentId, limit, 300)
})

/** How much of an agent's last task and reply its activity shows without detail (GET …/activity?detail=true for all). */
/** How much of an agent's activity a reply carries: the short form, and with detail. */
const ACTIVITY_SHORT = { task: 300, reply: 500, tools: 3, summary: 100 }
const ACTIVITY_DETAIL = { task: 2000, reply: 3000, tools: 10, summary: 200 }

/**
 * A safeguard note as an agent's activity gives it (#606): when its CLI's safety classifier last stopped a response, on
 * which model, how many times this launch, the names of its last tool calls before it, the model it runs on since (when
 * that changed), and whether it waits on the CLI's prompt about it or is idle after it.
 */
function safeguardActivity(n: SafeguardNote) {
  return {
    ...(n.stops ? { stoppedAt: n.at, stops: n.stops, ...(n.model ? { model: n.model } : {}), toolsBefore: n.tools } : {}),
    ...(n.switched ? { switchedTo: n.switched.to, switchedFrom: n.switched.from, switchedAt: n.switched.at } : {}),
    ...(n.prompt ? { waitingOnPrompt: true } : {}),
    ...(n.idle ? { idleAfterStop: true } : {})
  }
}

/** What an agent is doing: its status, the task it was last given, its latest reply, its recent tool calls, its locked files. */
async function agentActivity(p: string, agentId: string, detail = false) {
  const info = await workspace.projectInfo(p)
  const a = info.agents.find((x) => x.id === agentId)
  if (!a) throw new HttpError(404, apiSaid(API.agent.unknown))
  const st = a.live
  const sessionId = st?.sessionId || a.lastSessionId || a.resume?.id || ''
  let currentTask: string | null = null
  let latestReply: string | null = null
  let recentTools: { tool: string; summary: string; failed: boolean }[] = []
  let toolCalls = 0
  // What was cut short, so the caller knows what it hasn't read: each text's whole length in characters.
  const clipped: { currentTask?: number; latestReply?: number } = {}
  const lim = detail ? ACTIVITY_DETAIL : ACTIVITY_SHORT
  if (sessionId) {
    const t = await transcripts.read(p, sessionId).catch(() => null)
    const items = t?.items ?? []
    const lastUser = items.map((x) => x.kind).lastIndexOf('user')
    const task = lastUser >= 0 ? items[lastUser] : null
    if (task?.kind === 'user') {
      // Its last prompt Combwork's doorbell (#650: ids only): the task it was last given is the newest one (or handover) delivered.
      const given = isDoorbell(task.text) ? (await deliveriesOf(p, agentId)).findLast((r) => r.kind === 'task' || r.kind === 'handover')?.body : undefined
      const text = given ?? task.text
      currentTask = clip(text, lim.task)
      if (text.length > lim.task) clipped.currentTask = text.length
    }
    const reply = [...items].reverse().find((x) => x.kind === 'assistant')
    if (reply?.kind === 'assistant') {
      latestReply = clip(reply.text, lim.reply)
      if (reply.text.length > lim.reply) clipped.latestReply = reply.text.length
    }
    // A Codex script stands for the calls it made, when its Codex records them (HI-2240): they are what it did.
    const turn = items.slice(Math.max(0, lastUser)).flatMap((x) => (x.kind === 'tool' ? callsMade(x.tool).map((c) => ({ tool: c.name, summary: clip(c.summary, lim.summary), failed: c.isError })) : []))
    toolCalls = turn.length
    recentTools = turn.slice(-lim.tools)
  }
  // Where it is now and where a new conversation would start (#1451), each with why in a word.
  const place = await agentPlace(p, a, st ? { cwd: st.cwd } : null)
  const folder = place.now.path
  // Only while the user may still be typing there (Settings → Assistant → Pause after you type), as Combwork itself holds off
  // (HI-2261: kept after their Enter, it read as "the user just typed" and the Assistant wouldn't give the agent work).
  const typed = sessions.userMayBeTyping(p, agentId) ? sessions.userTypedAt(p, agentId) : 0
  const provider = st?.provider ?? agentProvider(a, config.settings)
  // What was left for it (#530, #647): unread and overdue, and its latest deliveries with their states and times.
  const inbox = await deliveryView(p, agentId, detail ? 20 : 5)
  // The model and effort it runs with, and its time waiting for its CLI to retry a throttled or failed request (HI-1996):
  // a slow round told from a throttled one.
  const inUse = modelInUse(st)
  const retryWaits = retryWaitsView(st)
  return {
    project: info.name,
    agent: a.name,
    id: a.id,
    provider,
    ...inUse,
    // Another model than its launch gave it (HI-2609): the model it was launched with, beside the one it runs.
    ...(st?.modelSwitch ? { launchedModel: st.modelSwitch.launched } : {}),
    status: st?.status ?? 'stopped',
    statusMessage: statusMessageOf(st),
    ...(retryWaits ? { retryWaits } : {}),
    ...(watchingOf(st) ? { watching: watchingOf(st) } : {}),
    ...(progressOf(p, a.id) ? { progress: progressOf(p, a.id) } : {}),
    reviewing: st?.review ?? null,
    backgroundTasks: st?.backgroundTasks ?? 0,
    // With detail, its runtime as separate facts (#648): what the status word stands for, unknown included.
    ...(detail ? { runtime: st ? agentRuntime(st) : null } : {}),
    folder: { at: place.now.at, why: place.now.why },
    // Where a new conversation would start, when that isn't where it is now (replies stay short: replysize).
    ...(place.launch.path !== place.now.path ? { launchFolder: { at: place.launch.at, why: place.launch.why } } : {}),
    ...(place.now.slot ? { slot: place.now.slot } : {}),
    branch: place.branch,
    sessionId: sessionId || null,
    // A long transcript slows the CLI and Combwork; handing over to itself (a new conversation) makes it short again.
    transcriptMB: st?.transcriptBytes !== undefined ? Math.round((st.transcriptBytes / (1024 * 1024)) * 10) / 10 : null,
    transcriptWarnMB: transcriptWarnLimit(info.config, config.settings.sessions.transcriptWarnMB) || null,
    sessionName: st?.sessionName ?? null,
    currentTask,
    latestReply,
    /** This turn's tool calls: how many, and the last few (three; ten with detail), each summary clipped. */
    toolCalls,
    recentTools,
    ...(Object.keys(clipped).length ? { clipped } : {}),
    // Its CLI's safety classifier stopped a response or its model changed after one (#606): only names, never content.
    ...(st?.safeguard ? { safeguard: safeguardActivity(st.safeguard) } : providerDescriptor(provider).safeguardHelp === null ? { safeguard: say(API.activity.safeguardNotDetected) } : {}),
    lockedFiles: sessions.locksFor(p, agentId).map((f) => placeRelative(folder, f) || f),
    userTypedSecondsAgo: typed ? Math.round((Date.now() - typed) / 1000) : null,
    ...(inbox.deliveries.length ? { inbox } : {})
  }
}

route('GET', '/v1/projects/:name/agents/:agent/activity', async ({ params, query }) => {
  const p = projectByName(params[0])
  ownProjectOnly(p, [API.own.readingActivity])
  return agentActivity(p, await agentParam(p, decodeURIComponent(params[1])), query.get('detail') === 'true')
})

/**
 * Whether a launch of an agent (its CW_RUN_ID) is still its running one (#1008): a test run started in an agent's
 * shell records it, and a run waiting for a test slot asks, to say when the holder was left over by a session that has
 * ended (Combwork closed, the agent stopped or restarted). Status, as agents' is: open to every caller.
 */
route('GET', '/v1/projects/:name/agents/:agent/launches/:run', async ({ params }) => {
  const p = projectByName(params[0])
  const id = await agentParam(p, decodeURIComponent(params[1]))
  return { running: sessions.liveFor(p, id)?.runId === decodeURIComponent(params[2]) }
})

/** An agent as a wait reads it: a prompt Combwork just typed that its CLI hasn't taken yet counts as working (#416). */
const agentNowFor = (p: string, id: string): AgentNow => sessions.agentNow(p, id) ?? { status: 'stopped', runId: null, prompts: 0, pending: false }

/**
 * Waits until agents stop working (or `timeoutSeconds`, at most 10 minutes): the ones named, else every agent
 * working in the workspace. Answers with each one's status, so the caller sees who finished and who needs the user.
 * `wake: true` (#416): the calling agent or Assistant registers an agent watch instead and ends its turn; Combwork types one
 * line into it when one finishes, waits for the user or stops (main/watches.ts). `cancel: true` ends its watch. Agents'
 * status is open to every caller, as before; another project's agent's reply isn't in a project agent's line.
 */
route('POST', '/v1/agents/wait', async ({ body }) => {
  const me = agentCaller()
  const home = assistantCaller() ? requireWorkspace().assistantHome : null
  const who = me ? { projectPath: me.projectPath, agentId: me.agentId } : home ? { projectPath: home, agentId: 'assistant' } : null
  if (body?.cancel === true) {
    if (!who) throw new HttpError(400, apiSaid(API.watch.noWatchToCancel))
    const w = sessions.watchFor(who.projectPath, who.agentId)
    const kind = w?.lanes ? 'lane' : w?.agents ? 'agent' : 'card'
    const had = await cancelWatch(requireWorkspace(), who.projectPath, who.agentId)
    return { done: had ? say(API.watch.cancelled, { kind }) : say(API.watch.noneToCancel) }
  }
  const list: { project: string; agent?: string }[] = Array.isArray(body?.agents) ? body.agents : []
  let targets: { p: string; id: string }[] = []
  for (const x of list) {
    const p = projectByName(String(x.project))
    targets.push({ p, id: await agentParam(p, x.agent) })
  }
  // An agent waits on itself never; without names, every agent working.
  const self = (p: string, id: string): boolean => !!who && resolvePath(p).toLowerCase() === resolvePath(who.projectPath).toLowerCase() && id === who.agentId
  // An agent waiting on its background tasks carries on when they end: not done yet, unless the caller says so.
  const throughBackground = body?.ignoreBackground !== true
  if (!list.length) {
    const ws = requireWorkspace()
    // A watch follows only those working now (one waiting for the user would answer it at once).
    const wanted = (s: LiveSessionState): boolean => (body?.wake === true ? agentBusy(agentNowFor(s.projectPath, s.agentId), !throughBackground) : busy(s))
    targets = sessions
      .liveStates()
      .filter((s) => wanted(s) && workspaceOf(s.projectPath) === ws && !workspace.isAssistantHome(s.projectPath) && !self(s.projectPath, s.agentId))
      .map((s) => ({ p: s.projectPath, id: s.agentId }))
  }
  if (body?.wake === true) {
    if (!who) throw new HttpError(400, apiSaid(API.watch.wakeOnlyAgents))
    if (targets.some((t) => self(t.p, t.id))) throw new HttpError(400, apiSaid(API.watch.notYourself))
    const limit = body?.limitMinutes === undefined ? WATCH_DEFAULT_LIMIT_MINUTES : Number(body.limitMinutes)
    if (!Number.isFinite(limit) || limit < 1 || limit > WATCH_MAX_LIMIT_MINUTES) throw new HttpError(400, apiSaid(API.watch.limitMinutes, { max: String(WATCH_MAX_LIMIT_MINUTES) }))
    const unique = targets.filter((t, i) => targets.findIndex((u) => resolvePath(u.p).toLowerCase() === resolvePath(t.p).toLowerCase() && u.id === t.id) === i)
    if (!unique.length) return { already: [say(API.watch.noAgentWorking)] }
    if (unique.length > AGENT_WATCH_MAX_AGENTS) throw new HttpError(400, apiSaid(API.watch.maxAgents, { max: String(AGENT_WATCH_MAX_AGENTS) }))
    const agents: WatchedAgent[] = []
    for (const t of unique) agents.push({ projectPath: t.p, agentId: t.id, name: (await agentDefOf(t.p, t.id)).name, project: basename(t.p) })
    const r = await registerAgentWatch(requireWorkspace(), who.projectPath, who.agentId, { agents, ignoreBackground: !throughBackground }, limit)
    const ended = { ...(r.replaced ? { replaced: r.replaced } : {}), ...(r.dropped ? { dropped: r.dropped } : {}), ...(r.lanesLeft ? { lanesLeft: r.lanesLeft } : {}) }
    if ('already' in r) return { already: r.already, ...ended }
    return { watching: r.watching.label, limitAt: r.watching.limitAt, ...ended }
  }
  const limit = Math.min(waitMaxSeconds('agents'), Math.max(5, Number(body?.timeoutSeconds) || 300)) * 1000
  const t0 = Date.now()
  const working = (): boolean => targets.some((t) => agentBusy(agentNowFor(t.p, t.id), !throughBackground))
  while (working() && Date.now() - t0 < limit) await new Promise((r) => setTimeout(r, 1000))
  const agents = []
  for (const t of targets) {
    const def = projectAgents(await workspace.projectConfig(t.p)).find((a) => a.id === t.id)
    const s = sessions.liveFor(t.p, t.id)
    agents.push({ project: basename(t.p), agent: def?.name ?? t.id, status: s?.status ?? 'stopped', statusMessage: statusMessageOf(s), backgroundTasks: s?.backgroundTasks ?? 0, ...(watchingOf(s) ? { watching: watchingOf(s) } : {}) })
  }
  return { timedOut: working(), waitedSeconds: Math.round((Date.now() - t0) / 1000), agents }
})

// The merge slot (#350): one merge at a time into a project's branch. Its own project's only, for an agent; held by
// a running agent (its launch), never by what a request says.

/** The calling agent as a holder of its project's slot. Scripts and the Assistant can look, not claim. */
async function slotAgent(p: string): Promise<SlotAgent> {
  const a = agentCaller()
  if (!a) throw new HttpError(403, apiSaid(API.mergeSlot.onlyAgents))
  ownProjectOnly(p, [API.own.mergeSlot])
  const live = sessions.liveFor(a.projectPath, a.agentId)
  if (!live) throw new HttpError(409, apiSaid(API.mergeSlot.onlyRunning))
  const def = projectAgents(await workspace.projectConfig(a.projectPath)).find((x) => x.id === a.agentId)
  return { projectPath: a.projectPath, agentId: a.agentId, agentName: def?.name ?? a.agentId, runId: live.runId }
}

/**
 * A claim naming cards Combwork merges (each card's own rules, #1354): refused before the slot is touched, as the card's
 * report merge would be (`merge.combworkMerges`, recorded as Refused, saying where it is in the merge queue). A claim naming
 * no card, or cards the agent merges, is unchanged: the slot stays for agents' merges and the user's own.
 */
async function refuseCombworkMerges(projectPath: string, cards: number[]): Promise<void> {
  if (!cards.length) return
  const wf = await workflowFor(workspace, projectPath).catch(() => null)
  if (!wf) return
  const actor = actorOf(await taskActor())
  for (const n of cards) {
    const refused = await wf.refuseCombworkMerge(`#${n}`, actor, say(API.mergeSlot.moveName))
    if (refused) throw new tasks.WorkflowRefusedError(refused)
  }
}

/** The branch a slot call names, or the one the project folder is on (what Combwork's Merge dialog merges into). */
async function slotBranchFor(p: string, v: unknown): Promise<string> {
  if (v !== undefined && v !== null) return slotBranch(v)
  const b = await workspace.branch(p)
  if (!b) throw new HttpError(409, apiSaid(API.mergeSlot.noBranch))
  return b
}

const slotCall = async <T>(fn: () => Promise<T> | T): Promise<T> => {
  try {
    // The cards the slot's holders merge, named by key for the Combwork tools' words (#1219).
    return withCardsNamed(await fn())
  } catch (e) {
    throw e instanceof MergeSlotError ? httpFrom(e.status, e) : e
  }
}

route('GET', '/v1/projects/:name/merge-slot', async ({ params, query }) =>
  slotCall(async () => {
    const p = projectByName(params[0])
    ownProjectOnly(p, [API.own.readingMergeSlot])
    return mergeSlots.status(p, await slotBranchFor(p, query.get('branch') ?? undefined))
  })
)

route('POST', '/v1/projects/:name/merge-slot/claim', async ({ params, body, signal }) =>
  slotCall(async () => {
    const p = projectByName(params[0])
    const agent = await slotAgent(p)
    const branch = await slotBranchFor(p, body?.branch)
    const cards = slotCards(cardRefsIn(body?.cards))
    await refuseCombworkMerges(p, cards)
    const t = body?.timeoutSeconds
    if (t !== undefined && (typeof t !== 'number' || !Number.isFinite(t) || t < 0)) throw new HttpError(400, apiSaid(API.watch.timeoutSeconds))
    const waitMs = t === undefined ? DEFAULT_WAIT_MS : Math.min(MAX_WAIT_MS, t * 1000)
    const result = await mergeSlots.claim(agent, p, branch, cards, waitMs, signal)
    slotTestEvent(agent, p, branch, result)
    return { ...result, slot: mergeSlots.status(p, branch) }
  })
)

route('POST', '/v1/projects/:name/merge-slot/release', async ({ params, body }) =>
  slotCall(async () => {
    const p = projectByName(params[0])
    const agent = await slotAgent(p)
    // Naming no branch, it releases the agent's own hold, whatever branch the folder is on now (#586).
    const own = body?.branch === undefined || body?.branch === null ? mergeSlots.releaseBranch(agent, p) : null
    const branch = own ?? (await slotBranchFor(p, body?.branch))
    const result = mergeSlots.release(agent, p, branch)
    slotTestEvent(agent, p, branch, result)
    return result
  })
)

// Lanes (#483): the card loops a workspace runs. A project agent starts its own lane (as builder), joins its builder's
// (as reviewer) and sees its project's; the Assistant and scripts start them for any builder and see them all.
// Bookkeeping, never a gate: nothing else waits on a lane.

const laneCall = async <T>(fn: () => Promise<T> | T): Promise<T> => {
  try {
    return lanesNamed(await fn())
  } catch (e) {
    throw e instanceof lanes.LaneError ? httpFrom(e.status, e) : e
  }
}

/**
 * A lane reply with `names` for its cards (#1219 round 2, finding 1): on each lane (a list, an ended lane) or on the
 * change (started, joined), for the combwork MCP server that words it.
 */
function lanesNamed<T>(r: T): T {
  const numbersOf = (l: LaneInfo | null | undefined): number[] => (l ? [...l.cards.map((c) => c.number), ...(l.current !== null ? [l.current] : []), ...(l.pausedOn !== null ? [l.pausedOn] : []), ...(l.queued ?? []), ...(l.status?.card != null ? [l.status.card] : [])] : [])
  const isLane = (v: unknown): v is LaneInfo => !!v && typeof v === 'object' && Array.isArray((v as LaneInfo).cards) && typeof (v as LaneInfo).id === 'string'
  if (Array.isArray(r)) return r.map((l) => (isLane(l) ? { ...l, ...withNames(numbersOf(l)) } : l)) as T
  if (isLane(r)) return { ...r, ...withNames(numbersOf(r)) }
  const change = r as { lane?: unknown; replaced?: unknown } | null
  if (change && typeof change === 'object' && isLane(change.lane)) return { ...change, ...withNames([...numbersOf(change.lane), ...(isLane(change.replaced) ? numbersOf(change.replaced) : [])]) } as T
  return r
}

/** The project a lane call is about: a project agent's own (another named is refused), else the one named. */
function laneProject(v: unknown): string {
  const a = agentCaller()
  if (a) {
    if (v !== undefined && v !== null && v !== '') ownProjectOnly(projectByName(String(v)), [API.own.lane])
    return a.projectPath
  }
  if (typeof v !== 'string' || !v) throw new HttpError(400, apiSaid(API.lane.projectRequired))
  return projectByName(v)
}

/** A lane's numbers and texts from a request body (undefined: not given). */
function laneArgs(body: any): { cards?: number[]; rounds?: number; waitMinutes?: number; name?: string | null; brief?: string; target?: string | null } {
  const out: { cards?: number[]; rounds?: number; waitMinutes?: number; name?: string | null; brief?: string; target?: string | null } = {}
  if (body?.cards !== undefined) {
    const c = laneCards(cardRefsIn(body.cards))
    if (isSaid(c)) throw new HttpError(400, c)
    out.cards = c
  }
  for (const k of ['rounds', 'waitMinutes'] as const) {
    if (body?.[k] === undefined) continue
    const v = laneNumber(body[k], k, 0)
    if (isSaid(v)) throw new HttpError(400, v)
    out[k] = v
  }
  if (body?.name !== undefined) out.name = laneName(body.name)
  // The builder's brief (HI-1795): text, or '' to clear it; left out, a running lane keeps its own.
  if (body?.brief !== undefined) {
    if (typeof body.brief !== 'string') throw new HttpError(400, apiSaid(API.lane.briefText))
    if (body.brief.length > LANE_BRIEF_MAX) throw new HttpError(400, apiSaid(API.lane.briefMax, { max: String(LANE_BRIEF_MAX) }))
    out.brief = body.brief
  }
  // Its Merges into (HI-2556): a branch name, or null or '' for the project's own; checked by the lane's start.
  if (body?.target !== undefined) {
    if (body.target !== null && typeof body.target !== 'string') throw new HttpError(400, apiSaid(API.lane.targetText))
    out.target = body.target === null ? null : body.target.slice(0, 250)
  }
  return out
}

/** Who a lane change is by, as the board names them. */
async function laneBy(): Promise<string> {
  return tasks.actorName(await taskActor())
}

route('GET', '/v1/lanes', async ({ query }) =>
  laneCall(async () => {
    const ws = requireWorkspace()
    const a = agentCaller()
    const project = a ? basename(a.projectPath) : query.get('project') ? basename(projectByName(query.get('project')!)) : null
    return lanes.listLanes(ws, { project, all: query.get('all') === 'true' })
  })
)

// The next card of the calling agent's running lane (#1270, cw_lane next): to start, to carry on, or why it waits.
route('GET', '/v1/lanes/next', async () =>
  laneCall(async () => {
    const a = agentCaller()
    if (!a) throw new HttpError(400, apiSaid(API.lane.nextIsAgents))
    const r = await lanes.laneNext(requireWorkspace(), basename(a.projectPath), a.agentId)
    // Its passed cards Combwork merges, each with where it is in the merge queue (#1354): the next waits for them.
    const queue: { card: number; line: string }[] = []
    for (const c of r.lane.cards.filter((x) => x.column === 'passed')) {
      const line = await queueLineFor(r.lane.project, c.number)
      if (line) queue.push({ card: c.number, line })
    }
    // HI-2245: a card carried on with commits past its submission (its builder's only): not handed over yet.
    const unsubmitted = r.next?.carryOn ? await unsubmittedOf(requireWorkspace(), a.projectPath, a.agentId, [r.next.card]) : []
    return { ...r, ...(queue.length ? { queue } : {}), ...(unsubmitted.length ? { unsubmitted } : {}) }
  })
)

route('GET', '/v1/lanes/:id', async ({ params }) =>
  laneCall(async () => {
    const a = agentCaller()
    return lanes.getLane(requireWorkspace(), decodeURIComponent(params[0]), a ? basename(a.projectPath) : null)
  })
)

route('POST', '/v1/lanes', async ({ body }) => laneCall(() => laneStartCall(body)))

/**
 * cw_lane start (POST /v1/lanes), and a new card placed on a lane as it is made (HI-2167, `place`: POST /v1/tasks with
 * lane): one path, the same rules, launches and the Assistant's change for both.
 */
async function laneStartCall(body: any, place?: lanes.LanePlace): Promise<LaneChange> {
  const ws = requireWorkspace()
  const p = laneProject(body?.project)
  const args = laneArgs(body)
  if (place) args.cards = [place.card]
  if (!args.cards) throw new HttpError(400, apiSaid(API.lane.cardsArg))
  const a = agentCaller()
  // A project agent registers its own lane: it is the builder.
  const builder = a ? (body?.builder !== undefined && body.builder !== '' && (await agentParam(p, body.builder)) !== a.agentId ? null : a.agentId) : await agentParam(p, body?.builder)
  if (!builder) throw new HttpError(403, apiSaid(API.lane.agentStartsOwn))
  // A reviewer Combwork doesn't know isn't a reason to refuse a new lane: it starts without one, and its reviewer can join it.
  // A running lane's start naming one is refused, naming its reviewer (HI-2273: startLane, under its lock).
  let reviewer: string | null | undefined
  let unknownReviewer: string | undefined
  let note: string | undefined
  if (body?.reviewer === null || body?.reviewer === '') reviewer = null
  else if (body?.reviewer !== undefined) {
    reviewer = await agentParam(p, body.reviewer).catch(() => null)
    if (!reviewer) {
      unknownReviewer = String(body.reviewer)
      note = say(API.lane.noReviewerNamed, { reviewer: unknownReviewer, project: basename(p) })
    }
  }
  // Reviewed by the project's reviewer pool (HI-1581, G17), the Assistant's and a script's: refused as Start Lane…
  // refuses it (the rules have no pool, nobody but the builder reviews), and with a reviewer of its own.
  if (body?.pool !== undefined && typeof body.pool !== 'boolean') throw new HttpError(400, apiSaid(API.lane.poolArg))
  const pool = body?.pool === true
  // A changed list applied now, its card in flight put back (HI-1995).
  if (body?.applyNow !== undefined && typeof body.applyNow !== 'boolean') throw new HttpError(400, apiSaid(API.lane.applyNowArg))
  const applyNow = body?.applyNow === true
  if (pool && a) throw new HttpError(403, apiSaid(API.lane.poolStartedBy))
  if (pool && body?.reviewer !== undefined && body.reviewer !== null && body.reviewer !== '') throw new HttpError(400, apiSaid(API.lane.poolNoReviewer))
  if (pool) await checkLanePool(ws, p, builder)
  // `commit`: the Assistant's guard, checked again in the lanes' save (HI-2420).
  const start = async (commit?: () => void) => {
    // Combwork's own start of the lane's card waits for this one to launch its agents (HI-2029); a builder registering its
    // own loop is at work already.
    const release = a ? null : lanes.holdLaneStart(ws, basename(p), builder)
    try {
      return await started(commit)
    } finally {
      release?.()
    }
  }
  const started = async (commit?: () => void) => {
    const r = await lanes.startLane(ws, { project: basename(p), builder, reviewer, ...(unknownReviewer !== undefined ? { unknownReviewer } : {}), cards: args.cards!, rounds: args.rounds, waitMinutes: args.waitMinutes, name: args.name, brief: args.brief, ...(args.target !== undefined ? { target: args.target } : {}), briefNotIn: sessions.liveFor(p, builder)?.sessionId ?? null, by: await laneBy(), ...(pool ? { pool: true } : {}), ...(applyNow ? { applyNow: true } : {}), ...(place ? { place } : {}), ...(a ? { ownBuilder: true } : {}), ...(commit ? { commit } : {}) })
    // Its brief given where it goes (HI-1795): outside slots, delivered now (and again by laneBriefs' next look if not).
    // A new lane's brief carried from the builder's lane that had just ended (HI-2097) too.
    const rec = (await lanes.rawLanes(ws)).find((l) => l.id === r.lane.id)
    const briefed = args.brief !== undefined || (r.did === 'started' && !!rec?.brief)
    const told = briefed ? await briefNote(ws, rec ?? { project: basename(p) }) : null
    if (briefed) await settleLaneBriefs(ws)
    // Started for its builder by the Assistant or a script (HI-1900: a lane over stopped agents sat active, nothing lent,
    // nobody working it): its stopped agents started as Start Lane… starts them, its slot lent for a stopped builder; an
    // idle builder outside slots given the lane in a new conversation (HI-2232); another running one is left as it is,
    // and the reply says to tell it (HI-1934). A builder registering its own loop is
    // already at work. A running lane updated while its builder isn't running: its builder started on it.
    let launched = ''
    if (!a && r.did === 'started') launched = recordedLaneNote(await launchRecordedLane(ws, p, r.lane.id))
    else if (!a && r.did === 'updated') launched = await resumeLaneBuilder(p, r.lane)
    // The lane's own note first (an "Applied now:" stays its start; HI-2097's carried brief and Done cards left out).
    // A card in its list made by someone else since the caller's turn began (HI-2167): a guessed key, perhaps; a placed
    // card is its own. The caller's turn: a project agent's own, or the Assistant's; a script has none.
    const turn = a ? sessions.turnBegan(a.projectPath, a.agentId) : assistantCaller() ? sessions.turnBegan(ws.assistantHome, ASSISTANT_AGENT_ID) : null
    const fresh = place ? null : await lanes.freshCardsNote(ws, args.cards!, await laneBy(), turn, callerScope())
    const notes = [r.note, note, told, launched, fresh].filter(Boolean).join(' ')
    return notes ? { ...r, note: notes } : r
  }
  if (!assistantCaller()) return start()
  const builderAct = await knownAgent(basename(p), builder)
  return assistantChange('agents', [API.change.startLane, { project: basename(p) }], { kind: 'lane-start', project: basename(p), ...(args.cards ? { cards: args.cards } : {}), ...(builderAct ? { agent: builderAct } : {}) }, async (guard) => {
    // Recorded for undo by lanes.ts, from the lane as read under its lock, in its save (#1282), where its guard is
    // checked again (HI-2420). The agents launched for it after that save are its own (as the user's Start Lane…).
    const r = await start(guard)
    // #402: a lane the Assistant starts but doesn't watch goes unfollowed ("they'll tell you"): its reply says so. A
    // lane watch (#531) on every running lane, or on this one, follows it.
    const w = sessions.watchFor(ws.assistantHome, ASSISTANT_AGENT_ID)
    const followed = !!w?.lanes && (w.lanes.includes('all') || w.lanes.includes(r.lane.id))
    const nudge = followed ? '' : say(API.lane.noWatch)
    const result = nudge ? { ...r, note: [r.note, nudge].filter(Boolean).join(' ') } : r
    // A reorder applied now put a card back and gave the lane a card to start next (HI-1995): neither is undone.
    const putBack = applyNow && (r.note ?? '').startsWith('Applied now: ')
    const lane = { lane: r.lane.id, did: r.did, project: basename(p), builder: r.lane.builder.name, hasReviewer: r.lane.reviewer ? 'yes' : 'no', reviewer: r.lane.reviewer?.name ?? '', cards: r.lane.cards.map((c) => cardRef(c.number)).join(', ') }
    return { done: [API.done.laneStarted, { ...lane, putBack: putBack ? 'yes' : 'no', note: putBack ? r.note!.replace(/^Applied now: /, 'applied now: ') : '' }], act: laneAct(r.lane), result, ...(putBack ? { stays: UNDO_FINAL.laneReorderNow } : {}) }
  })
}

route('POST', '/v1/lanes/join', async ({ body }) =>
  laneCall(async () => {
    const ws = requireWorkspace()
    const p = laneProject(body?.project)
    const args = laneArgs(body)
    const a = agentCaller()
    const reviewer = a ? a.agentId : await agentParam(p, body?.reviewer)
    if (typeof body?.builder !== 'string' || !body.builder) throw new HttpError(400, apiSaid(API.lane.builderRequired))
    const builder = await agentParam(p, body.builder)
    const joined = async (commit?: () => void) => lanes.joinLane(ws, { project: basename(p), builder, reviewer, cards: args.cards, by: await laneBy(), ...(commit ? { commit } : {}) })
    if (!assistantCaller()) return joined()
    const reviewerAct = await knownAgent(basename(p), reviewer)
    return assistantChange('agents', [API.change.joinLane, { project: basename(p) }], { kind: 'lane-join', project: basename(p), ...(args.cards ? { cards: args.cards } : {}), ...(reviewerAct ? { agent: reviewerAct } : {}) }, async (guard) => {
      // Its guard checked again in the lanes' save (HI-2420).
      const r = await joined(guard)
      return { done: [API.done.laneJoined, { hasReviewer: r.lane.reviewer ? 'yes' : 'no', reviewer: r.lane.reviewer?.name ?? '', lane: r.lane.id, project: basename(p) }], act: { ...laneAct(r.lane), ...(r.lane.reviewer ? { agent: actAgent(r.lane.reviewer) } : {}) }, result: r }
    })
  })
)

route('POST', '/v1/lanes/:id/end', async ({ params, body }) =>
  laneCall(async () => {
    const ws = requireWorkspace()
    const id = decodeURIComponent(params[0])
    const a = agentCaller()
    const commit = body?.mergeCommit
    if (commit !== undefined && commit !== null && (typeof commit !== 'string' || !/^[0-9a-zA-Z._/-]{4,64}$/.test(commit))) throw new HttpError(400, apiSaid(API.lane.mergeCommitArg))
    // With rules enforced Combwork records the merge from the cards' facts (#1270, §16.8.2): an agent's commit is ignored, said.
    const ignored = commit && a && (await lanes.lanesEnforced()) ? { note: say(API.lane.mergeCommitIgnored) } : {}
    const end = async (guard?: () => void) => ({ ...(await lanes.endLane(ws, id, { abandoned: body?.abandoned === true, mergeCommit: commit ?? null, ...(a ? { project: basename(a.projectPath), agent: a.agentId } : {}), ...(guard ? { commit: guard } : {}) })), ...ignored })
    if (!assistantCaller()) return end()
    const laneId = /^[\w.-]{1,64}$/.test(id) ? id : null
    return assistantChange('agents', laneId ? [API.change.endLane, { lane: laneId }] : [API.change.endALane], { kind: 'lane-end', ...(laneId ? { lane: laneId } : {}) }, async (guard) => {
      // Its guard checked again in the lanes' save (HI-2420).
      const l = await end(guard)
      return { done: [API.done.laneEnded, { lane: l.id, project: l.project, state: l.state }], act: laneAct(l), result: l }
    })
  })
)

// A lane agent's new conversation no more tried, tried again (HI-2034): the user's (the lane's row) and the Assistant's
// within Settings → Assistant → Control, never a project agent's (it would restart another agent).
route('POST', '/v1/lanes/:id/fresh-start', async ({ params }) =>
  laneCall(async () => {
    notAgents([API.change.retryFreshAny])
    const ws = requireWorkspace()
    const id = decodeURIComponent(params[0])
    const lane = (await lanes.rawLanes(ws)).find((l) => l.id === id)
    if (!lane) throw new HttpError(404, apiSaid(API.lane.unknown, { lane: id }))
    const retry = async (guard?: () => void) => ({ retried: await retryFreshStart(ws, id, guard) })
    if (!assistantCaller()) return retry()
    return assistantChange('agents', [API.change.retryFresh, { lane: id }], { kind: 'lane-fresh-start', lane: id, project: lane.project }, async (guard) => {
      // Its guard checked again in each write it makes (HI-2420).
      const r = await retry(guard)
      return { done: [API.done.freshRetried, { lane: id, retried: r.retried, total: String(r.retried) }], result: r }
    })
  })
)

// --- The merge queue (#1353, SPEC §16.9.3): its model for whoever may read the project (an agent its own project's);
// Pause queue, Resume, Remove from queue and Retry merge are the user's (the window) and the Assistant's within
// Settings → Assistant → Control (assistantChange), never a project agent's or a script's.

/** The project a queue call is about: an agent's own (another's refused), anyone else's named. */
function queueProject(v: unknown): string {
  const a = agentCaller()
  if (a) {
    if (v !== undefined && v !== null && v !== '') ownProjectOnly(projectByName(String(v)), [API.own.mergeQueue])
    return a.projectPath
  }
  if (typeof v !== 'string' || !v) throw new HttpError(400, apiSaid(API.queue.projectRequired))
  return projectByName(v)
}

/** A queue's target from a request: the one given, else the project's only queue's (several or none: say which). */
async function queueTargetOf(ws: WorkspaceService, p: string, v: unknown): Promise<string> {
  if (v !== undefined && v !== null && v !== '') {
    if (typeof v !== 'string' || v.length > 255 || /[\s~^:?*[\\]/.test(v)) throw new HttpError(400, apiSaid(API.queue.targetArg))
    return v
  }
  // HI-2893: of the live queues only: a past branch's is named or never picked. HI-2994: of those that hold or held
  // something (an entry, an outcome, a pause, a card in flight), not each of the project's targets the listing has.
  const views = (await queueViews(ws, p)).filter((x) => !x.past && (!!x.testing || x.queued.length > 0 || x.recent.length > 0 || !!x.paused || !!x.runBy || x.inFlight.length > 0))
  if (views.length === 1) return views[0].target
  throw new HttpError(400, apiSaid(API.queue.targetRequired, { listed: views.length ? 'yes' : 'no', targets: views.map((x) => x.target).join(', ') }))
}

/** A queue as the Agent API gives it: no folder (a stuck advance's neither), and whether an outcome has a log rather than the log itself (lean). */
const publicQueue = ({ projectPath: _p, paused, combworkMerges: _h, inFlight: _i, returns: _r, returnsMore: _more, pauses: _pauses, ...v }: QueueView): QueuePublic => ({
  ...v,
  paused: paused ? (({ stuck, message: _m, ...p }) => (stuck ? { ...p, stuck: (({ folder: _f, ...s }) => s)(stuck) } : p))(paused) : null,
  recent: v.recent.map(({ log: output, seen: _s, revision: _rev, tookMs: _took, push: _push, logPath: _lp, ...r }) => (output ? { ...r, hasLog: true as const } : r))
})

/** A project agent asking to change a queue: refused, saying whose controls these are. */
function notAgents(what: Said): void {
  if (agentCaller()) throw new HttpError(403, apiSaid(API.queue.notAgents, { what: sayNow(what) }))
}

route('GET', '/v1/queue', async ({ query }) => {
  const ws = requireWorkspace()
  const p = queueProject(query.get('project'))
  const target = query.get('target') || undefined
  if (target && (target.length > 255 || /[\s~^:?*[\\]/.test(target))) throw new HttpError(400, apiSaid(API.queue.targetArg))
  // HI-2893: the project's targets' queues and any holding an entry; past branches' only with past=true, or one named.
  const past = query.get('past') === 'true'
  return (await queueViews(ws, p, target)).filter((v) => !v.past || past || !!target).map(publicQueue)
})

route('POST', '/v1/queue/pause', async ({ body }) => {
  notAgents([API.change.pauseAQueue])
  const ws = requireWorkspace()
  const p = queueProject(body?.project)
  return assistantChange('agents', [API.change.pauseQueue, { project: basename(p) }], { kind: 'queue-pause', project: basename(p) }, async (guard) => {
    const target = await queueTargetOf(ws, p, body?.target)
    const v = await pauseQueue(ws, p, target, 'assistant', guard)
    return { done: [API.done.queuePaused, { target, project: basename(p) }], result: publicQueue(v) }
  })
})

route('POST', '/v1/queue/resume', async ({ body }) => {
  notAgents([API.change.resumeAQueue])
  const ws = requireWorkspace()
  const p = queueProject(body?.project)
  return assistantChange('agents', [API.change.resumeQueue, { project: basename(p) }], { kind: 'queue-resume', project: basename(p) }, async (guard) => {
    const target = await queueTargetOf(ws, p, body?.target)
    const r = await resumeQueue(ws, p, target, guard)
    return { done: [API.done.queueResumed, { target, project: basename(p), resumed: r.resumed ? 'yes' : 'no', hasReason: r.view.paused?.reason ? 'yes' : 'no', reason: r.view.paused?.reason ?? '' }], result: { resumed: r.resumed, queue: publicQueue(r.view) } }
  })
})

// --- Pausing the team before an update (HI-2081): the Assistant's, for its own workspace only (HR1's s12 check); the
// user's pause of every workspace is the window's. Another open workspace is told as one line, with none of its agents.

/** Agents (and scripts) don't pause or resume the team: the user's, and the Assistant's within Control agents. */
function notTeamAgents(what: Said): void {
  if (agentCaller()) throw new HttpError(403, apiSaid(API.team.notAgents, { what: sayNow(what) }))
}

/** The team's state as the Assistant sees it: its workspace's in full, any other open one as one line with no names. */
async function teamFor(ws: WorkspaceService): Promise<{ paused: boolean; pausedBy: string | null; since: string | null; parked: boolean; safeToInstall: boolean; running: { project: string; agent: string; state: string; what: string }[]; others: string[] }> {
  // The asking Assistant's own turn isn't counted, only its (round 1, finding 4): a script's ask counts it.
  const own = await scanWorkspace(ws, assistantCaller() ? { assistantOf: ws } : {})
  const others = openWorkspaces().filter((w) => w.path && w !== ws)
  const lines: string[] = []
  let othersOk = true
  for (const w of others) {
    const v = await scanWorkspace(w)
    if (!v.pause) {
      othersOk = false
      lines.push(say(API.team.otherNotPaused))
    } else if (!v.parked) {
      othersOk = false
      lines.push(say(API.team.otherNotParked))
    }
  }
  return {
    paused: !!own.pause,
    pausedBy: own.pause?.by ?? null,
    since: own.pause?.since ?? null,
    parked: own.parked,
    safeToInstall: own.parked && othersOk,
    running: own.items.map((i) => ({ project: i.project, agent: i.agent, state: i.state, what: i.what })),
    others: lines
  }
}

route('GET', '/v1/team', async () => {
  notTeamAgents([API.change.readTeam])
  return teamFor(requireWorkspace())
})

route('POST', '/v1/team/pause', async () => {
  notTeamAgents([API.change.pauseTeam])
  const ws = requireWorkspace()
  return assistantChange('agents', [API.change.pauseTeam], { kind: 'team-pause' }, async (guard) => {
    guard()
    const p = await pauseTeam(ws, 'assistant')
    return { done: [API.done.teamPaused, { pause: p.pauseId }], result: await teamFor(ws) }
  })
})

route('POST', '/v1/team/resume', async () => {
  notTeamAgents([API.change.resumeTeam])
  const ws = requireWorkspace()
  return assistantChange('agents', [API.change.resumeTeam], { kind: 'team-resume' }, async (guard) => {
    guard()
    const was = await resumeTeam(ws)
    return { done: [API.done.teamResumed, { was: was ? 'yes' : 'no' }], result: await teamFor(ws) }
  })
})

/** A held writer as the Agent API lists it (#1561): who holds it, its run and Combwork, and the processes Combwork lists of it. */
const publicHeld = (w: HeldRow) => ({ slot: w.slot, agent: w.agentName, run: w.run, combwork: w.combwork.self ? say(API.slot.heldThisCombwork) : say(API.slot.heldGone, { pid: String(w.combwork.pid) }), processes: w.processes ? { list: w.processes.list.map((p) => ({ pid: p.pid, label: p.label })), more: w.processes.more } : null })

/** Release Slot's refusals (#1561) as the Agent API answers them. */
const slotRefusal = (e: unknown): unknown => (e instanceof SlotReleaseRefused ? httpFrom(e.status, e) : e)

// What a project has to release (#1561): carried slots (#1441) and held writers (#1506), as the agents' ⋯ offer them.
route('GET', '/v1/projects/:name/slots/releasable', async ({ params }) => {
  const p = projectByName(params[0])
  ownProjectOnly(p, [API.own.readingSlots])
  const r = await releasableSlots(p)
  return { project: basename(p), carried: r.carried.map((c) => ({ slot: c.slot, agent: c.agent.name })), held: r.held.map(publicHeld) }
})

// Release Slot (#1561): a carried slot, or a held writer once confirmed (its slot and run), as the window's ⋯ does.
route('POST', '/v1/projects/:name/slots/:slot/release', async ({ params, body }) => {
  if (agentCaller()) throw new HttpError(403, apiSaid(API.slot.notAgents))
  const p = projectByName(params[0])
  const slot = decodeURIComponent(params[1])
  const kind = body?.kind === undefined ? undefined : body.kind === 'carried' || body.kind === 'writer' ? body.kind : null
  if (kind === null) throw new HttpError(400, apiSaid(API.slot.kindArg))
  const confirm = body?.confirm && typeof body.confirm === 'object' ? (body.confirm as { slot?: unknown; run?: unknown }) : null
  return assistantChange('agents', [API.change.releaseSlot, { slot, project: basename(p) }], { kind: 'release-slot', project: basename(p) }, async (guard) => {
    const r = await releaseSlot(requireWorkspace(), p, slot, { ...(kind ? { kind } : {}), confirm, end: body?.end === true, guard }).catch((e) => {
      throw slotRefusal(e)
    })
    await workspaceOf(p).refresh()
    return { done: [API.done.slotReleased, { kind: r.kind === 'carried' ? 'carried' : 'writer', slot: r.slot, project: basename(p), agent: r.agent.name, ended: r.ended ? 'yes' : 'no' }], act: { agent: { id: r.agent.id, name: r.agent.name } }, result: { project: basename(p), ...r, agent: r.agent.name } }
  })
})

/** The Assistant's alone (HI-1502): a template's list, plan and load. Project agents, scripts and the user's token are refused before any template is read. */
function assistantTemplates(what: Said): void {
  if (!assistantCaller()) throw new HttpError(403, apiSaid(API.template.onlyAssistant, { what: sayNow(what) }))
}

/** A body's workflow argument: true unless false (HI-1502: its workflow is applied by default, as the window's tick box is). */
function workflowArg(body: any): boolean {
  if (body?.workflow !== undefined && typeof body.workflow !== 'boolean') throw new HttpError(400, apiSaid(API.template.workflowArg))
  return body?.workflow !== false
}

// The templates a project can use (HI-1502): Combwork's own, the workspace's and its own, a row each.
route('GET', '/v1/projects/:name/templates', async ({ params }) => {
  assistantTemplates([API.change.listTemplates])
  const p = projectByName(params[0])
  return { project: basename(p), templates: await templateRows(p) }
})

// What loading a template would do (HI-1502): nothing is changed.
route('POST', '/v1/projects/:name/templates/plan', async ({ params, body }) => {
  assistantTemplates([API.change.planTemplate])
  const p = projectByName(params[0])
  const e = await findTemplate(p, body ?? {})
  return (await planReply(p, e, body?.names, workflowArg(body), body?.connections)).reply
})

// Loading a template (HI-1502): the window's load, its names given, its workflow saved unless workflow is false; undoable.
route('POST', '/v1/projects/:name/templates/load', async ({ params, body }) => {
  assistantTemplates([API.change.loadATemplate])
  const p = projectByName(params[0])
  const applyWorkflow = workflowArg(body)
  const named = typeof body?.template === 'string' ? [API.change.loadTemplate, { template: clip(body.template, 60), project: basename(p) }] as const : [API.change.loadUnnamedTemplate, { project: basename(p) }] as const
  return assistantChange('agents', named, { kind: 'load-template', project: basename(p) }, async (guard) => {
    const e = await findTemplate(p, body ?? {})
    const r = await loadForAssistant(p, e, body?.names, applyWorkflow, guard, body?.connections)
    const workflow = r.workflow ? (r.workflow.saved ? 'saved' : 'notSaved') : 'none'
    return { done: [API.done.templateLoaded, { template: r.template.name, project: r.project, agents: String(r.created.length), workflow, options: String(r.workflow?.changes.length ?? 0) }], stays: UNDO_FINAL.templateCards, result: r }
  })
})

// Choose Connections… (HI-2109): the project's existing agents given connections by role or name, nothing loaded; undoable.
route('POST', '/v1/projects/:name/templates/apply', async ({ params, body }) => {
  assistantTemplates([API.change.chooseConnectionsAny])
  const p = projectByName(params[0])
  return assistantChange('agents', [API.change.chooseConnections, { project: basename(p) }], { kind: 'update-agent', project: basename(p) }, async (guard) => {
    const r = await applyForAssistant(p, body?.connections, guard)
    return { done: [API.done.connectionsChosen, { project: r.project, changed: String(r.changed.length), skipped: r.skipped.length, skippedTotal: String(r.skipped.length) }], result: r }
  })
})

/** Remove from queue or Retry merge, the Assistant's: its reason required, run as the card's intent (#1353). */
async function queueCard(body: any, kind: 'removeFromQueue' | 'retryMerge'): Promise<IntentDone> {
  notAgents([kind === 'removeFromQueue' ? API.change.removeFromQueueAny : API.change.retryMergeAny])
  const ws = requireWorkspace()
  const ref = intentRef(String(body?.card ?? ''))
  const reason = textField(body, 'reason', true)
  const was = await tasks.getTask(ref.n).catch(() => null)
  return assistantChange('agents', intentWhat(kind, ref.n), { kind: 'update-task', card: ref.n, ...(was?.project ? { project: was.project } : {}) }, async (guard) => {
    const { done, card } = await queueCardChange(ws, ref.n, await taskActor(), kind, reason, guard)
    return { done: intentDone(kind, card, done), act: { column: card.column, agent: await cardAgent(card) }, result: done, stays: INTENT_STAYS[kind] }
  })
}

route('POST', '/v1/queue/remove', async ({ body }) => queueCard(body, 'removeFromQueue'))
// HI-2680: after a project's target moved on, what can follow the new one: the Assistant's (within Control agents) and
// the user's, never a project agent's or a script's. With `preview` (the id a target change's reply, or a preview here,
// offered): only the items named that the offered preview listed, each as it was seen then (HR1's round 1, finding 4),
// rechecked as it moves, Control asked at each move. Without: a preview (from, to), offered and listed, moving nothing.
route('POST', '/v1/workflow/retarget', async ({ body }) => {
  notAgents([API.change.retargetAny])
  const ws = requireWorkspace()
  const p = queueProject(body?.project)
  const id = typeof body?.preview === 'string' ? body.preview.trim().slice(0, 40) : ''
  const items = Array.isArray(body?.items) ? (body.items as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 500) : []
  if (!id) {
    // A preview is the Assistant's too (the user's is the window's): never a script's.
    if (!assistantCaller()) throw new HttpError(403, apiSaid(API.change.onlyAssistant, { what: sayNow([API.change.retargetAny]) }))
    const from = typeof body?.from === 'string' ? body.from.trim().slice(0, 250) : ''
    const to = typeof body?.to === 'string' ? body.to.trim().slice(0, 250) : ''
    if (!from || !to) throw new HttpError(400, say(API.queue.retargetArgs))
    const preview = await retargetPreview(ws, p, from, to)
    return { preview: offerRetarget(p, preview), from, to, move: [...(preview.laneMoves ?? []).map((l) => l.name ?? l.builder), ...preview.cards.move.map((c) => c.key), ...preview.slots.move.map((s) => s.name)], stay: [...preview.cards.keep.map((c) => ({ key: c.key, why: c.why })), ...preview.slots.keep.map((s) => ({ slot: s.name, why: s.why })), ...preview.lanes.map((l) => ({ lane: l.name ?? l.builder, why: l.why ?? 'running' }))] }
  }
  if (!items.length) throw new HttpError(400, say(API.queue.retargetArgs))
  const offered = offeredRetarget(id, p)
  if (!offered) throw new HttpError(409, say(API.queue.retargetGone, { preview: id }))
  const { from, to } = offered
  return assistantChange('agents', [API.change.retarget, { project: basename(p), from, to }], { kind: 'retarget', project: basename(p) }, async (guard) => {
    const { confirmed, unknown } = offeredItems(offered, items)
    const r = await retargetApply(ws, p, confirmed, await taskActor(), guard)
    const result = { ...r, skipped: [...r.skipped, ...unknown.map((x) => ({ key: x, why: 'notOffered' as const }))] }
    return { done: [API.done.retargeted, { from, to, cards: String(r.moved.cards.length), slots: String(r.moved.slots.length), skipped: String(result.skipped.length) }], result }
  })
})
// HI-2679: bring one of a project's targets up to date with another (a forward merge), the Assistant's (within Control
// agents) and the user's: never a project agent's or a script's.
route('POST', '/v1/queue/forward', async ({ body }) => {
  notAgents([API.change.forwardAny])
  const ws = requireWorkspace()
  const p = queueProject(body?.project)
  const from = typeof body?.from === 'string' ? body.from.trim().slice(0, 250) : ''
  const to = typeof body?.to === 'string' ? body.to.trim().slice(0, 250) : ''
  if (!from || !to) throw new HttpError(400, say(API.queue.forwardArgs))
  // HI-2892: the user's explicit override of the release path's direction, only as the JSON boolean true.
  if (body?.override !== undefined && body.override !== true && body.override !== false) throw new HttpError(400, say(API.queue.overrideArg))
  const override = body?.override === true
  return assistantChange('agents', [API.change.forward, { project: basename(p), from, to, override: override ? 'yes' : 'no' }], { kind: 'queue-forward', project: basename(p) }, async (guard) => {
    const r = await forwardMerge(ws, p, from, to, await taskActor(), guard, { override }).catch((e: unknown) => {
      throw e instanceof ForwardRefused ? new HttpError(e.kind === 'invalid' ? 400 : e.kind === 'forbidden' ? 403 : 409, agentError(e)) : e
    })
    const made = 'upToDate' in r ? null : r
    // HI-3126: under follow mode, the local source's commits its remote lacks, left out.
    const ahead = r.localAhead ?? 0
    const done: Said = made ? [API.done.forwardQueued, { from, to, card: cardName(made.card), queued: made.queued ? 'yes' : 'no', override: made.overridden ? 'yes' : 'no', ahead }] : [API.done.forwardUpToDate, { from, to, ahead }]
    return { done, ...(made ? { act: { card: made.card.number, column: made.card.column, project: basename(p) } } : {}), result: { upToDate: !made, card: made?.card.number ?? null, key: made?.card.key ?? null, queued: made?.queued ?? false, from, to, ...(made?.overridden ? { overridden: true } : {}), ...(ahead ? { localAhead: ahead } : {}) } }
  })
})
// HI-2959: Resolve on a builder, on a forward merge the queue returned: the Assistant's (within Control agents, its
// reason required) and the user's, never a project agent's or a script's.
route('POST', '/v1/queue/resolve', async ({ body }) => {
  notAgents([API.change.resolveForwardAny])
  const ws = requireWorkspace()
  const ref = intentRef(String(body?.card ?? ''))
  const reason = textField(body, 'reason', true)
  const was = await tasks.getTask(ref.n).catch(() => null)
  return assistantChange('agents', [API.change.resolveForward, { card: was?.key ?? `#${ref.n}` }], { kind: 'update-task', card: ref.n, ...(was?.project ? { project: was.project } : {}) }, async (guard) => {
    const r = await resolveForward(ws, ref.n, await taskActor(), reason, guard).catch((e: unknown) => {
      throw e instanceof ForwardRefused ? new HttpError(e.kind === 'invalid' ? 400 : e.kind === 'forbidden' ? 403 : 409, agentError(e)) : e
    })
    return { done: [API.done.forwardResolved, { card: cardName(r.card), forward: r.forward, from: r.from, to: r.to, source: r.source.slice(0, 12) }], act: { card: r.card.number, column: r.card.column, ...(was?.project ? { project: was.project } : {}) }, stays: UNDO_FINAL.forwardResolved, result: { card: r.card.number, key: r.card.key ?? null, forward: r.forward, from: r.from, to: r.to, source: r.source } }
  })
})
/** A git refusal as the Agent API answers it (HI-2807): its own status where it has a kind, else 409. */
const gitRefused = (e: unknown): unknown => (e instanceof CombworkError ? httpFrom(ownStatus(e) ?? 409, e) : e)

// HI-2807: a branch made from a branch, tag or commit, never switched to: the Assistant's (within Control agents) and the
// user's (in the window), never a project agent's or a script's. `commit` pins the start (refused if `from` moved);
// recorded for undo, which removes it only while it is still there, unused.
route('POST', '/v1/git/branch', async ({ body }) => {
  notAgents([API.change.createBranchAny])
  const p = queueProject(body?.project)
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 250) : ''
  const from = branchStartArg({ ref: body?.from, commit: body?.commit })
  if (!name || !from) throw new HttpError(400, say(API.queue.branchArgs))
  return assistantChange('agents', [API.change.createBranch, { name, from: from.ref, project: basename(p) }], { kind: 'create-branch', project: basename(p) }, async (guard) => {
    const start = await withRepoLock(
      p,
      // The guard at once, and again right before git creates it (after its reads).
      async () => {
        guard()
        return lineRepoOps('createLine').makeLine(p, name, from, guard)
      },
      { project: p }
    ).catch((e: unknown) => {
      throw gitRefused(e)
    })
    await noteChange(requireWorkspace(), branchChange(basename(p), name, start.commit))
    return { done: [API.done.branchCreated, { name, from: from.ref, commit: start.short, project: basename(p) }], result: { name, from: from.ref, commit: start.short } }
  })
})
// HI-2807: Start the next version, as the window's dialog does it, in one hold: the branch made at the project's target's
// head (pinned by `commit` when given), the target added to Other branches, Work merges into moved to the new branch.
// `from` (required, HI-3114): Work merges into as the caller saw it, as the dialog sends it, so a retried or repeated
// request is refused once the project has moved on rather than starting a second version from the first.
// What can follow is offered as a retarget preview made before the branch existed, both going on (started cards and
// running lanes stay), applied with /v1/workflow/retarget. Recorded for undo: the branch and the two options.
route('POST', '/v1/workflow/next-version', async ({ body }) => {
  notAgents([API.change.createBranchAny])
  const ws = requireWorkspace()
  const p = queueProject(body?.project)
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 250) : ''
  const from = branchStartArg({ ref: body?.from, commit: body?.commit })
  if (!from) throw new HttpError(400, say(API.queue.nextVersionArgs))
  return assistantChange('agents', [API.change.nextVersion, { project: basename(p) }], { kind: 'next-version', project: basename(p) }, async (guard) => {
    let r: NextVersionResult
    try {
      r = await startNextVersion(ws, p, { name, from, check: guard, preview: true })
    } catch (e) {
      // The branch kept after a refused save: recorded, so undo can still take it back.
      if (e instanceof NextVersionPartial) await noteChange(ws, branchChange(basename(p), e.branch.name, e.branch.commit))
      throw gitRefused(e)
    }
    // For undo, newest first: the options, then the branch. As the settings tool records them (their own value or inherit).
    await noteChange(ws, branchChange(basename(p), r.name, r.commit))
    const own = (v: unknown): unknown => v ?? 'inherit'
    if (JSON.stringify(own(r.was.otherTargets)) !== JSON.stringify(r.now.otherTargets)) await noteChange(ws, { kind: 'setting', project: basename(p), target: 'project.workflow.otherTargets', fields: [{ field: 'value', old: own(r.was.otherTargets) as Value, new: r.now.otherTargets }] })
    await noteChange(ws, { kind: 'setting', project: basename(p), target: 'project.workflow.target', fields: [{ field: 'value', old: own(r.was.target) as Value, new: r.now.target }] })
    const items = r.preview ? [...r.preview.cards.move.map((c) => c.key), ...r.preview.slots.move.map((s) => s.name)] : []
    const offer = r.preview && items.length ? offerRetarget(p, r.preview) : null
    return {
      done: [API.done.nextVersionStarted, { name: r.name, from: r.from, commit: r.short, project: basename(p), added: r.added ? 'yes' : 'no' }],
      result: { name: r.name, from: r.from, commit: r.short, added: r.added, ...(offer ? { retarget: { preview: offer, move: items, stay: [...r.preview!.cards.keep.map((c) => ({ key: c.key, why: c.why })), ...r.preview!.slots.keep.map((s) => ({ slot: s.name, why: s.why })), ...r.preview!.lanes.map((l) => ({ lane: l.name ?? l.builder, why: l.why ?? 'running' }))] } } : {}) }
    }
  })
})
route('POST', '/v1/queue/retry', async ({ body }) => queueCard(body, 'retryMerge'))

route('GET', '/v1/shared', async () => inWorkspace(requireWorkspace(), () => notesTree()))

// A project's handovers, newest first (under its earlier folder names too, #514); no project: every one. Their paths
// as /v1/shared/file takes them. What cw_read_latest_handover and the session guidance find.
route('GET', '/v1/shared/handovers', async ({ query }) => {
  const name = query.get('project')
  const project = name ? projectByName(name) : null
  const ws = project ? workspaceOf(project) : requireWorkspace()
  const list = await inWorkspace(ws, () => handoversFor(ws, project ? basename(project) : undefined))
  return list.map((f) => ({ path: f.relPath, ...(f.modified ? { modified: f.modified } : {}) }))
})

route('GET', '/v1/shared/file', async ({ query }) => {
  const rel = query.get('path')
  if (!rel) throw new HttpError(400, apiSaid(API.note.pathRequired))
  const abs = inWorkspace(requireWorkspace(), () => assertInShared(rel))
  return { path: rel, ...(await readNote(abs).catch(() => { throw new HttpError(404, apiSaid(API.note.notFound)) })) }
})

route('PUT', '/v1/shared/file', async ({ query, body }) => {
  const rel = query.get('path') ?? body?.path
  if (!rel) throw new HttpError(400, apiSaid(API.note.pathRequired))
  const abs = inWorkspace(requireWorkspace(), () => assertInShared(rel))
  // Workspace notes reach every agent at launch (#1433): the user's and the Assistant's to write, never a project agent's.
  if (agentCaller() && resolvePath(abs).toLowerCase() === resolvePath(inWorkspace(requireWorkspace(), () => workspaceNotesFile(workspace.sharedDir))).toLowerCase()) {
    throw new HttpError(403, apiSaid(API.note.workspaceNotesReadOnly, { path: WORKSPACE_NOTES_PATH }))
  }
  const content = String(body?.content ?? '')
  // Only a write that leaves it out is unguarded: one given (null, empty, not a string) must be a revision.
  const expected: unknown = body && typeof body === 'object' && 'expectedRevision' in body ? body.expectedRevision : undefined
  if (expected !== undefined && (typeof expected !== 'string' || !expected)) throw new HttpError(400, apiSaid(API.note.expectedRevision))
  const { revision } = await writeNote(abs, rel, content, { append: !!body?.append, expectedRevision: expected as string | undefined }).catch((e) => {
    throw e instanceof NoteConflict ? new HttpError(409, e.message, { revision: e.current }) : e
  })
  emit({ type: 'notes-changed' })
  return { ok: true, path: rel, revision }
})

// ---------------------------------------------------------------------------
// Documents by section (#817): a long plan's or note's outline, and one section of it, so an agent reads what it needs.
// A project's Markdown (its own project only, for a project agent: in the folder it works in, its worktree if it has
// one) or a shared note (shared:<path>).
// ---------------------------------------------------------------------------

/** A section longer than this comes as its own text and its subsections' outline, unless asked for in full. */
const SECTION_MAX = 30_000

/** The document a docs call names, read: its text and the reference it goes by. */
async function docOf(query: URLSearchParams): Promise<{ ref: string; text: string }> {
  const path = query.get('path')?.trim()
  if (!path) throw new HttpError(400, apiSaid(API.doc.pathRequired))
  let root: string
  let rel: string
  if (path.startsWith(SHARED_PREFIX)) {
    // The request's workspace's notes, as /v1/shared/file reads them: an agent's and the Assistant's are their own,
    // whatever project or workspace the request names.
    root = requireWorkspace().sharedDir
    rel = path.slice(SHARED_PREFIX.length)
  } else {
    const name = query.get('project')
    const own = agentCaller()
    if (!name && !own) throw new HttpError(400, apiSaid(API.doc.projectRequired))
    const p = name ? projectByName(name) : own!.projectPath
    // An agent: its own project only. The Assistant: its own workspace's (projectByName).
    ownProjectOnly(p, [API.own.readingDocs])
    // A project agent reads its own copy: the folder it works in now (#1451: its running session's, its slot). from=project:
    // the project folder's, the copy a card's Read first references (#818) were written against, as its dialog and start
    // prompt read them.
    const fromProject = query.get('from') === 'project'
    const def = own && !fromProject && resolvePath(own.projectPath).toLowerCase() === resolvePath(p).toLowerCase() ? projectAgents(await workspace.projectConfig(p)).find((a) => a.id === own.agentId) : undefined
    const live = def ? sessions.liveFor(p, def.id) : null
    root = def ? (await agentPlace(p, def, live ? { cwd: live.cwd } : null)).now.path : p
    rel = path
  }
  const r = await readDoc(root, rel)
  if (r.ok) return { ref: path, text: r.text }
  const why = {
    outside: apiSaid(API.doc.outside, { path, where: path.startsWith(SHARED_PREFIX) ? 'shared' : 'project' }),
    hidden: apiSaid(API.doc.hidden, { path }),
    notMarkdown: apiSaid(API.doc.notMarkdown, { path }),
    notFound: apiSaid(API.doc.notFound, { path }),
    tooBig: apiSaid(API.doc.tooBig, { path, megabytes: String(Math.round(DOC_MAX / 1048576)) })
  }[r.code]
  throw new HttpError(r.code === 'notFound' ? 404 : 400, why)
}

/** A heading as the docs calls give it. */
const headingRow = (h: DocHeading) => ({ level: h.level, text: h.text, slug: h.slug, line: h.line, size: h.size })

route('GET', '/v1/docs/outline', async ({ query }) => {
  const { ref, text } = await docOf(query)
  return { path: ref, size: text.length, headings: docOutline(text).map(headingRow) }
})

route('GET', '/v1/docs/section', async ({ query }) => {
  const asked = query.get('heading')?.trim()
  const { ref, text } = await docOf(query)
  const outline = docOutline(text)
  if (!asked) {
    // No heading: the whole document (a card's reference to a whole file, #818), long ones as their top headings.
    const top = outline.filter((x) => x.level === Math.min(...outline.map((y) => y.level)))
    if (text.length > SECTION_MAX && top.length && query.get('full') !== 'true') {
      const intro = text.split(/\r?\n/).slice(0, top[0].line - 1).join('\n').replace(/\n+$/, '')
      return { path: ref, size: text.length, content: intro, subsections: top.map(headingRow), partial: true }
    }
    return { path: ref, size: text.length, content: text }
  }
  const found = findHeading(outline, asked)
  const list = (hs: DocHeading[]): string => hs.map((h) => say(API.doc.headingRow, { slug: h.slug, heading: h.text, line: String(h.line) })).join(', ')
  if ('ambiguous' in found) throw new HttpError(409, apiSaid(API.doc.severalSections, { doc: ref, asked, list: list(found.ambiguous) }), { matches: found.ambiguous.map(headingRow) })
  if ('closest' in found) throw new HttpError(404, found.closest.length ? say(API.doc.noSection, { asked, doc: ref, list: list(found.closest) }) : say(API.doc.noHeadings, { doc: ref }), { closest: found.closest.map(headingRow) })
  const h = found.heading
  const content = sectionText(text, h)
  // A long section with subsections: its own text and their outline, unless asked for in full.
  const lines = content.split('\n')
  const inside = outline.filter((x) => x.line > h.line && x.line < h.line + lines.length)
  const subs = inside.filter((x) => x.level === Math.min(...inside.map((y) => y.level)))
  if (content.length > SECTION_MAX && subs.length && query.get('full') !== 'true') {
    const intro = lines.slice(0, subs[0].line - h.line).join('\n').replace(/\n+$/, '')
    return { path: ref, heading: headingRow(h), content: intro, subsections: subs.map(headingRow), partial: true }
  }
  return { path: ref, heading: headingRow(h), content }
})

/**
 * Who is writing a handover, for its header: the Assistant (its own token), or the agent whose Combwork tools sent
 * it (they pass its id and project). Others (scripts, the user) leave no author.
 */
async function handoverAuthor(body: any): Promise<HandoverAuthor | null> {
  const own = assistantCaller()
  // agent-protocol: a handover header's author field, which code matches
  if (own) return { author: 'Assistant', session: sessions.liveFor(assistant.assistantHome(own), ASSISTANT_AGENT_ID)?.sessionId || undefined }
  if (typeof body?.agent !== 'string' || !body.agent || typeof body?.agentProject !== 'string') return null
  try {
    const p = projectByName(body.agentProject)
    const cfg = await workspace.projectConfig(p)
    const a = projectAgents(cfg).find((x) => x.id === body.agent)
    if (!a) return null
    const st = sessions.liveFor(p, a.id)
    return { author: `${a.name} (${providerName(st?.provider ?? agentProvider(a, config.settings))})`, session: st?.sessionId || undefined }
  } catch {
    return null
  }
}

/** The window's notice of a handover an agent saved, in the window's language (the handover's own title as written). */
export const handoverCreatedToast = (project: string, title: string, file: string): ToastMessage =>
  toast('info', tr(msg({ id: 'content.notes.handoverCreated', defaultMessage: 'Handover created', description: "A notice's title: an agent saved a handover in the shared notes; the project and the handover's title follow." })), `${project ? project + ': ' : ''}${title}`, [
    { label: tr(msg({ id: 'content.notes.openHandover', defaultMessage: 'Open', description: "The notice's button: opens the handover an agent just saved." })), command: 'notes.open', args: [file] }
  ])

route('POST', '/v1/shared/handovers', async ({ body }) => {
  if (!body?.title || !body?.content) throw new HttpError(400, apiSaid(API.note.titleContentRequired))
  // For a named project, its workspace's notes; else the request's workspace.
  // The project's own name, also when it was given as "<workspace>/<project>".
  const project = body.project ? projectByName(String(body.project)) : null
  const ws = project ? workspaceOf(project) : requireWorkspace()
  const name = project ? basename(project) : ''
  const by = await handoverAuthor(body)
  const file = await inWorkspace(ws, () => createHandover(name, String(body.title), String(body.content), by))
  emit({ type: 'notes-changed' })
  handoverCreatedToast(name, String(body.title), file)
  // The Assistant with its journal off suggests it, once (#1032).
  const suggest = assistantCaller() ? await journalSuggestion(ws).catch(() => null) : null
  return { ok: true, path: file, ...(suggest ? { suggest } : {}) }
})

// ---------------------------------------------------------------------------
// The task board. Agents and the Assistant read, change and move cards (Done included); archiving and deleting are
// the user's. Only the Assistant starts cards on agents.
// ---------------------------------------------------------------------------

/**
 * Who is using the board: the Assistant, a project agent (known by its own token: confined to its project's cards,
 * whatever the request says), or a script with the workspace token (the whole board, as the user's board).
 */
async function taskActor(): Promise<tasks.TaskActor> {
  if (assistantCaller()) return { kind: 'assistant' }
  const agent = agentCaller()
  if (agent) {
    const project = basename(agent.projectPath)
    const def = await workspace
      .projectConfig(agent.projectPath)
      .then((cfg) => projectAgents(cfg).find((x) => x.id === agent.agentId))
      .catch(() => undefined)
    return { kind: 'agent', name: `${def?.name ?? agent.agentId} (${project})`, self: { project, agentId: agent.agentId }, scope: project }
  }
  // agent-protocol: the name a script's change is recorded under
  return { kind: 'agent', name: 'Agent API' }
}

/**
 * A card with what its agent is doing now (and its name now), for callers deciding what to do next. `agents` keeps
 * each project's agents for a whole list, so a long board reads each project.json once.
 */
/** A card's merge-queue line (#1354, queueState.ts), when its project has a workflow and its rules say Combwork merges it. */
async function queueLineFor(project: string, n: number): Promise<string | null> {
  try {
    const wf = await workflowFor(workspace, projectByName(project))
    return wf?.queueLineOf(`#${n}`) ?? null
  } catch {
    return null
  }
}

/** A code card's checks and their hint (HI-2276, toolReplies' checksView), when its project's workflow rules name checks. */
async function checksFor(project: string, n: number): Promise<{ checks: string[]; checksHint: string } | null> {
  try {
    const wf = await workflowFor(workspace, projectByName(project))
    return wf?.checksOf(`#${n}`) ?? null
  } catch {
    return null
  }
}

/**
 * A card's open requests as agents read them (HI-1992): each asker by its name in the card's project, as For you shows it
 * (its id once the agent is gone). `agents` as taskView's, so a listing reads each project.json once.
 */
async function requestsFor(items: readonly ForYouItem[], agents = new Map<string, Promise<ReturnType<typeof projectAgents>>>(), summary = false): Promise<CardRequest[] | undefined> {
  const project = items.find((i) => i.asker)?.project
  let defs: ReturnType<typeof projectAgents> = []
  if (project) {
    try {
      const p = projectByName(project)
      const key = p.toLowerCase()
      if (!agents.has(key)) agents.set(key, workspace.projectConfig(p).then(projectAgents))
      defs = await agents.get(key)!
    } catch {
      // Its project gone: the asker's id.
    }
  }
  return cardRequests(items.map((i) => (i.asker ? { ...i, asker: defs.find((a) => a.id === i.asker)?.name ?? i.asker } : i)), summary)
}

/**
 * A card as agents read it. `attachmentsOf` (HI-2402, a narrowed read): only the attachments that came with those
 * comments (by id), the rest counted in `attachmentsOmitted`.
 */
async function taskView(c: TaskCard, agents =new Map<string, Promise<ReturnType<typeof projectAgents>>>(), waitingOf?: ReadonlyMap<number, ForYouItem[]>, attachmentsOf?: ReadonlySet<string>): Promise<TaskView> {
  let agent: { id: string; name: string; status: string; backgroundTasks: number } | null = null
  let now: StallAgent | null = null
  if (c.agent && c.project) {
    try {
      const p = projectByName(c.project)
      const key = p.toLowerCase()
      if (!agents.has(key)) agents.set(key, workspace.projectConfig(p).then(projectAgents))
      const def = (await agents.get(key)!).find((a) => a.id === c.agent)
      const st = sessions.liveFor(p, c.agent)
      agent = { id: c.agent, name: def?.name ?? c.agentName ?? c.agent, status: def ? (st?.status ?? 'stopped') : 'removed', backgroundTasks: st?.backgroundTasks ?? 0 }
      now = def ? agentNowOf(p, c.agent, def.name) : null
    } catch {
      agent = { id: c.agent, name: c.agentName ?? c.agent, status: 'removed', backgroundTasks: 0 }
    }
  }
  // Nobody working on a Doing card: the Assistant reports these and suggests who could take them.
  // Entry ids are the card watches' (#224): left out, so replies stay as lean as before.
  // Its decisions first (#357): what the user decided, which agents follow over the description. Its holds (#602) are
  // for its cost in Combwork's window: left out.
  const { number, title, decisions, held: _held, ...rest } = c
  // Its running lane, for a card waiting in Review: its lane may be deadlocked (#1410).
  const lane = c.column === 'review' && c.project ? (await lanes.listLanes(workspace, { project: c.project }).catch(() => [])).find((l) => (l.state === 'active' || l.state === 'paused') && l.cards.some((x) => x.number === c.number)) : undefined
  const inLane = lane ? new Map((await tasks.allTasks(workspace, { numbers: lane.cards.map((x) => x.number) }).catch(() => [])).map((x) => [x.number, x])) : null
  // Its attachments (HI-1700): full paths, and its text's links to them as those paths (agents open them by path).
  const files = await cardAttachments(workspace, c.number)
  const paths = (t: string): string => withAttachmentPaths(t, files)
  // Its requests waiting for the user (HI-1932), just after its decisions (HI-1992: an Assistant reading the card looks
  // there first, not in its history): their ids, for a decision that answers them. A listing reads them once for all its
  // cards (`waitingOf`), never the whole board per card.
  const forYou = await requestsFor((waitingOf ?? forYouOfCards(workspace, [c.number])).get(c.number) ?? [], agents)
  const view: Omit<TaskView, 'stage'> = {
    number,
    title,
    ...(decisions?.length ? { decisions: decisions.map(tasks.withoutId) } : {}),
    ...(forYou ? { forYou } : {}),
    ...rest,
    ...(files.length ? { description: paths(c.description) } : {}),
    comments: c.comments.map(entryForAgents).map((e) => (files.length ? { ...e, text: paths(e.text) } : e)),
    history: c.history.map(entryForAgents),
    agent,
    // A Doing card nobody works on, a card an agent was looping on and left with no watch (#376), or one in Review its
    // watching reviewer hasn't started on (#521), or one its lane's deadlock holds up (#1410), or a design nobody checks (#1382).
    stalled: cardStall(c, now, workspace.path, lane && inLane ? laneOrderView(lane, (n) => inLane.get(n)) : null, await stepWaitOf(workspace, c), undefined, undefined, await reviewDueOf(workspace, c), c.column === 'doing' && !c.agent && c.project && workspace.path ? await forwardWaitOf(workspace, join(workspace.path, c.project), c.number) : null)
  }
  // A review whose reviewer has gone or isn't running (Combwork ends those, but one can show while that happens).
  if (c.review && c.project) {
    try {
      const p = projectByName(c.project)
      const key = p.toLowerCase()
      if (!agents.has(key)) agents.set(key, workspace.projectConfig(p).then(projectAgents))
      const def = (await agents.get(key)!).find((a) => a.id === c.review!.agent)
      const why = reviewStalled(c, def ? { name: def.name, running: !!sessions.liveFor(p, def.id) || isResuming(p, def.id) } : null)
      if (why) view.reviewStalled = why
    } catch {
      view.reviewStalled = say(API.card.reviewerRemoved, { agent: c.review.agentName })
    }
  }
  // A project agent sees the cards of other projects it links to or waits for as numbers, marked as such.
  const scope = callerScope()
  const elsewhere = await tasks.refsOutside([...new Set([...c.blockedBy, ...c.links])], scope)
  // Its 1.0 stage (#1223, SPEC §16.4.3) from the card's row, after the document's fields: additive.
  const stage = cardStages(workspace, [c.number]).get(c.number) ?? CATEGORY_STAGE[c.column]
  // Its kind (#1277: code or no-code) and a kind an agent proposed, not answered yet: additive too.
  const k = cardKind(workspace, c.number)
  // Whether it skips review (#1625), and an agent's proposal of it not answered yet: additive, only when there is one.
  const rs = cardReviewSkip(workspace, c.number)
  // Its own Merges into (HI-2556): additive, only when it has one.
  const target = cardTarget(workspace, c.number)
  // Who merges it and where it is with the merge queue, by its own rules (#1354): additive, only when Combwork merges it.
  const merge = c.project && !c.archived ? await queueLineFor(c.project, c.number) : null
  // A code card's checks before review and how to run one (HI-2276): additive, only when its rules name some.
  const checks = c.project && !c.archived ? await checksFor(c.project, c.number) : null
  const kept = attachmentsOf ? files.filter((a) => !!a.comment && attachmentsOf.has(a.comment)) : files
  const attachments = kept.length ? kept.map((a) => attachmentForAgents(a, c.comments)) : null
  const omitted = files.length - kept.length
  return { ...(elsewhere.length ? { ...view, elsewhere } : view), ...(attachments ? { attachments } : {}), ...(omitted ? { attachmentsOmitted: omitted } : {}), ...(k ? { kind: k.kind, ...(k.kindProposed ? { kindProposed: k.kindProposed } : {}) } : {}), ...(rs?.skip ? { reviewSkipped: rs.skip } : {}), ...(rs?.proposed != null ? { reviewSkipProposed: rs.proposed } : {}), ...(target ? { target } : {}), stage, ...(merge ? { merge } : {}), ...checks }
}

/** A card attachment as agents read it (HI-1700): its path, name and size, who added it and when, and where it came. */
function attachmentForAgents(a: CardAttachment, comments: readonly Pick<TaskComment, 'id' | 'by' | 'at'>[]): NonNullable<TaskView['attachments']>[number] {
  const said = a.comment && a.comment !== 'description' && a.comment !== 'pane' ? comments.find((x) => x.id === a.comment) : undefined
  const from = said ? say(API.attachment.fromComment, { by: said.by, at: said.at }) : a.comment === 'description' ? 'description' : a.comment === 'pane' ? say(API.attachment.fromSession) : a.comment ? say(API.attachment.fromGoneComment) : say(API.attachment.fromCard) // i18n-ignore: agent-facing
  return { path: a.path, name: a.name, size: a.size, by: a.by, at: a.at, from, ...(a.missing ? { missing: true as const } : {}) }
}

/** The project a project agent's calls are confined to on the board, or null (the Assistant and scripts see it all). */
function callerScope(): string | null {
  const a = agentCaller()
  return a ? basename(a.projectPath) : null
}

/** A change's `attachments` (HI-1700): local paths, checked as a list (shape and count) before anything; null without any. */
function attachmentList(body: any): string[] | null {
  const raw = body?.attachments
  if (raw === undefined || (Array.isArray(raw) && !raw.length)) return null
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string' || !x)) throw new HttpError(400, apiSaid(API.attachment.listArg))
  checkBatch(raw.map(() => ({})))
  return raw as string[]
}

/**
 * Runs a card's change (`fn`) with its files (HI-1700), inside the operation that makes it (the Assistant's: once admitted):
 * the card's project checked first (a project of the workspace; a project agent's own), then each path against what its
 * caller may attach from (a project agent: its own project's folders and the temp folder; the Assistant and scripts: the
 * workspace's), then copied into the card's host's staging; nothing is copied before the destination is known to be
 * allowed, and the staging is removed whatever happens. Without files, `fn(null)`.
 */
async function withAttachments<T>(paths: string[] | null, project: string | null, fn: (files: tasks.ChangeAttachments | null) => Promise<T>): Promise<T> {
  if (!paths) return fn(null)
  const ws = requireWorkspace()
  const agent = agentCaller()
  if (project !== null) {
    const known = [...(await ws.listProjectPaths()), ...(await ws.listProjectPaths({ hidden: true }))].some((p) => basename(p).toLowerCase() === project.toLowerCase())
    if (!known) throw new HttpError(404, apiSaid(API.workspace.unknownProject, { name: project }))
    if (agent && basename(agent.projectPath).toLowerCase() !== project.toLowerCase()) throw new HttpError(403, apiSaid(API.card.stayInProject, { project: basename(agent.projectPath) }))
  } else if (agent) throw new HttpError(403, apiSaid(API.card.stayInProject, { project: basename(agent.projectPath) }))
  const caller: AttachCaller = agent ? { kind: 'agent', project: basename(agent.projectPath) } : { kind: 'workspace' }
  const real: string[] = []
  for (const p of paths) real.push(await attachableSource(ws, caller, p))
  const staging = await stageFiles(cardHost(ws, project), null, real.map((path, i) => ({ path, name: basename(paths[i]) })))
  try {
    return await fn({ staging, drafts: real.map(() => null) })
  } finally {
    await staging.dispose()
  }
}

/** A change's lines for the files it attached (HI-1700): stored, or already kept with the card (the same bytes). */
const attachedLines = (c: TaskCard & { attached?: { name: string; path: string; added: boolean }[] }): string[] => (c.attached ?? []).map((a) => `${a.added ? say(API.attachment.attached) : say(API.attachment.alreadyAttached)}: ${a.name} (${a.path})`)

/** The short reply a Combwork tool asks for (reply: "short") instead of the whole card or column. */
const shortReply = (body: any): boolean => body?.reply === 'short'

/**
 * A change to a card, for a short reply: what changed (in its history's words) and where the card is now. Its column's
 * places alone (HI-1887): every agent's comment reads them, and composing each card in full cost main 15 ms a time.
 */
async function taskChange(c: TaskCard, changes: string[]): Promise<TaskChange> {
  return changeRow(c, changes, c.archived ? [] : await columnList(c.column))
}

/** The caller's live cards in a column, in board order: their places alone. */
async function columnList(column: TaskColumn): Promise<Pick<TaskCard, 'number'>[]> {
  const scope = callerScope()
  return (await tasks.columnPlaces(workspace, column)).filter((x) => tasks.inScope(x, scope))
}

/** A card's change, given its column's list (where it is in that list is its place). */
function changeRow(c: TaskCard, changes: string[], list: Pick<TaskCard, 'number'>[]): TaskChange {
  const i = list.findIndex((x) => x.number === c.number)
  return { number: c.number, ...(c.key ? { key: c.key } : {}), title: c.title, column: c.column, position: i >= 0 ? i + 1 : null, of: list.length, project: c.project, agent: c.agent ? (c.agentName ?? c.agent) : null, changes }
}

/**
 * A card in a request's path: its number (`12`, the old global number the tools take until P8), `#12`, or its key
 * (`HI-12`, any case, an old key too: #1219). A key no card has is 404.
 */
const taskNumber = (v: string): number => {
  const ref = decodeURIComponent(v).trim()
  if (/^[A-Za-z]{2,4}-\d+$/.test(ref)) {
    const n = cardOfRef(requireWorkspace(), ref, callerScope())
    if (n === null) throw new HttpError(404, apiSaid(API.card.unknown, { card: ref }))
    return n
  }
  const n = Number(ref.replace(/^#/, ''))
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, apiSaid(API.card.notANumber, { value: v }))
  return n
}

/**
 * A card reference in a request's body (#1219): a key (`"HI-12"`) or `"#12"` becomes the card's number; a number, or
 * anything else, is left as it is for the route's own check (a key no card has is 404).
 */
function cardRefIn(v: unknown): unknown {
  if (typeof v !== 'string' || !isCardRef(v) || /^\d+$/.test(v.trim())) return v
  const n = cardOfRef(requireWorkspace(), v, callerScope())
  if (n === null) throw new HttpError(404, apiSaid(API.card.unknown, { card: v.trim() }))
  return n
}
const cardRefsIn = <T>(v: T): T => (Array.isArray(v) ? (v.map(cardRefIn) as T) : v)

/** A reply with `names` for every card its `cards` lists hold, anywhere in it (#1219): the merge slot's holders and line. */
function withCardsNamed<T>(reply: T): T {
  const found: number[] = []
  const walk = (v: unknown, depth: number): void => {
    if (!v || typeof v !== 'object' || depth > 6) return
    for (const [k, x] of Object.entries(v)) {
      if (k === 'cards' && Array.isArray(x)) found.push(...x.filter((n): n is number => typeof n === 'number'))
      else walk(x, depth + 1)
    }
  }
  walk(reply, 0)
  return reply && typeof reply === 'object' && !Array.isArray(reply) && found.length ? { ...reply, ...withNames(found) } : reply
}

/** How a reply's text names these cards (#1219), for the combwork MCP server that words it: `names`, or nothing. */
const withNames = (numbers: number[]): { names?: Record<string, string> } => {
  const names = namesOf(numbers)
  return names ? { names } : {}
}

function columnParam(v: unknown): TaskColumn | undefined {
  if (v === undefined || v === null || v === '') return undefined
  if (!isTaskColumn(v)) throw new HttpError(400, apiSaid(API.card.unknownColumn, { column: String(v), choices: COLUMN_CHOICES }))
  return v
}

/** The fields of a request body a card change may set. */
function taskPatch(body: any): TaskPatch {
  const out: TaskPatch = {}
  // Archiving is the user's (#351), one card or a batch: no call of the Agent API's makes it.
  if (body?.archived !== undefined) throw new HttpError(403, apiSaid(API.card.onlyUserArchives))
  for (const k of ['title', 'description', 'project', 'blocked', 'waitingFor'] as const) if (body?.[k] !== undefined) out[k] = body[k] === null ? (null as never) : String(body[k])
  if (body?.agent !== undefined) out.agent = body.agent ? String(body.agent) : null
  if (body?.column !== undefined) out.column = columnParam(body.column)
  if (body?.before !== undefined) out.before = body.before === null ? null : Number(String(cardRefIn(body.before)).replace(/^#/, ''))
  if (body?.position !== undefined && body.position !== null && body.position !== '') {
    if (body.position !== 'top' && body.position !== 'bottom') throw new HttpError(400, apiSaid(API.card.unknownPosition, { position: String(body.position) }))
    out.position = body.position
  }
  for (const k of ['labels', 'addLabels', 'removeLabels', 'blockedBy', 'links', 'context'] as const) if (body?.[k] !== undefined) out[k] = k === 'blockedBy' || k === 'links' ? cardRefsIn(body[k]) : body[k]
  if (body?.decision !== undefined && body.decision !== null) out.decision = String(body.decision)
  // HI-1932: the open requests the decision answers, by id, as sent: never coerced (a nested list isn't an id), checked
  // (shape, who, each request) by the route and where it is recorded.
  if (body?.answers !== undefined && body.answers !== null) out.answers = body.answers as string[]
  if (body?.review !== undefined && body.review !== null && body.review !== '') {
    if (body.review !== 'start' && body.review !== 'passed' && body.review !== 'failed') throw new HttpError(400, apiSaid(API.card.unknownReview, { review: String(body.review) }))
    out.review = body.review
  }
  if (body?.override !== undefined && body.override !== null) out.override = overrideParam(body.override)
  return out
}

/**
 * A move's override (#1265, SPEC §16.8.4): `{ reason }`, the Assistant's, why it moves the card across the rules;
 * `released` (HI-3148), the released line a start it makes may go onto, as the refusal named it (that line only).
 */
export function overrideParam(v: unknown): { reason: string; released?: string } {
  const reason = v && typeof v === 'object' ? (v as { reason?: unknown }).reason : undefined
  if (typeof reason !== 'string' || !reason.trim()) throw new HttpError(400, apiSaid(API.card.overrideArg))
  const released = (v as { released?: unknown }).released
  return { reason: reason.trim(), ...(typeof released === 'string' && released.trim() ? { released: released.trim().slice(0, 250) } : {}) }
}

route('GET', '/v1/tasks', async ({ query }) => {
  requireWorkspace()
  const project = query.get('project') ?? undefined
  // A project agent's list is its project's cards; it can't ask for another project's.
  // ?q= (#1237): the board's search, through its full-text index.
  const cards = await tasks.listTasks({ project: project ? basename(projectByName(project)) : undefined, column: columnParam(query.get('column')), archived: query.get('archived') === 'true' ? true : undefined, scope: callerScope(), query: query.get('q') ?? undefined })
  const agents = new Map<string, Promise<ReturnType<typeof projectAgents>>>()
  // ?view=short: a row per card, without its description, comments, history and requests for the user (not read).
  const short = query.get('view') === 'short'
  const waiting = short ? new Map<number, ForYouItem[]>() : forYouOfCards(workspace, cards.map((c) => c.number))
  const views = await Promise.all(cards.map((c) => taskView(c, agents, waiting)))
  if (short) return views.map(taskRow)
  // HI-2568: whole cards without their history (historyEntries counts it), so the listing doesn't grow with every card's
  // changes; ?history=true keeps it.
  return query.get('history') === 'true' ? views : views.map(withoutHistory)
})

// HI-2854: a card's start task that carried the whole card, read with cw_inbox, is a full read of it as it was then: the
// generations it was made at are received (never later ones), and the flag's baseline moves to when it was made.
onCardTaskReceived((host, agentId, n, seen) => {
  const agent = { projectPath: host, agentId }
  if (lastCardRead(agent, n) < seen.at) noteCardRead(agent, n, seen.at)
  const ws = workspaceFor(host)
  if (ws) void recordDecisionsReceived(ws, agentId, n, seen.decisions, basename(host), seen.comments)
})

route('GET', '/v1/tasks/:n', async ({ params, query }) => {
  requireWorkspace()
  // The card with its decision generation, read together (#1216): what this reply gives an agent is what its receipt records.
  const seen = await tasks.readTaskSeen(taskNumber(params[0]), await taskActor())
  // comments=0 (HI-2412): none of them, every one counted in commentsOmitted.
  const parsed = commentsParam(query.get('comments'))
  if (parsed !== null && typeof parsed === 'object') throw new HttpError(400, parsed.error)
  const n = parsed
  const summary = query.get('summary') === 'true'
  // A narrowed read (HI-2402) keeps only the attachments of the comments it returns in full (none under summary=true,
  // whose comments are their first lines), unless attachments=true; a full read keeps them all.
  const narrowed = (n !== null || summary) && query.get('attachments') !== 'true'
  // Never slice(-n): slice(-0) is every comment (HI-2412).
  const inFull = summary ? [] : n === null ? seen.card.comments : seen.card.comments.slice(Math.max(0, seen.card.comments.length - n))
  const view = await taskView(seen.card, undefined, undefined, narrowed ? new Set(inFull.flatMap((x) => (x.id ? [x.id] : []))) : undefined)
  // Read in full, decisions included: those aren't new to the agent any more (#357).
  const me = agentCaller()
  if (me) {
    noteCardRead(me, view.number)
    // What it has received of the card's decisions, as a fact (#1216), in the background: the generation read with this
    // reply's decisions, never one written since.
    // HI-2854: the user's comments too, only from a read that gave every comment it keeps in full (not comments=n or
    // summary=true, which may leave one out).
    const ws = contextWorkspace()
    if (ws) void recordDecisionsReceived(ws, me.agentId, view.number, seen.generation, view.project, n === null && !summary ? seen.comments : undefined)
  }
  const lean = n === null ? view : newestComments(view, n)
  // summary=true (#532): each comment as its first line, with the whole comment's length when there is more; its open
  // requests' words too (HI-1992).
  const told = summary ? { ...lean, ...(lean.forYou ? { forYou: lean.forYou.map(commentSummary) } : {}), comments: lean.comments.map(commentSummary) } : lean
  // Its comment archive (HI-2641): how many older comments it archived (read with /comments/archived), whether it may
  // have lost some before archiving existed, and past SPLIT_HINT_COMMENTS in all, a hint to split it.
  const archive = tasks.commentArchive(seen.card.number)
  const all = seen.card.comments.length + archive.archived
  const withArchive = {
    ...told,
    ...(archive.archived ? { commentsArchived: archive.archived } : {}),
    ...(archive.mayHaveBeenLost ? { commentsMayHaveBeenLost: true, commentsNote: say(API.card.commentsMayHaveBeenLost) } : {}),
    ...(all > SPLIT_HINT_COMMENTS ? { hint: say(API.card.splitHint, { n: String(all) }) } : {})
  }
  return query.get('history') === 'false' ? withoutHistory(withArchive) : withArchive
})

/** Past this many comments on a card (its archived ones counted), a read of it suggests splitting it (HI-2641). */
const SPLIT_HINT_COMMENTS = 100
/** The most archived comments one read returns (HI-2641), and how many when limit is left out. */
const ARCHIVED_PAGE_MAX = 100
const ARCHIVED_PAGE = 50

/** A whole number from `min` (an archive read's offset or limit), or the default when it is absent; else a 400. */
function pageParam(raw: string | null, arg: string, min: number, fallback: number): number {
  if (raw === null) return fallback
  const n = raw.trim() === '' ? NaN : Number(raw)
  if (!Number.isInteger(n) || n < min) throw new HttpError(400, apiSaid(API.card.archivedArg, { arg, min: String(min), raw }))
  return n
}

// A card's archived comments (HI-2641): its oldest, past the 500 it keeps, a page at a time, oldest first.
route('GET', '/v1/tasks/:n/comments/archived', async ({ params, query }) => {
  requireWorkspace()
  const offset = pageParam(query.get('offset'), 'offset', 0, 0)
  const limit = Math.min(ARCHIVED_PAGE_MAX, pageParam(query.get('limit'), 'limit', 1, ARCHIVED_PAGE))
  const r = await tasks.archivedCommentsOf(taskNumber(params[0]), await taskActor(), offset, limit)
  const next = offset + r.comments.length
  return { ...r, offset, ...(next < r.total ? { next } : {}) }
})

/** A new card's lane (HI-2167, POST /v1/tasks `lane`): a builder's name or id, or { builder, reviewer, brief, name, position }. */
interface LanePlacement {
  body: Record<string, unknown>
  position: 'last' | 'next'
  needsLane: boolean
}

/**
 * A new card's `lane`, checked before the card is made (its shape, the builder an agent of the card's project, an agent's
 * own lane only, the card made in Todo), so a refusal here makes no card. Null when it has none.
 */
async function lanePlacement(v: unknown, input: { project?: unknown; column?: TaskColumn }): Promise<LanePlacement | null> {
  if (v === undefined || v === null) return null
  const o: Record<string, unknown> = typeof v === 'string' ? { builder: v } : typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  if (typeof o.builder !== 'string' || !o.builder.trim()) throw new HttpError(400, apiSaid(API.card.laneArg))
  for (const k of Object.keys(o)) if (!['builder', 'reviewer', 'brief', 'name', 'position'].includes(k)) throw new HttpError(400, apiSaid(API.card.laneArgField, { field: k }))
  if (o.position !== undefined && o.position !== 'last' && o.position !== 'next') throw new HttpError(400, apiSaid(API.card.lanePosition))
  if (input.column !== undefined && input.column !== 'todo') throw new HttpError(400, apiSaid(API.card.laneNoColumn))
  const project = typeof input.project === 'string' && input.project ? input.project : null
  if (!project) throw new HttpError(400, apiSaid(API.card.laneNeedsProject))
  const p = laneProject(project)
  const builder = await agentParam(p, o.builder.trim())
  const a = agentCaller()
  if (a && builder !== a.agentId) throw new HttpError(403, apiSaid(API.card.laneOwnOnly))
  laneArgs(o)
  const { position, ...rest } = o
  return { body: { ...rest, project, builder: o.builder.trim() }, position: position === 'next' ? 'next' : 'last', needsLane: typeof v === 'string' }
}

/** A new card placed on its lane (HI-2167): the lane's change, or why it wasn't placed (the card stays, its key named). */
async function placeOnLane(l: LanePlacement, card: number): Promise<{ lane: LaneChange } | { laneRefused: string }> {
  try {
    return { lane: await laneCall(() => laneStartCall(l.body, { card, position: l.position, needsLane: l.needsLane })) }
  } catch (e) {
    return { laneRefused: (e as Error).message }
  }
}

/** A card's Merges into as a call gives it (HI-2556): a branch name, or null (or '') for the project's own. */
function targetArg(v: unknown): string | null {
  if (v === null || v === '') return null
  if (typeof v !== 'string') throw new HttpError(400, apiSaid(API.lane.targetText))
  return v.slice(0, 250)
}

route('POST', '/v1/tasks', async ({ body }) => {
  requireWorkspace()
  const title = String(body?.title ?? '').trim()
  if (!title) throw new HttpError(400, apiSaid(API.card.titleRequired))
  const input = { title, description: body?.description, project: body?.project, agent: body?.agent, column: columnParam(body?.column), labels: body?.labels, blocked: body?.blocked, blockedBy: cardRefsIn(body?.blockedBy), links: cardRefsIn(body?.links), context: body?.context, ...(body?.kind !== undefined ? { kind: body.kind } : {}), ...(body?.skipReview !== undefined ? { skipReview: body.skipReview as string } : {}), ...(body?.target !== undefined ? { target: targetArg(body.target) } : {}) }
  const actor = await taskActor()
  // Placed on a lane as it is made (HI-2167): checked before the card is made; placed after, through cw_lane start's
  // own path, so nobody guesses its key.
  const lane = await lanePlacement(body?.lane, input)
  // Files to keep with it (HI-1700): the list checked now; copied inside the operation that makes the card, once its
  // project is known to be allowed, and published with it.
  const paths = attachmentList(body)
  // `commit`: the Assistant's guard (HI-2415), checked again just before each write, after the awaits a queued change waits on.
  const create = (commit?: () => void) => withAttachments(paths, typeof input.project === 'string' && input.project ? input.project : callerScope(), (files) => tasks.changeWithAttachments(actor, files, 'description', () => tasks.createTask(input, actor, { commit }), commit))
  // A long title is kept, with a line suggesting a shorter one (HI-1872), or one with what belongs in the description (HI-2061).
  const nudge = titleNudge(title, actor, titleKeys())
  // A target of its own given as it is made (HI-3043): said as cw_update_task says it (HI-3017), under the reply.
  const reply = async (c: TaskCard) => {
    const own = input.target ? (await cardTargetSaid(workspace, c.number, c.project)).note : ''
    const notes = [nudge, own].filter(Boolean).join('\n')
    return { ...(shortReply(body) ? await taskChange(c, attachedLines(c)) : await taskView(c)), ...(notes ? { nudge: notes } : {}) }
  }
  // Placed once it is made (the Assistant's: its own change, as cw_lane start is), never inside the card's own change.
  const placing = async <R extends { number: number }>(r: R) => (lane ? { ...r, ...(await placeOnLane(lane, r.number)) } : r)
  if (actor.kind !== 'assistant') return placing(await reply(await create()))
  const project = typeof input.project === 'string' && input.project ? input.project : null
  // Made in Doing with nobody on it (HI-2062): refused before the user is asked to approve it (checked again as it is made).
  if (project && input.column === 'doing' && !input.agent) throw new tasks.TaskConflictError(tasks.DOING_NOBODY_NEW)
  const given = await knownAgent(project, input.agent)
  return placing(await assistantChange('agents', [API.change.createTask, { title: clip(title, 60) }], { kind: 'create-task', ...(project ? { project } : {}), ...(given ? { agent: given } : {}) }, async (guard) => {
    const c = await create(guard)
    return { done: [API.done.cardAdded, { card: cardName(c), inProject: c.project ? 'yes' : 'no', project: c.project ?? '', title: clip(c.title, 80) }], act: { card: c.number, column: c.column, ...(c.project ? { project: c.project } : {}), agent: await cardAgent(c) }, result: await reply(c) }
  }))
})

route('PATCH', '/v1/tasks/:n', async ({ params, body }) => {
  requireWorkspace()
  const n = taskNumber(params[0])
  const patch = taskPatch(body)
  const comment = typeof body?.comment === 'string' ? body.comment.trim() : ''
  const actor = await taskActor()
  // A decision that answers requests (HI-1932) is that change alone: checked against the body as sent, before any of
  // its other fields (its kind, skipping review, attachments: changed outside the patch) could be.
  if (patch.answers !== undefined) tasks.checkDecisionAnswers(actor, body.answers, ['kind', 'confirmKind', 'skipReview', 'target', 'attachments'].some((k) => body[k] !== undefined))
  const changes: string[] = []
  // Its kind (#1277): changed after it was made (the Assistant's, with override.reason), or an agent's proposal answered.
  const kind = body?.kind
  const confirmKind = body?.confirmKind
  if (confirmKind !== undefined && typeof confirmKind !== 'boolean') throw new HttpError(400, apiSaid(API.card.confirmKindArg))
  // Checked before anything is written (HR3's #1277 round 1): a kind no card has is refused whole.
  if (kind !== undefined) tasks.kindOf(kind)
  // The override's reason is the kind change's when no column moves with it.
  if (kind !== undefined && patch.column === undefined) delete patch.override
  // Whether it skips review (#1625): the user's reason (the Assistant's), or false; checked before anything is written.
  const skipReview = body?.skipReview === undefined ? undefined : tasks.reviewSkipArg(body.skipReview)
  // Its Merges into (HI-2556): a branch, or null for the project's own; checked by tasks.setTarget.
  const target = body?.target === undefined ? undefined : targetArg(body.target)
  // HI-3017: a target of its own (one of the project's other targets) is said under the change: it stays there when the
  // project's target changes, even to it, so setting cards before the project pins them.
  let ownTargetNote = ''
  const setCardTarget = async (commit?: () => void): Promise<void> => {
    const c = await tasks.setTarget(n, target, actor, { commit })
    const { own, note } = await cardTargetSaid(workspace, n, c.project)
    changes.push(sayStored([API.card.saidTarget, { own: own ? 'yes' : 'no', target: own ?? '' }]))
    ownTargetNote = note
  }
  const write = async (commit?: () => void): Promise<TaskCard> => {
    if (confirmKind !== undefined) {
      await tasks.confirmKind(n, confirmKind, actor, { commit })
      changes.push(sayStored([confirmKind ? API.card.saidNoCode : API.card.saidCode]))
    }
    if (kind !== undefined) {
      await tasks.setKind(n, kind, actor, { commit, reason: body?.override && typeof body.override === 'object' ? String((body.override as { reason?: unknown }).reason ?? '') : '' })
      changes.push(sayStored([API.card.saidKind, { kind: String(kind) }]))
    }
    if (skipReview !== undefined) {
      await tasks.setReviewSkip(n, skipReview !== false, actor, { commit, reason: skipReview || '' })
      changes.push(sayStored([skipReview !== false ? API.card.saidSkipsReview : API.card.saidReviewed]))
    }
    if (target !== undefined && !moving) await setCardTarget(commit)
    // A change and its comment are saved together: a card watch woken by the change names this comment.
    const c = Object.keys(patch).length ? await tasks.updateTask(n, patch, actor, { said: changes, comment: comment || undefined, commit }) : comment ? await tasks.commentTask(n, comment, actor, { commit }) : await tasks.readTask(n, actor)
    if (comment) changes.push(say(API.card.saidCommented))
    return c
  }
  // Files to keep with it (HI-1700), with its comment if it has one: checked and copied first, published in its change.
  if (body?.attachments !== undefined && patch.project !== undefined) throw new HttpError(400, apiSaid(API.attachment.moveFirst))
  const paths = attachmentList(body)
  // A change of its kind with anything else is one board change (HR3's #1277 round 1): refused part way, none of it.
  // HI-2753: a card in flight moves to its new target in a change of its own, first: refused, nothing else is changed.
  const moving = target !== undefined && (await tasks.targetMovesInFlight(n).catch(() => false))
  const once = (commit?: () => void): Promise<TaskCard> => (kind !== undefined || confirmKind !== undefined || skipReview !== undefined || (target !== undefined && !moving) ? tasks.cardBatch(workspace, () => write(commit)) : write(commit))
  const apply = async (commit?: () => void): Promise<TaskCard> => {
    if (moving) await setCardTarget(commit)
    // Its files copied here, inside the operation (the Assistant's: once admitted), to the card's own project.
    const c = await withAttachments(paths, paths ? ((await tasks.readTask(n, actor)).project ?? null) : null, (files) => tasks.changeWithAttachments(actor, files, comment ? 'comment' : 'description', () => once(commit), commit))
    changes.push(...attachedLines(c))
    return c
  }
  const nudge = patch.title === undefined ? null : titleNudge(patch.title, actor, titleKeys())
  // A lane's card moved (HI-2664: the Assistant's move to Todo, now that cw_put_back is a worker's): its lane keeps its own
  // order and takes it again in it, said as a put-back says it (HI-2267).
  const reply = async (c: TaskCard) => {
    const held = patch.column !== undefined ? await lanes.lanesHolding(requireWorkspace(), [c.number]).catch(() => []) : []
    const notes = [nudge, ownTargetNote, ...held.map(laneOrderNote)].filter(Boolean).join('\n')
    return { ...(shortReply(body) ? await taskChange(c, changes) : await taskView(c)), ...(notes ? { nudge: notes } : {}) }
  }
  if (actor.kind !== 'assistant') {
    const c = await apply()
    const copy = await reviewCopyAfter(actor, c, { start: patch.review === 'start', verdict: patch.review === 'passed' || patch.review === 'failed' || patch.column === 'passed' })
    if (copy) changes.push(copy)
    const r = await reply(c)
    return copy && !shortReply(body) ? { ...r, reviewCopy: copy } : r
  }
  const was = await tasks.getTask(n).catch(() => null)
  // Into Doing with nobody on it and no reason from the user (HI-2062): refused before the user is asked to approve it.
  // Only a first look: the change checks it again on the card as it is then (and an agent named is checked there).
  if (was?.project && patch.column === 'doing' && was.column !== 'doing' && !patch.override && (patch.agent === undefined ? !was.agent : !patch.agent)) {
    // agent-protocol: who can override, one of the names the refusal's own text gives (refusals.ts)
    throw new tasks.WorkflowRefusedError(refusal('move.doingNobody', { card: cardRef(n), stage: 'active' }, 'the user or the Assistant'))
  }
  const given = typeof patch.agent === 'string' ? await knownAgent(was?.project, patch.agent) : was ? await cardAgent(was) : undefined
  return assistantChange('agents', [API.change.updateTask, { card: cardRef(n) }], { kind: 'update-task', card: n, ...(patch.column ? { column: patch.column } : {}), ...(was?.project ? { project: was.project } : {}), ...(given ? { agent: given } : {}) }, async (commit) => {
    const before = await tasks.getTask(n)
    const placed = (patch.before !== undefined && patch.before !== null) || patch.position !== undefined
    const c = await apply(commit)
    // What it did, as its activity line says it (stored: said in the Default).
    const at = patch.position ? sayStored([API.card.atEnd, { position: patch.position }]) : placed ? sayStored([API.card.before, { card: typeof patch.before === 'number' ? cardRef(patch.before) : String(patch.before) }]) : ''
    const what = [
      patch.column && patch.column !== before.column
        ? sayStored([API.card.movedTo, { column: columnLabel(patch.column), placed: at ? 'yes' : 'no', at }])
        : patch.position
          ? sayStored([API.card.movedToEnd, { position: patch.position, column: columnLabel(c.column) }])
          : at
            ? sayStored([API.card.movedAt, { at }])
            : '',
      comment ? sayStored([API.card.commented]) : '',
      patch.decision !== undefined ? sayStored([API.card.recordedDecision]) : '',
      confirmKind !== undefined ? sayStored([confirmKind ? API.card.confirmedNoCode : API.card.keptCode]) : '',
      kind !== undefined ? sayStored([API.card.madeKind, { kind: String(kind) }]) : '',
      skipReview !== undefined ? sayStored([skipReview !== false ? API.card.setSkipReview : API.card.setReviewed]) : '',
      Object.keys(patch).some((k) => k !== 'column' && k !== 'before' && k !== 'position' && k !== 'decision') ? sayStored([API.card.changedIt]) : ''
    ]
      .filter(Boolean)
      .join(', ')
    return { done: [API.done.cardChanged, { card: cardName(c), title: clip(c.title, 60), changed: what ? 'yes' : 'no', what }], act: { column: c.column, ...(c.project ? { project: c.project } : {}), agent: await cardAgent(c) }, result: await reply(c) }
  })
})

/** A batch change (cw_update_tasks): checked by taskBatch; its refusals are the Agent API's statuses. */
route('POST', '/v1/tasks/batch', async ({ body }) => {
  requireWorkspace()
  const short = shortReply(body)
  return asRefused(async () => {
    // Cards named by key too (#1219): one no card has (or, for a project agent, another project's) is refused as that
    // card, the others changed, as a number no card has is. The request is checked whole first (its count, its fields),
    // before any key is looked up (#1219 round 2, finding 3); `#N` and numbers go on as they are, refused per card.
    const refs = body && typeof body === 'object' && Array.isArray((body as { numbers?: unknown }).numbers) ? (body as { numbers: unknown[] }).numbers : null
    const isKey = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z]{2,4}-\d+$/.test(v.trim())
    taskBatch.batchRequest(refs ? { ...(body as object), numbers: refs.map((v, i) => (isKey(v) ? `#${1e9 + i}` : v)) } : body)
    const unknown: string[] = []
    const given = {
      ...(body as object),
      numbers: refs!.flatMap((v) => {
        if (!isKey(v)) return [v]
        const n = cardOfRef(requireWorkspace(), v, callerScope())
        if (n === null) unknown.push(v.trim())
        return n === null ? [] : [n]
      })
    }
    if (unknown.length && !given.numbers.length) return batchReply([], short, unknown)
    const { numbers, patch } = taskBatch.batchRequest(given)
    const actor = await taskActor()
    const items = actor.kind !== 'assistant' ? await tasks.updateTasks(numbers, patch, actor) : await taskBatch.assistantBatch(assistantCaller() ?? '', assistantCallerToken() ?? '', numbers, patch, actor)
    return batchReply(items, short, unknown)
  })
})

/**
 * The reply to a batch: each card changed (its change, short; the whole card otherwise), and each card refused with
 * why. A short reply reads each column's list once, after every change, so a card's place is where it ends up.
 */
async function batchReply(items: tasks.BatchItem[], short: boolean, unknown: string[] = []): Promise<unknown> {
  const refused: TaskBatch['refused'] = [...unknown.map((ref) => ({ number: 0, ref, error: say(API.card.unknown, { card: ref }) })), ...items.filter((i) => !i.card).map((i) => ({ number: i.number, error: i.error ?? 'refused', ...i.refused }))]
  const done = items.filter((i): i is tasks.BatchItem & { card: TaskCard } => !!i.card)
  if (!short) {
    const agents = new Map<string, Promise<ReturnType<typeof projectAgents>>>()
    return { changed: await Promise.all(done.map((i) => taskView(i.card, agents))), refused }
  }
  const lists = new Map<TaskColumn, Pick<TaskCard, 'number'>[]>()
  const changed: TaskChange[] = []
  for (const i of done) {
    const c = i.card
    if (!c.archived && !lists.has(c.column)) lists.set(c.column, await columnList(c.column))
    changed.push(changeRow(c, i.said, c.archived ? [] : lists.get(c.column)!))
  }
  return { changed, refused, ...withNames(refused.map((r) => r.number)) }
}

route('POST', '/v1/tasks/reorder', async ({ body }) => {
  requireWorkspace()
  const column = columnParam(body?.column)
  if (!column) throw new HttpError(400, apiSaid(API.card.columnRequired))
  const cards = cardRefsIn(body?.cards)
  const actor = await taskActor()
  const view = async (list: TaskCard[]): Promise<TaskView[] | TaskReorder> => {
    // Short: the agent chose the cards and their order; it only needs to know it worked.
    if (shortReply(body)) {
      const top = (cards as unknown[]).map((x) => Number(String(x).replace(/^#/, '')))
      // A lane's cards among them (HI-2267): the column's order isn't the lane's, which the reply says.
      const held = await lanes.lanesHolding(requireWorkspace(), top).catch(() => [])
      return { column, top, count: list.length, ...withNames([...top, ...held.flatMap((l) => l.cards)]), ...(held.length ? { lanes: held } : {}) }
    }
    const agents = new Map<string, Promise<ReturnType<typeof projectAgents>>>()
    return Promise.all(list.map((c) => taskView(c, agents)))
  }
  if (actor.kind !== 'assistant') return view(await tasks.reorderTasks(column, cards, actor))
  const count = Array.isArray(cards) ? cards.length : 0
  const ordered = Array.isArray(cards) ? cards.map((x) => Number(String(x).replace(/^#/, ''))).filter((x) => Number.isInteger(x) && x > 0) : []
  return assistantChange('agents', [API.change.reorderTasks, { count, total: String(count), column: columnLabel(column) }], { kind: 'reorder-tasks', column, cards: ordered }, async (guard) => {
    // Checked again as each card is saved, in one batch (HI-2420): revoked while it waited for the board, none moves.
    const list = await tasks.reorderTasks(column, cards, actor, { commit: guard })
    const top = (cards as unknown[]).map((x) => cardRef(Number(String(x).replace(/^#/, '')))).join(', ')
    return { done: [API.done.reordered, { cards: top, column: columnLabel(column) }], result: await view(list) }
  })
})

// Only a card's newest comment (its author, time and whole text), for "check the latest comment": the card's
// description, earlier comments and history stay out of the reply. A card without comments gives comment null.
// A card's attachment, read through Combwork (HI-1751: the document tools refuse `.combwork`, so a reviewer couldn't read the
// builder's evidence): a page of its text, or its kind and path for an image or a binary file. Only a card the caller may
// read (its scope, as GET /v1/tasks/:n), from that card's own folder.
route('GET', '/v1/tasks/:n/attachments/:name', async ({ params, query }) => {
  requireWorkspace()
  const c = await tasks.readTask(taskNumber(params[0]), await taskActor())
  let name: string
  try {
    name = decodeURIComponent(params[1] ?? '')
  } catch {
    throw new HttpError(400, apiSaid(API.attachment.badName))
  }
  const r = await readCardAttachment(workspace, { number: c.number, project: c.project ?? null }, name, query.get('offset'))
  if (!('problem' in r)) return r
  const card = c.key ?? `#${c.number}`
  const choices = { listed: r.choices?.length ? 'yes' : 'no', choices: r.choices?.join(', ') ?? '' }
  const why = {
    unknown: say(API.attachment.unknown, { card, name, ...choices }),
    ambiguous: say(API.attachment.ambiguous, { card, name, ...choices }),
    missing: say(API.attachment.missing, { card, name }),
    outside: say(API.attachment.outside, { card, name }),
    changed: say(API.attachment.changed, { card, name }),
    offset: say(API.attachment.offset, { size: String(r.size ?? 0) })
  }[r.problem]
  throw new HttpError(r.problem === 'unknown' || r.problem === 'missing' ? 404 : r.problem === 'offset' || r.problem === 'outside' ? 400 : 409, why, r.choices?.length ? { choices: r.choices } : undefined)
})

route('GET', '/v1/tasks/:n/comments/latest', async ({ params, query }) => {
  requireWorkspace()
  const r = await tasks.latestComment(taskNumber(params[0]), await taskActor())
  // summary=true (#532): its first line, with its whole length when there is more.
  const summary = query.get('summary') === 'true'
  // Its open requests first (HI-1992): "check the latest comment" is where an Assistant looks for a question, and an
  // agent's question is in For you, not its comments.
  const forYou = await requestsFor(forYouOfCards(workspace, [r.number]).get(r.number) ?? [], undefined, summary)
  // Its attachments (HI-2402): those that came with this comment (none under summary=true), its links to them read as
  // their paths, the card's others counted in attachmentsOmitted; attachments=true gives them all.
  const files = await cardAttachments(workspace, r.number)
  const all = query.get('attachments') === 'true'
  const kept = all ? files : summary || !r.commentId ? [] : files.filter((a) => a.comment === r.commentId)
  const comment = r.comment && files.length ? { ...r.comment, text: withAttachmentPaths(r.comment.text, files) } : r.comment
  const omitted = files.length - kept.length
  return { number: r.number, ...(forYou ? { forYou } : {}), comment: summary && comment ? commentSummary(comment) : comment, ...(kept.length ? { attachments: kept.map((a) => attachmentForAgents(a, r.sources)) } : {}), ...(omitted ? { attachmentsOmitted: omitted } : {}) }
})

// A card's facts (#1223, SPEC §16.4): a short row each (seq, kind, time, actor and a few words, revisions as its project's
// platform shows them); view=full gives them as recorded. None for a card from before 1.0, or on a board not upgraded.
route('GET', '/v1/tasks/:n/facts', async ({ params, query }) => {
  requireWorkspace()
  const view = query.get('view') ?? 'short'
  if (view !== 'short' && view !== 'full') throw new HttpError(400, apiSaid(API.card.unknownView, { view }))
  const c = await tasks.readTask(taskNumber(params[0]), await taskActor())
  const got = cardFacts(workspace, c.number)
  const head = { number: c.number, stage: got?.card.stage ?? cardStages(workspace, [c.number]).get(c.number) ?? CATEGORY_STAGE[c.column], ...(got?.card.preWorkflow ? { preWorkflow: true } : {}) }
  const facts = got?.facts ?? []
  if (view === 'full') return { ...head, facts }
  const platform = await platformOfCard(c)
  return { ...head, facts: facts.map((f) => factRow(f, (id) => revisionShort(platform, id))) }
})

/** The platform of a card's project (the workspace's folder's for a card about the workspace), for its revisions' text. */
async function platformOfCard(c: TaskCard): Promise<PlatformId> {
  try {
    const p = projectByName(c.project)
    return platformIdOf(p, (await workspace.projectConfig(p)).platform)
  } catch {
    return initialOf(detect(workspace.path!))
  }
}

route('POST', '/v1/tasks/:n/comments', async ({ params, body }) => {
  requireWorkspace()
  const n = taskNumber(params[0])
  const text = typeof body?.text === 'string' ? body.text : ''
  const actor = await taskActor()
  const paths = attachmentList(body)
  // `commit`: the Assistant's guard (HI-2415), checked again just before each write.
  const comment = async (commit?: () => void) => withAttachments(paths, paths ? ((await tasks.readTask(n, actor)).project ?? null) : null, (files) => tasks.changeWithAttachments(actor, files, 'comment', () => tasks.commentTask(n, text, actor, { commit }), commit))
  const reply = async (c: TaskCard) => (shortReply(body) ? taskChange(c, [say(API.card.saidCommented), ...attachedLines(c)]) : taskView(c))
  if (actor.kind !== 'assistant') return reply(await comment())
  return assistantChange('agents', [API.change.commentTask, { card: cardRef(n) }], { kind: 'comment-task', card: n }, async (guard) => ({ done: [API.done.commented, { card: cardRef(n) }], result: await reply(await comment(guard)) }))
})

/** Bounded waits running now, per caller (an agent, the Assistant, a script): at most WAITS_PER_CALLER at a time. */
const taskWaits = new Map<string, number>()
const WAITS_PER_CALLER = 2

/**
 * Waiting on cards (#128). `wake: true`: the calling agent (or the Assistant) registers a watch and ends its turn; Combwork
 * types one line into it when a watched card changes (main/watches.ts). `cancel: true`: ends its watch. Otherwise the
 * call waits itself, up to its longest (Settings → Advanced, #367), for a change since `since` (or since the call), driven by the board's
 * change events (no polling). A project agent waits only on its own project's cards.
 */
/**
 * A usage watch's accounts (HI-2195): each { account (its id or name), percent (1 to 100), limit (weekly, fiveHour or any,
 * the default) }. A project agent names only accounts on in its workspace.
 */
function readUsageWatch(v: unknown, ws: WorkspaceService): UsageWatch[] {
  const shape = apiSaid(API.watch.usageShape)
  if (!Array.isArray(v) || !v.length) throw new HttpError(400, shape)
  if (v.length > USAGE_WATCH_MAX) throw new HttpError(400, apiSaid(API.watch.usageMax, { max: String(USAGE_WATCH_MAX) }))
  const seen = agentCaller() ? combworkAccounts().filter((a) => accountOnIn(ws.config, a, allAccounts())) : combworkAccounts()
  return v.map((x: { account?: unknown; percent?: unknown; limit?: unknown }) => {
    if (!x || typeof x !== 'object' || typeof x.account !== 'string') throw new HttpError(400, shape)
    const percent = Number(x.percent)
    const limit = x.limit === undefined ? 'any' : x.limit
    if (!Number.isInteger(percent) || percent < 1 || percent > 100) throw new HttpError(400, apiSaid(API.watch.usagePercent))
    if (limit !== 'weekly' && limit !== 'fiveHour' && limit !== 'any') throw new HttpError(400, shape)
    const byId = seen.find((a) => a.id === x.account)
    const byName = seen.filter((a) => a.name.toLowerCase() === String(x.account).toLowerCase())
    if (!byId && byName.length > 1) throw new HttpError(409, apiSaid(API.connection.severalAccounts, { name: x.account, ids: byName.map((a) => a.id).join(', ') }))
    const a = byId ?? byName[0]
    if (!a) throw new HttpError(404, apiSaid(API.watch.usageNoAccount, { name: x.account }))
    return { account: a.id, name: a.name, percent, limit }
  })
}

route('POST', '/v1/tasks/wait', async ({ body: raw }) => {
  const ws = requireWorkspace()
  // An agent's plain number that reads as another card's key is refused, never remapped (HI-2197).
  if (agentCaller() && raw && typeof raw === 'object' && (raw as { cancel?: unknown }).cancel !== true) {
    const clash = await clashingNumber(ws, (raw as { cards?: unknown }).cards, await taskActor())
    if (clash) throw new HttpError(400, clash)
  }
  // Its cards named by key or `#12` too (#1219).
  const body = raw && typeof raw === 'object' && !Array.isArray(raw) && (raw as { cards?: unknown }).cards !== undefined ? { ...(raw as object), cards: cardRefsIn((raw as { cards: unknown }).cards) } : raw
  // The workspace as it is now: the call belongs to it, and stops (409) if it closes or the window opens another.
  const wsPath = ws.path
  const life = ws.lifetime
  if (!wsPath) throw new HttpError(409, apiSaid(API.workspace.closed))
  const stillOpen = (): void => {
    if (life.aborted || !ws.path || ws.path.toLowerCase() !== wsPath.toLowerCase()) throw new HttpError(409, apiSaid(API.workspace.closed))
  }
  stillOpen()
  const me = agentCaller()
  const home = assistantCaller() ? ws.assistantHome : null
  const who = me ? { projectPath: me.projectPath, agentId: me.agentId } : home ? { projectPath: home, agentId: 'assistant' } : null
  if (body?.cancel === true) {
    if (!who) throw new HttpError(400, apiSaid(API.watch.noCardWatchToCancel))
    const w = sessions.watchFor(who.projectPath, who.agentId)
    const had = await cancelWatch(ws, who.projectPath, who.agentId)
    return { done: had ? say(API.watch.cancelledOne, { kind: w?.lanes ? 'lane' : w?.agents ? 'agent' : 'card' }) : say(API.watch.noCardWatch) }
  }
  // A usage watch (HI-2195): accounts' limits reaching a share, alone or beside the cards or lanes; always one that wakes.
  const usage = body?.usage !== undefined ? readUsageWatch(body.usage, ws) : undefined
  if (usage !== undefined && (body.wake !== true || !who)) throw new HttpError(400, apiSaid(API.watch.usageWakes))
  if (usage && body.lanes === undefined && body.cards === undefined) {
    if (body.agents !== undefined || body.column !== undefined) throw new HttpError(400, apiSaid(API.watch.usageAlone))
    const limit = body?.limitMinutes === undefined ? WATCH_DEFAULT_LIMIT_MINUTES : Number(body.limitMinutes)
    if (!Number.isFinite(limit) || limit < 1 || limit > WATCH_MAX_LIMIT_MINUTES) throw new HttpError(400, apiSaid(API.watch.limitMinutes, { max: String(WATCH_MAX_LIMIT_MINUTES) }))
    const r = await registerUsageWatch(ws, who!.projectPath, who!.agentId, usage, limit).catch((e: Error) => {
      // Its refusal's own status (HI-2704: not its words), else 409.
      throw httpFrom(ownStatus(e) ?? 409, e)
    })
    const left = r.lanesLeft ? { lanesLeft: r.lanesLeft } : {}
    if ('already' in r) return { usageAlready: r.already, ...(r.replaced ? { replaced: r.replaced } : {}), ...left }
    return { watching: r.watching.label, limitAt: r.watching.limitAt, ...(r.replaced ? { replaced: r.replaced } : {}), ...left }
  }
  // Beside cards or lanes: added to the watch they start (one already answered starts none).
  const withUsage = async (label: string): Promise<string> => (usage ? ((await addUsageToWatch(ws, who!.projectPath, who!.agentId, usage))?.label ?? label) : label)
  // A lane watch (#531): whole lanes; always one that wakes. With cards beside them (#726): `cards` and their `changes`.
  if (body?.lanes !== undefined) {
    if (body.column !== undefined || body.fresh !== undefined) throw new HttpError(400, apiSaid(API.watch.lanesAlone))
    const lc = readLaneCondition(body)
    if (isSaid(lc)) throw new HttpError(400, lc)
    const extra = readLaneCards(body)
    if (isSaid(extra)) throw new HttpError(400, extra)
    if (body.wake !== true || !who) throw new HttpError(400, apiSaid(API.watch.laneWakes))
    // Agents beside the lanes (HI-1987): each { project, agent }; left out, the last lane watch's are kept, [] drops them.
    let laneAgents: WatchedAgent[] | undefined
    if (body.agents !== undefined) {
      if (!Array.isArray(body.agents)) throw new HttpError(400, apiSaid(API.watch.agentsArg))
      if (body.agents.length > AGENT_WATCH_MAX_AGENTS) throw new HttpError(400, apiSaid(API.watch.maxAgents, { max: String(AGENT_WATCH_MAX_AGENTS) }))
      laneAgents = []
      for (const x of body.agents as { project?: unknown; agent?: unknown }[]) {
        if (!x || typeof x !== 'object' || typeof x.project !== 'string') throw new HttpError(400, apiSaid(API.watch.agentsArg))
        const p = projectByName(x.project)
        const id = await agentParam(p, x.agent as string | undefined)
        if (!laneAgents.some((a) => resolvePath(a.projectPath).toLowerCase() === resolvePath(p).toLowerCase() && a.agentId === id)) laneAgents.push({ projectPath: p, agentId: id, name: (await agentDefOf(p, id)).name, project: basename(p) })
      }
      stillOpen()
    }
    const limit = body?.limitMinutes === undefined ? WATCH_DEFAULT_LIMIT_MINUTES : Number(body.limitMinutes)
    if (!Number.isFinite(limit) || limit < 1 || limit > WATCH_MAX_LIMIT_MINUTES) throw new HttpError(400, apiSaid(API.watch.limitMinutes, { max: String(WATCH_MAX_LIMIT_MINUTES) }))
    // Each card named must be one the caller may see, as for a card watch.
    if (extra.cards?.length) {
      const actor = await taskActor()
      for (const n of extra.cards) await tasks.readTask(n, actor)
      stillOpen()
    }
    const r = await registerLaneWatch(ws, who.projectPath, who.agentId, lc, limit, { ...extra, ...(laneAgents ? { agents: { agents: laneAgents, ignoreBackground: false } } : {}) }).catch((e: Error) => {
      // A refusal's own status (HI-2704: not its words: an unknown lane or card 404, a project or agent it can't watch 400), else 409.
      throw e instanceof HttpError ? e : httpFrom(ownStatus(e) ?? 409, e)
    })
    // HI-2521: a named lane that has already ended is the answer at once; no watch started, so no usage beside it.
    if ('already' in r) return { lanesAlready: r.already, ...(r.replaced ? { replaced: r.replaced } : {}) }
    return { watching: await withUsage(r.watching.label), limitAt: r.watching.limitAt, events: lc.events,...(r.replaced ? { replaced: r.replaced } : {}), ...(r.cards ? { cards: r.cards, ...withNames([...r.cards.now, ...(r.cards.replaced ?? []), ...(r.cards.dropped ?? [])]) } : {}), ...(r.agents ? { agents: r.agents } : {}) }
  }
  if (body?.agents !== undefined) throw new HttpError(400, apiSaid(API.watch.agentsWithLanes))
  const cond = readCondition(body ?? {})
  if (isSaid(cond)) throw new HttpError(400, cond)
  // Each card must be one the caller may see (a project agent: its project's; others are unknown to it), and stays so:
  // the caller's scope goes with the wait, and every later read is checked against it.
  const actor = await taskActor()
  const scope = tasks.scopeOf(actor)
  for (const n of cond.cards) await tasks.readTask(n, actor)
  stillOpen()
  if (body?.wake === true) {
    if (!who) throw new HttpError(400, apiSaid(API.watch.wakeOnlyAgents))
    const limit = body?.limitMinutes === undefined ? WATCH_DEFAULT_LIMIT_MINUTES : Number(body.limitMinutes)
    if (!Number.isFinite(limit) || limit < 1 || limit > WATCH_MAX_LIMIT_MINUTES) throw new HttpError(400, apiSaid(API.watch.limitMinutes, { max: String(WATCH_MAX_LIMIT_MINUTES) }))
    const r = await registerWatch(ws, who.projectPath, who.agentId, cond, limit)
    const left = r.lanesLeft ? { lanesLeft: r.lanesLeft } : {}
    // HI-2245: an agent's own cards in Review with commits past their submission: its reply says to hand them over first.
    const mine = me ? await unsubmittedOf(ws, me.projectPath, me.agentId, 'already' in r ? [r.already.number] : cond.cards) : []
    const unsubmitted = mine.length ? { unsubmitted: mine } : {}
    if ('already' in r) return { already: r.already, ...unsubmitted, ...left, ...withNames([r.already.number]) }
    // HI-2285: a lane's builder watching only its own card while nothing on it waits on anyone: its reply says so.
    const idle = me && !usage ? await idleOwnWatchOf(ws, me.agentId, cond.cards) : null
    return { watching: await withUsage(r.watching.label), limitAt: r.watching.limitAt, ...unsubmitted, ...(idle !== null ? { idle } : {}), ...left, ...(mine.length || idle !== null ? withNames([...mine.map((u) => u.card), ...(idle !== null ? [idle] : [])]) : {}) }
  }
  const seconds = body?.timeoutSeconds === undefined ? 300 : Number(body.timeoutSeconds)
  // The longest is Settings → Advanced's (#367), under Codex's timeout for Combwork's tools.
  const maxSeconds = waitMaxSeconds('cards')
  if (!Number.isFinite(seconds) || seconds < 1) throw new HttpError(400, apiSaid(API.watch.timeoutRange, { max: String(maxSeconds) }))
  const limitMs = Math.min(maxSeconds, seconds) * 1000
  let base: Map<number, CardMark> | null = null
  let sinceAt = Date.now()
  if (body?.since !== undefined) {
    const d = decodeSince(String(body.since))
    if (!d) throw new HttpError(400, apiSaid(API.watch.sinceArg))
    base = d.marks
    sinceAt = d.at
  }
  const sinceIso = new Date(sinceAt).toISOString()
  const read = (n: number) => scopedCard(ws, wsPath, life, n, scope)
  const marksOf = async (): Promise<Map<number, CardMark>> => {
    const m = new Map<number, CardMark>()
    for (const n of cond.cards) m.set(n, markOf(await read(n)))
    return m
  }
  const callerKey = me ? `${me.projectPath.toLowerCase()}#${me.agentId}` : home ? `assistant:${wsPath}` : `api:${wsPath}`
  const running = taskWaits.get(callerKey) ?? 0
  if (running >= WAITS_PER_CALLER) throw new HttpError(429, apiSaid(API.watch.tooManyWaits, { running: String(running) }))
  taskWaits.set(callerKey, running + 1)
  try {
    const start = await marksOf()
    const from = new Map(cond.cards.map((n) => [n, base?.get(n) ?? start.get(n)!]))
    // A column condition already met when the wait begins answers at once, as does a card in Done or archived (HI-2153).
    const met = !base ? cond.cards.filter((n) => alreadyThere(start.get(n)!, cond) || cardOver(start.get(n)!)) : []
    if (met.length) return { changes: await Promise.all(met.map(async (n) => cardChange(n, await read(n), start.get(n)!.archived ? 'gone' : ['column']))), timedOut: false, since: encodeSince(start), ...withNames(met) }
    const check = async (): Promise<{ changes: CardChange[]; now: Map<number, CardMark> }> => {
      const now = await marksOf()
      const changes: CardChange[] = []
      for (const n of cond.cards) {
        const card = await read(n)
        const kinds = changesBetween(from.get(n)!, now.get(n)!, cond, !!cond.moveInto && !!cond.column && movedIntoSince(card, cond.column, sinceIso))
        // A reviewer's request and a decision since the wait began (#1272), which marks don't keep; a project agent's own aren't news.
        if (kinds !== 'gone') kinds.push(...handoffsSince(card, sinceIso, cond, actor.kind === 'agent' && actor.self ? actor.name : undefined))
        const reached = alreadyThere(now.get(n)!, cond) && !alreadyThere(from.get(n)!, cond)
        // A card gone (or out of the caller's view) is told as gone: nothing of its state but whether it was archived.
        if (kinds === 'gone') changes.push({ ...cardChange(n, null, 'gone'), ...(card?.archived ? { archived: true } : {}) })
        else if (kinds.length || reached) changes.push(cardChange(n, card, kinds.length ? kinds : ['column']))
      }
      return { changes, now }
    }
    // Listening first, then the first check: a change between the two is seen by one or the other.
    const result = await new Promise<{ changes: CardChange[]; now: Map<number, CardMark> }>((resolve, reject) => {
      // One check at a time; a board change during one checks again after it, so none is missed until the timeout.
      let checking = false
      let again = false
      let ended = false
      const finish = (): void => {
        ended = true
        clearTimeout(timer)
        off()
        life.removeEventListener('abort', onClose)
      }
      const done = (r: { changes: CardChange[]; now: Map<number, CardMark> }): void => {
        if (ended) return
        finish()
        resolve(r)
      }
      const fail = (e: unknown): void => {
        if (ended) return
        finish()
        reject(e)
      }
      const onClose = (): void => fail(new HttpError(409, apiSaid(API.workspace.closed)))
      const run = (): void => {
        if (ended) return
        if (checking) {
          again = true
          return
        }
        checking = true
        again = false
        void check()
          .then((r) => (r.changes.length ? done(r) : undefined))
          .catch((e) => (life.aborted ? onClose() : log.warn('checking a card wait', e)))
          .finally(() => {
            checking = false
            if (again) run()
          })
      }
      const timer = setTimeout(() => void check().then(done, () => (life.aborted ? onClose() : done({ changes: [], now: start }))), limitMs)
      const off = onCombworkEvent((e) => {
        if (e.type === 'tasks-changed' && e.workspacePath.toLowerCase() === wsPath.toLowerCase()) run()
      })
      life.addEventListener('abort', onClose, { once: true })
      run()
    })
    return result.changes.length ? { changes: result.changes, timedOut: false, since: encodeSince(result.now), ...withNames(result.changes.map((c) => c.number)) } : { timedOut: true, since: encodeSince(result.now) }
  } finally {
    const left = (taskWaits.get(callerKey) ?? 1) - 1
    if (left > 0) taskWaits.set(callerKey, left)
    else taskWaits.delete(callerKey)
  }
})

/** A card in an intent's path (#1267): its number, and whether it was given plain (`12`), which an agent's isn't (S48). */
const intentRef = (v: string): CardRefIn => ({ n: taskNumber(v), plain: /^\d+$/.test(decodeURIComponent(v).trim()) })

/** What an intent is (API.change.intent, a select on its kind), in the Assistant's refusals and activity line. */
const intentWhat = (kind: CardIntent['kind'], n: number): Said => [API.change.intent, { kind, card: cardRef(n) }]

/** What an intent did (API.done.intent, a select on its kind), in the Assistant's activity line: its card, and its move. */
const intentDone = (kind: CardIntent['kind'], card: TaskCard, done: { from?: string | null; to?: string | null }): Said => {
  const moved = !!done.from && !!done.to && done.from !== done.to
  return [API.done.intent, { kind, card: cardName(card), title: clip(card.title, 60), moved: moved ? 'yes' : 'no', from: moved ? done.from! : '', to: moved ? done.to! : '' }]
}

/**
 * A card's intent (#1267, SPEC §16.8.1) for its caller: an agent's own (known by its token), a script's, or the
 * Assistant's through Settings → Assistant → Control. The reply is lean: the card, where it went, what the intent says
 * of it. A refusal is the runtime's, 409 with its rule, what to do next and who can override.
 */
/**
 * An agent's review start or verdict on its card (#1439, reviewCopies.ts): a start leases its review copy (the line its
 * reply gives, or null when it gets none), a verdict returns it. Never refusing what was done: a failure is logged.
 */
async function reviewCopyAfter(actor: tasks.TaskActor, c: TaskCard, did: { start: boolean; verdict: boolean }): Promise<string | null> {
  const self = actor.kind === 'agent' ? actor.self : undefined
  const ws = requireWorkspace()
  if (!self || !c.project || !ws.path || (!did.start && !did.verdict)) return null
  const projectPath = join(ws.path, c.project)
  if (did.verdict) {
    await reviewCopyOnVerdict(ws, projectPath, c.number, self.agentId)
    return null
  }
  if (c.review?.agent !== self.agentId) return null
  return reviewCopyOnStart(ws, projectPath, c.number, { id: self.agentId, name: c.review.agentName }).catch((e) => {
    log.warn(`Leasing #${c.number}'s review copy`, e)
    return null
  })
}

/**
 * A put-back of a card a running lane holds (HI-2267): its reply says the lane keeps its own order and takes the card in
 * it, and how to change that order (cw_lane start, applyNow), as a line of its own. Any other intent, as it was.
 */
async function withLaneOrder(intent: CardIntent, card: TaskCard, done: IntentDone): Promise<IntentDone> {
  if (intent.kind !== 'putBack') return done
  const held = await lanes.lanesHolding(requireWorkspace(), [card.number]).catch(() => [])
  return held.length ? { ...done, warnings: [...(done.warnings ?? []), ...held.map(laneOrderNote)] } : done
}

async function cardIntent(param: string, intent: CardIntent): Promise<IntentDone> {
  requireWorkspace()
  const ref = intentRef(param)
  const actor = await taskActor()
  if (actor.kind !== 'assistant') {
    const self = actor.kind === 'agent' ? actor.self : undefined
    const { done: ran, card } = await runCardIntent(ref, actor, intent).catch(async (e: unknown) => {
      // HI-2854: a submit refused for what its builder hasn't seen gives it those, in full, received with the refusal.
      if (self && intent.kind === 'submit' && e instanceof tasks.WorkflowRefusedError && e.refusal.rule === 'submit.decisionsReceived') {
        // The card, its facts and archive in one snapshot (HR2's round 1), still its own project's card (round 2: not one moved since).
        const unread = await giveUnseen(requireWorkspace(), self.agentId, ref.n, self.project).catch((err) => (log.warn('giving a refused submit its unseen decisions', err), [] as string[]))
        // Given in full: the reply flag's baseline moves too, so its next reply doesn't flag them again.
        const me = agentCaller()
        if (unread.length && me) noteCardRead(me, ref.n)
        if (unread.length) throw new tasks.WorkflowRefusedError({ ...e.refusal, unread })
      }
      throw e
    })
    // HI-2854: the task Combwork started the card with is acked by its builder's start or submit of it (still recorded).
    const me = agentCaller()
    const acked = me && self && (intent.kind === 'start' || intent.kind === 'submit') ? await ackCardTask(me.projectPath, me.agentId, card).catch((err) => (log.warn('acking a card\'s task by its start or submit', err), [] as string[])) : []
    // Said in the reply ("acked: m1"), so the agent doesn't call cw_inbox to ack it again.
    const done = await withLaneOrder(intent, card, acked.length ? { ...ran, data: { ...ran.data, acked } } : ran)
    const copy = await reviewCopyAfter(actor, card, { start: intent.kind === 'startReview', verdict: intent.kind === 'verdict' })
    // A lane's handoff arms its agent's watch (#1639): a builder's submission, a reviewer's failed verdict.
    const watch = self ? await armIntentWatch(requireWorkspace(), self.agentId, card, { submit: intent.kind === 'submit', failed: intent.kind === 'verdict' && !intent.pass }) : null
    const out = watch ? { ...done, watch } : done
    // The copy first (#1444): a CLI that shortens a long reply (Codex's code tool) still shows where to review.
    return copy ? { ...out, data: { reviewCopy: copy, ...out.data } } : out
  }
  const was = await tasks.getTask(ref.n).catch(() => null)
  return assistantChange('agents', intentWhat(intent.kind, ref.n), { kind: 'update-task', card: ref.n, ...(was?.project ? { project: was.project } : {}) }, async (guard) => {
    // Its guard checked again in each write as the card is saved (HI-2420): one revoked while the intent waited saves nothing.
    const { done: ran, card } = await runCardIntent(ref, actor, intent, { commit: guard })
    const done = await withLaneOrder(intent, card, ran)
    return { done: intentDone(intent.kind, card, done), act: { column: card.column, agent: await cardAgent(card) }, result: done, ...(INTENT_STAYS[intent.kind] ? { stays: INTENT_STAYS[intent.kind] } : {}) }
  })
}

/**
 * What of an intent stays whatever undo does (#1282 round 3): its facts in the card's work. A column or agent it changed
 * is undone as any card field; this is said beside it, so nothing of it is left out.
 */
const INTENT_STAYS: Partial<Record<CardIntent['kind'], string>> = {
  start: UNDO_FINAL.start,
  putBack: UNDO_FINAL.putBack,
  submit: UNDO_FINAL.submit,
  declarePaths: UNDO_FINAL.declarePaths,
  startReview: UNDO_FINAL.startReview,
  verdict: UNDO_FINAL.verdict,
  reportMerge: UNDO_FINAL.reportMerge,
  ask: UNDO_FINAL.ask,
  cannot: UNDO_FINAL.cannot,
  request: UNDO_FINAL.request,
  removeFromQueue: UNDO_FINAL.removedFromQueue,
  retryMerge: UNDO_FINAL.retriedMerge
}

/** A body's text field, trimmed; required ones refused when missing or empty. */
function textField(body: any, key: string, required: true): string
function textField(body: any, key: string, required?: false): string | undefined
function textField(body: any, key: string, required = false): string | undefined {
  const v = body?.[key]
  if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) {
    if (required) throw new HttpError(400, apiSaid(API.intent.fieldRequired, { field: key }))
    return undefined
  }
  if (typeof v !== 'string') throw new HttpError(400, apiSaid(API.intent.fieldText, { field: key }))
  return v.trim()
}

/** A body's list of paths (declare-paths, submit): text each, none empty. */
function pathsField(body: any, required: boolean): string[] | undefined {
  const v = body?.paths
  if (v === undefined || v === null) {
    if (required) throw new HttpError(400, apiSaid(API.intent.pathsRequired))
    return undefined
  }
  if (!Array.isArray(v) || v.some((p) => typeof p !== 'string' || !p.trim())) throw new HttpError(400, apiSaid(API.intent.pathsArg))
  return v.map((p: string) => p.trim())
}

/** A submit's focused tests (G20, HI-1367), when given: ids or { id, needs }, unique, each a valid id. */
function testsField(body: any): FocusedTest[] | undefined {
  if (body?.tests === undefined || body?.tests === null) return undefined
  const t = testsGiven(body.tests)
  if ('bad' in t) throw new HttpError(400, apiSaid(API.intent.testsArg, { problem: t.bad })) // i18n-ignore: agent-facing
  return t.tests
}

/** A verdict body's accept (HI-2660): at most ACCEPT_MAX focused test ids, when given; the runtime checks each again. */
function acceptField(body: any): string[] | undefined {
  const v = body?.accept
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v) || v.length > ACCEPT_MAX || !v.every(validTestId)) throw new HttpError(400, apiSaid(API.intent.acceptArg, { max: ACCEPT_MAX }))
  return v
}

/** A body's submission number (start-review, verdict), when given. */
function submissionField(body: any): number | undefined {
  const v = body?.submission
  if (v === undefined || v === null) return undefined
  if (!Number.isInteger(v) || v < 1) throw new HttpError(400, apiSaid(API.intent.submissionArg))
  return v
}

/** The most steps an ask's Test checklist has, and the longest a step is. */
const CHECKLIST_MAX = 20
const CHECKLIST_STEP_MAX = 500

/** An ask's Test checklist (#1267): the steps the user is asked to try, text each, none empty. */
function checklistField(body: any): { checklist?: string[] } {
  const v = body?.checklist
  if (v === undefined || v === null) return {}
  if (!Array.isArray(v) || !v.length || v.length > CHECKLIST_MAX || v.some((x) => typeof x !== 'string' || !x.trim() || x.length > CHECKLIST_STEP_MAX)) throw new HttpError(400, apiSaid(API.intent.checklistArg, { max: String(CHECKLIST_MAX), stepMax: String(CHECKLIST_STEP_MAX) }))
  return { checklist: v.map((x: string) => x.trim()) }
}

/** The longest an offered action's reason is (#1630), as an override's. */
const ASK_REASON_MAX = 1000

/** The actions an ask offers the user on its card (#1630): known kinds, each once, with an optional reason. */
function actionsField(body: any): { actions?: AskAction[] } {
  const v = body?.actions
  if (v === undefined || v === null) return {}
  const bad = (): HttpError => new HttpError(400, apiSaid(API.intent.actionsArg, { max: String(ASK_ACTIONS_MAX), kinds: ASK_ACTIONS.join(', '), reasonMax: String(ASK_REASON_MAX) }))
  if (!Array.isArray(v) || !v.length || v.length > ASK_ACTIONS_MAX) throw bad()
  const out: AskAction[] = []
  for (const x of v) {
    if (!x || typeof x !== 'object' || !ASK_ACTIONS.includes(x.kind) || out.some((o) => o.kind === x.kind)) throw bad()
    if (x.reason !== undefined && x.reason !== null && (typeof x.reason !== 'string' || x.reason.length > ASK_REASON_MAX)) throw bad()
    const reason = typeof x.reason === 'string' ? x.reason.trim() : ''
    out.push({ kind: x.kind, ...(reason ? { reason } : {}) })
  }
  return { actions: out }
}

const ASK_KINDS: readonly ForYouKind[] = ['approve', 'decide', 'test', 'signIn', 'other']

/** Each intent's route (POST /v1/tasks/:n/<route>) and its arguments from the body; start is /start's (below). */
export const INTENT_ROUTES: Record<string, (body: any) => CardIntent> = {
  'put-back': (body) => ({ kind: 'putBack', why: textField(body, 'why', true) }),
  submit: (body) => {
    if (body?.followUp !== undefined && body?.followUp !== null && typeof body.followUp !== 'boolean') throw new HttpError(400, apiSaid(API.intent.followUpArg))
    const tests = testsField(body)
    return { kind: 'submit', summary: textField(body, 'summary', true), revision: textField(body, 'revision'), note: textField(body, 'note'), paths: pathsField(body, false), ...(body?.followUp === true ? { followUp: true } : {}), ...(tests ? { tests } : {}) }
  },
  'declare-paths': (body) => ({ kind: 'declarePaths', paths: pathsField(body, true)! }),
  'start-review': (body) => ({ kind: 'startReview', submission: submissionField(body) }),
  verdict: (body) => {
    if (body?.pass !== true && body?.pass !== false) throw new HttpError(400, apiSaid(API.intent.passArg))
    const failKind = body?.failKind ?? undefined
    if (failKind !== undefined && failKind !== 'content' && failKind !== 'explanation') throw new HttpError(400, apiSaid(API.intent.unknownFailKind, { value: String(failKind) }))
    const accept = acceptField(body)
    return { kind: 'verdict', pass: body.pass, comment: textField(body, 'comment', true), submission: submissionField(body), failKind, ...(accept ? { accept } : {}) }
  },
  'report-merge': (body) => ({ kind: 'reportMerge', result: textField(body, 'result') }),
  'focused-skip': (body) => {
    if (body?.merge !== true && body?.merge !== false) throw new HttpError(400, apiSaid(API.intent.mergeArg))
    return { kind: 'focusedSkip', request: textField(body, 'request', true)!, merge: body.merge, why: textField(body, 'why', true)! }
  },
  ask: (body) => {
    const askKind = body?.kind ?? 'other'
    if (!ASK_KINDS.includes(askKind)) throw new HttpError(400, apiSaid(API.intent.unknownAskKind, { value: String(askKind), kinds: ASK_KINDS.join(', ') }))
    const revision = textField(body, 'revision')
    if (revision !== undefined && (revision.length > 200 || /\s/.test(revision))) throw new HttpError(400, apiSaid(API.intent.revisionArg))
    return { kind: 'ask', askKind, text: textField(body, 'text', true), ...(revision ? { revision } : {}), ...checklistField(body), ...actionsField(body) }
  },
  cannot: (body) => ({ kind: 'cannot', rule: textField(body, 'rule', true), why: textField(body, 'why', true) }),
  request: (body) => ({ kind: 'request', text: textField(body, 'text', true) }),
  'loop-step': (body) => {
    const step = body?.step
    if (!LOOP_STEPS.includes(step)) throw new HttpError(400, apiSaid(API.intent.unknownStep, { value: String(step), steps: LOOP_STEPS.join(', ') }))
    // An answer and going ahead name the design or follow-up they are about (its reply's `design`), so a late one never
    // settles another.
    const design = step === 'design' || step === 'followUp' ? undefined : textField(body, 'design', true)
    return { kind: 'loopStep', step, text: textField(body, 'text', true), ...(design ? { design } : {}) }
  }
}
for (const [path, intentOf] of Object.entries(INTENT_ROUTES)) route('POST', `/v1/tasks/:n/${path}`, async ({ params, body }) => cardIntent(params[0], intentOf(body)))

// An agent asks the Combwork Assistant on a card (HI-1866): its comment, and the Assistant's inbox. An agent's alone: the
// Assistant has its own tools, and the user acts on the board.
route('POST', '/v1/tasks/:n/ask-assistant', async ({ params, body }) => {
  const ws = requireWorkspace()
  const ref = intentRef(params[0])
  const actor = await taskActor()
  if (actor.kind !== 'agent' || !actor.self) throw new HttpError(403, apiSaid(API.intent.askAssistantAgentsOnly))
  const text = textField(body, 'text', true)
  // An agent's plain number is refused, naming the card's key (S48), as for the intents.
  if (ref.plain) throw new tasks.WorkflowRefusedError(refusal('card.plainNumber', { key: (await tasks.readTask(ref.n, actor)).key ?? `#${ref.n}` }, null))
  try {
    const { card, id, waiting } = await askAssistant(ws, ref.n, actor, text)
    return { ok: true, card: card.key ?? cardRef(ref.n), delivery: id, ...(waiting ? { waiting: true } : {}) }
  } catch (e) {
    if (e instanceof AskRefused) throw httpFrom(e.status, e)
    throw e
  }
})

// An agent starting a card itself runs its start intent (#1267); the Assistant starts a card on an agent.
route('POST', '/v1/tasks/:n/start', async ({ params, body }) => {
  const ws = requireWorkspace()
  if (agentCaller()) return cardIntent(params[0], { kind: 'start' })
  const n = taskNumber(params[0])
  const card = await tasks.readTask(n, await taskActor())
  // 1.0 (#1451): no agent gets a worktree of its own: asking for one is refused, never ignored.
  if (body?.worktree || body?.existingWorktree || body?.branch || body?.base || (body?.location && body.location !== 'project')) throw new HttpError(400, apiSaid(NOT_PINNED))
  // A new agent's connection (HI-2121, as cw_add_agent's: decisions A and D): the one named, else the first usable here.
  if (body?.agent && body?.connection !== undefined) throw new HttpError(400, apiSaid(API.intent.connectionNewAgentOnly))
  const conn = !body?.agent && card.project && ws.path ? connectionArg(body, join(ws.path, card.project)) : undefined
  // Decision D (HI-2108): provider, model, effort, mode and context are a connection's now, refused naming those there.
  refuseOldFields(body, getConnection(conn?.connection)?.account ?? firstUsableAccount(ws.path ? ws.config : null)?.id)
  if (conn?.cli && !isProviderEnabled(config.settings, conn.cli)) throw new HttpError(409, apiSaid(API.agent.providerOff, { provider: providerName(conn.cli) }))
  const target: TaskStartTarget = body?.agent
    ? { kind: 'agent', agentId: String(body.agent) }
    : { kind: 'new-agent', name: body?.name ? String(body.name) : undefined, ...(conn?.connection ? { connection: conn.connection } : {}) }
  // The agent it is started on, when it exists (a new one is named once added).
  const named = target.kind === 'agent' ? await knownAgent(card.project, target.agentId) : undefined
  const on = target.kind !== 'agent' ? 'new' : named ? 'named' : 'agent'
  return assistantChange('agents', [API.change.startTask, { card: cardRef(n), on, agent: named?.name ?? '', inProject: card.project ? 'yes' : 'no', project: card.project ?? '' }], { kind: 'start-task', card: n, ...(card.project ? { project: card.project } : {}), ...(named ? { agent: named } : {}) }, async (guard) => {
    // Its guard checked again as the card is taken, and before the task is typed or its agent launched (HI-2420): a
    // revoked start is undone, the card back where it was and a new agent removed.
    // HI-3148: the Assistant's override of a start onto a released line (`override: { reason, released }`, the line its
    // refusal named): for that line only. An agent's start never gets here (its intent, above).
    const o = body?.override !== undefined && body.override !== null ? overrideParam(body.override) : null
    const r = await startTask(n, target, { kind: 'assistant' }, typeof body?.note === 'string' ? body.note : undefined, o?.reason, undefined, guard, o?.released)
    return {
      done: [API.done.cardStarted, { card: cardRef(n), added: r.added ? 'yes' : 'no', agent: r.agentName, project: card.project ?? '', title: clip(card.title, 80) }],
      act: { agent: { id: r.agentId, name: r.agentName }, column: r.card.column },
      ...(r.run && card.project ? { started: { project: card.project, agentId: r.agentId, run: r.run } } : {}),
      result: { ok: true, agent: r.agentName, added: r.added, card: shortReply(body) ? taskRow(await taskView(r.card)) : await taskView(r.card) }
    }
  })
})

/** A skill in a listing: what it is and where it comes from, not where it is on disk. */
const skillRow = (s: SkillInfo): SkillRow & Pick<SkillInfo, 'bundled' | 'updateAvailable'> => ({
  name: s.name,
  description: s.description,
  level: s.level,
  ...(s.provider ? { provider: s.provider } : {}),
  ...(s.plugin ? { plugin: s.plugin } : {}),
  ...(s.audience ? { audience: s.audience } : {}),
  ...(s.problem ? { problem: agentField(s.problem, s.problemText) } : {}),
  ...(s.bundled ? { bundled: s.bundled } : {}),
  ...(s.updateAvailable ? { updateAvailable: s.updateAvailable } : {})
})

route('GET', '/v1/skills', async ({ query }) => {
  const project = query.get('project')
  if (project) {
    const p = projectByName(project)
    // A project's own skills are its agents' business (like its sessions).
    ownProjectOnly(p, [API.own.listingSkills])
    // What the project's agents are given: not the Combwork skills for the Assistant alone (as its Skills tab).
    return (await inWorkspace(workspaceOf(p), () => listSkills(p))).filter((s) => !(s.level === 'combwork' && s.audience === 'assistant')).map(skillRow)
  }
  return (await inWorkspace(requireWorkspace(), () => listSkills())).map(skillRow)
})

/** Largest skill file the API returns; skills are instructions, not data. */
const SKILL_FILE_MAX = 512 * 1024

// One of the workspace's Combwork skills: its SKILL.md and the files beside it, or (?file=) one of those files.
route('GET', '/v1/skills/:name', async ({ params, query }) => inWorkspace(requireWorkspace(), async () => {
  const name = decodeURIComponent(params[0])
  const skill = validSkillName(name) ? (await combworkSkills()).find((s) => s.name.toLowerCase() === name.toLowerCase()) : undefined
  if (!skill) throw new HttpError(404, apiSaid(API.skill.unknown, { name }))
  const file = query.get('file') ?? 'SKILL.md'
  // The whole path is checked before anything is read: relative, inside the skill's folder as written and as it
  // really is (a link can't lead out), and a file.
  const parts = file.replace(/\\/g, '/').split('/')
  if (!file || /^[a-z]:|^\//i.test(file) || parts.some((x) => x === '' || x === '.' || x === '..')) throw new HttpError(400, apiSaid(API.skill.fileOutside, { file }))
  const abs = join(skill.path, ...parts)
  if (!insideReal(abs, [skill.path])) throw new HttpError(400, apiSaid(API.skill.fileOutside, { file }))
  const info = await stat(abs).catch(() => null)
  if (!info?.isFile()) throw new HttpError(404, apiSaid(API.skill.noFile, { skill: skill.name, file }))
  const tooBig = new HttpError(413, apiSaid(API.skill.fileTooBig, { file, kilobytes: String(SKILL_FILE_MAX / 1024) }))
  if (info.size > SKILL_FILE_MAX) throw tooBig
  // What is read is capped too: the file may have grown since the stat.
  const read = await readCapped(abs, SKILL_FILE_MAX)
  if (read.more) throw tooBig
  const out = { name: skill.name, audience: skill.audience ?? 'agents', file: parts.join('/'), content: read.data.toString('utf8') }
  if (query.get('file')) return out
  const list = await skillFiles(skill.path)
  return { ...out, files: list.files, ...(list.truncated ? { filesTruncated: true } : {}) }
}))

// This Combwork's own API reference (docs/AGENT_API.md as it shipped), for clients that need more than the status.
route('GET', '/v1/docs/agent-api', async () => ({ version: app.getVersion(), api: API_VERSION, content: agentApiDoc }))

/**
 * The request's workspace's performance metrics (metrics.ts): ?scope=workspace (default) or ?scope=project&project=name,
 * ?from and ?to as ISO times (default the last 24 hours), ?role, ?provider and ?own=1 (the workspace's own work) to
 * narrow it, ?trend=1 for its trend. A project agent sees its own project's only.
 */
route('GET', '/v1/metrics', async ({ query }) => {
  const w = requireWorkspace()
  const agent = agentCaller()
  const asked = query.get('project')
  if (agent && (query.get('scope') !== 'project' || (asked && asked.toLowerCase() !== basename(agent.projectPath).toLowerCase()))) {
    throw new HttpError(403, apiSaid(API.metrics.ownProject, { project: basename(agent.projectPath) }))
  }
  const scope: MetricsQuery['scope'] = query.get('scope') === 'project' ? { kind: 'project', project: asked || (agent ? basename(agent.projectPath) : '') } : { kind: 'workspace' }
  if (scope.kind === 'project' && !scope.project) throw new HttpError(400, apiSaid(API.metrics.scopeNeedsProject))
  const role = query.get('role') ?? undefined
  if (role !== undefined && role !== 'agent' && role !== 'assistant' && role !== 'api') throw new HttpError(400, apiSaid(API.metrics.roleArg))
  return metricsReport(w, { scope, from: query.get('from') ?? undefined, to: query.get('to') ?? undefined, trend: query.get('trend') === '1', role, provider: query.get('provider') || undefined, own: query.get('own') === '1' }).then((r) => metricsForAgents(withPersonaAliases(r)), (e) => {
    throw e instanceof HttpError ? e : httpFrom(400, e)
  })
})


/**
 * The cw-mcp bridge's report of its tool calls (the final text each gave the model) and, once per start, its tool
 * list and instructions. From an agent's or the Assistant's own token only, attributed by that token (an agent's
 * project; the Assistant's workspace); checked and bounded: a report that isn't valid is refused, not stored.
 */
route('POST', '/v1/metrics/mcp', async ({ body }) => {
  const agent = agentCaller()
  const own = assistantCaller()
  if (!agent && !own) throw new HttpError(403, apiSaid(API.mcp.reportOnlyBridge))
  const h = metricsHandle(requireWorkspace())
  const project = agent ? basename(agent.projectPath) : null
  const role = agent ? 'agent' : 'assistant'
  const calls: unknown[] = Array.isArray(body?.calls) ? body.calls : []
  if (calls.length > MCP_REPORT_LIMITS.events) throw new HttpError(400, apiSaid(API.mcp.reportMax, { max: String(MCP_REPORT_LIMITS.events) }))
  let accepted = 0
  for (const c of calls) if (c && typeof c === 'object' && recordMcp(h, project, role, c as Record<string, unknown> as never)) accepted++
  // On the side of the launch its token is for (HI-2049), never the agent's next one; the Assistant's is none.
  const side = agent ? sessions.launchSide(agent.projectPath, agent.agentId, agentCallerRun()) : 'none'
  // Its CLI (HI-2553): the launch its token is for (an agent's), or the Assistant's session now.
  const provider = agent ? sessions.launchProvider(agent.projectPath, agent.agentId, agentCallerRun()) : (sessions.liveFor(requireWorkspace().assistantHome, ASSISTANT_AGENT_ID)?.provider ?? null)
  if (body?.catalog && typeof body.catalog === 'object' && recordCatalog(h, project, role, side, body.catalog, provider)) accepted++
  return { accepted, refused: calls.length + (body?.catalog ? 1 : 0) - accepted }
})

/**
 * The cw-mcp bridge says its CLI has connected it (#865): the launch whose token it calls with may be given Combwork's
 * lines now (sessions.combworkToolsConnected). An agent's or the Assistant's own token only, for its own launch: a token
 * names one launch, so a bridge left from an earlier one is refused (its token has stopped working).
 */
route('POST', '/v1/launch/connected', async () => {
  const agent = agentCaller()
  if (agent) return { ok: sessions.combworkToolsConnected(agent.projectPath, agent.agentId, agentCallerRun() ?? undefined) }
  const ws = assistantCaller()
  const token = assistantCallerToken()
  if (!ws || !token) throw new HttpError(403, apiSaid(API.mcp.connectedOnlyBridge))
  // The Assistant's token is its running launch's (a new one each start): an earlier launch's no longer matches.
  if (!assistant.isCurrentToken(ws, token)) throw new HttpError(403, apiSaid(API.mcp.earlierLaunch))
  return { ok: sessions.combworkToolsConnected(assistant.assistantHome(ws), ASSISTANT_AGENT_ID) }
})

// Where each server is added (HI-2059) is the workspace's to read: a project agent sees only whether its own project has
// it, never another project's names or the Assistant's.
route('GET', '/v1/mcp', async () => {
  const caller = agentCaller()
  const ws = requireWorkspace()
  const servers = await inWorkspace(ws, () => listMcp(!caller))
  if (caller) {
    const own = await inWorkspace(ws, () => workspace.projectConfig(caller.projectPath))
    return servers.map(({ name, def, error }) => ({ name, description: def?.description ?? '', added: serverOnIn({ name, def }, own.mcp, ws.config.mcp.enabled), error }))
  }
  // The catalogue it was installed from (HI-545), for the workspace's callers.
  const origin = (def: McpServerInfo['def']) => (def?.catalog && typeof def.catalog.source === 'string' ? { source: def.catalog.source, version: def.catalog.version } : null)
  return servers.map(({ name, def, projects, assistant: forAssistant, error }) => ({ name, description: def?.description ?? '', added: { projects: projects.map((p) => basename(p)), assistant: forAssistant }, catalog: origin(def), error }))
})

route('POST', '/v1/notify', async ({ body }) => {
  const level: ToastLevel = ['info', 'success', 'warning', 'error'].includes(body?.level) ? body.level : 'info'
  if (!body?.title) throw new HttpError(400, apiSaid(API.card.titleRequired))
  const target = await notifyTarget(body.target)
  toast(level, String(body.title).slice(0, 200), body.message ? String(body.message).slice(0, 2000) : undefined, undefined, body.source ? String(body.source) : 'agent', target)
  return { ok: true, ...(target ? { opens: target.kind === 'agent' ? target.name : target.kind === 'card' ? target.label : target.project } : {}) }
})

/**
 * A notice's target (HI-1961): an agent (`agent`, its id or name, in `project`, by default the caller's own) whose pane
 * a click opens, or a card (`card`, its key) whose dialog it opens. At most one; one that isn't there is refused.
 */
async function notifyTarget(raw: unknown): Promise<ToastTarget | undefined> {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, apiSaid(API.notify.targetArg))
  const t = raw as { agent?: unknown; project?: unknown; card?: unknown }
  const agent = typeof t.agent === 'string' && t.agent ? t.agent : null
  const card = typeof t.card === 'string' || typeof t.card === 'number' ? String(t.card).trim() : ''
  if (agent && card) throw new HttpError(400, apiSaid(API.notify.targetBoth))
  if (card) {
    const ws = requireWorkspace()
    const n = cardOfRef(ws, card, callerScope())
    if (n === null) throw new HttpError(404, apiSaid(API.card.unknown, { card }))
    const c = await tasks.getTask(n, ws)
    // Its workspace too: a card's number is its workspace's alone (HR6 round 1, finding 1).
    return { kind: 'card', number: n, label: cardLabel(c), projectPath: c.project && ws.path ? join(ws.path, c.project) : null, workspacePath: ws.path! }
  }
  if (!agent) throw new HttpError(400, apiSaid(API.notify.targetNames))
  const own = agentCaller()
  const projectPath = typeof t.project === 'string' && t.project ? projectByName(t.project) : own?.projectPath
  if (!projectPath) throw new HttpError(400, apiSaid(API.notify.sayProject))
  const id = await agentParam(projectPath, agent)
  const def = projectAgents(await workspace.projectConfig(projectPath)).find((x) => x.id === id)
  return { kind: 'agent', projectPath, agentId: id, name: def?.name ?? agent, project: basename(projectPath) }
}

// ---------------------------------------------------------------------------
// Progress: long runs (tests, builds) for the Progress panel
// ---------------------------------------------------------------------------

/** Who is reporting progress, by the caller's token: a project agent, this workspace's Assistant, or a script. */
async function progressCaller(): Promise<ProgressCaller> {
  const ws = requireWorkspace()
  const workspacePath = ws.path!
  const life = ws.lifetime
  const caller = await progressCallerIn(workspacePath)
  progressWorkspaceOpen(ws, workspacePath, life)
  return caller
}

/** Looking the caller up waited: a workspace that closed meanwhile (its runs cleared) must not get a run back. */
function progressWorkspaceOpen(ws: WorkspaceService, workspacePath: string, life: WorkspaceService['lifetime']): void {
  if (life.aborted || ws.path?.toLowerCase() !== workspacePath.toLowerCase()) throw new HttpError(409, apiSaid(API.workspace.closed))
}

async function progressCallerIn(workspacePath: string): Promise<ProgressCaller> {
  const a = agentCaller()
  if (a) {
    const cfg = await workspace.projectConfig(a.projectPath)
    const def = projectAgents(cfg).find((x) => x.id === a.agentId)
    return { source: 'agent', workspacePath, projectPath: a.projectPath, agentId: a.agentId, agentName: def?.name ?? a.agentId, provider: def ? agentProvider(def, config.settings) : null }
  }
  if (assistantCaller()) {
    const live = sessions.liveFor(join(workspacePath, CW_DIR, ASSISTANT_DIR), ASSISTANT_AGENT_ID)
    // agent-protocol: the Assistant's name
    return { source: 'assistant', workspacePath, agentName: `Combwork ${ASSISTANT_NAME}`, provider: live?.provider ?? null }
  }
  return { source: 'api', workspacePath }
}

/** A JSON object body, or an empty one. */
const bodyObject = (body: unknown): Record<string, unknown> => (body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {})

/**
 * Runs a progress call: with the panel off, or switched off (or off and on) while the caller was looked up, it is
 * accepted and ignored, so a reporter never fails because of it and nothing lands in a store the setting cleared.
 */
async function progressCall<T>(ignored: T, change: (caller: ProgressCaller) => T): Promise<T> {
  try {
    return await admitReport(progressGate, ignored, progressCaller, change)
  } catch (e) {
    throw e instanceof ProgressError ? httpFrom(e.status, e) : e
  }
}

// The Progress panel's runs (#620), newest first, as the panel lists them (Recent from before a restart included), in
// their public form (publicRun: no command line or reporter's text): the request's workspace's, or for a project agent
// its project's. Empty with the panel turned off.
// ---------------------------------------------------------------------------
// Developer console (#636): read-only and redacted, while Settings → Agent API lets agents read it. A project agent reads
// its own sessions, the Assistant its workspace's. Reading starts nothing (#366 decision 4: capture is off unless the
// console is open): it gives what an open console is capturing, and says when nothing is.
// ---------------------------------------------------------------------------

/** Events a read gives at most, the events one read gives in full, and the sources a page lists. */
const CONSOLE_ROWS = 30
const CONSOLE_ROWS_MAX = 100
const CONSOLE_DETAIL_MAX = 3
const CONSOLE_SOURCES = 50
const CONSOLE_SOURCES_MAX = 100
const NOT_READABLE = API.console.notReadable

function consoleReader(): ConsoleReader {
  const a = agentCaller()
  if (a) return { kind: 'agent', projectPath: a.projectPath, agentId: a.agentId }
  const own = assistantCaller()
  return own ? { kind: 'assistant', workspace: own } : { kind: 'all' }
}

function consoleAllowed(): void {
  if (config.settings.agentApi.devConsole !== true) throw new HttpError(403, apiSaid(API.console.off))
}

const consoleWorkspaceOf = (projectPath: string): string | null => workspaceFor(projectPath)?.path ?? null

/**
 * The source a console request names: source=combwork or source=assistant (the request's workspace), or an agent (agent,
 * and project unless it is the caller's own); a project agent naming none reads its own session. Anything the caller
 * may not read is refused as if it didn't exist (404), and so is anything an agent names that doesn't.
 */
async function consoleSource(query: URLSearchParams): Promise<string> {
  const which = query.get('source')
  const project = query.get('project')
  const agent = query.get('agent')
  const me = agentCaller()
  let id: string
  try {
    if (which === 'combwork') id = combworkSourceId(requireWorkspace().path!)
    else if (which === 'assistant') id = sessionSourceId(requireWorkspace().assistantHome, ASSISTANT_AGENT_ID)
    else if (which) throw new HttpError(400, apiSaid(API.console.sourceArg))
    else if (!project && !agent) {
      if (!me) throw new HttpError(400, apiSaid(API.console.saySource))
      id = sessionSourceId(me.projectPath, me.agentId)
    } else {
      const p = project ? projectByName(project) : me?.projectPath
      if (!p) throw new HttpError(400, apiSaid(API.console.projectWithAgent))
      id = sessionSourceId(p, await agentParam(p, agent ?? undefined))
    }
  } catch (e) {
    // An agent learns nothing of what it can't read: an unknown project or agent is refused as one it may not read.
    if (me && !(e instanceof HttpError && e.status === 400)) throw new HttpError(404, apiSaid(NOT_READABLE))
    throw e
  }
  if (!mayRead(consoleReader(), id, consoleWorkspaceOf)) throw new HttpError(404, apiSaid(NOT_READABLE))
  return id
}

/** A source as a reply names it (bounded names; whether an open console is capturing it, and how many events it holds). */
function consoleRow(s: ConsoleSource | undefined, id: string) {
  const kind = s?.kind ?? (id.startsWith('combwork:') ? 'combwork' : 'session')
  // `select` names it exactly as a read takes it (the agent's id and its project's own name), apart from the display
  // label, which is cut and masked: following a listing always reads the source it lists.
  const select = kind === 'combwork' ? { source: 'combwork' } : kind === 'assistant' ? { source: 'assistant' } : s?.agentId && s.project ? { agent: s.agentId, project: s.project } : undefined
  // agent-protocol: the app's name, as a source's label
  return { label: combworkName(s?.label ?? (kind === 'combwork' ? 'Combwork' : say(API.console.anAgent)), 80), kind, ...(select ? { select } : {}), ...(s?.provider ? { provider: s.provider } : {}), capturing: devConsole.capturing(id), events: devConsole.count(id) }
}

const consoleRowOf = (e: ConsoleEvent) => ({ seq: e.seq, at: e.at, kind: e.kind, name: e.name, summary: e.summary, ...(e.truncated ? { truncated: true } : {}) })

/** A whole number from the query between `min` and `max`, else `fallback`. */
function intParam(query: URLSearchParams, name: string, fallback: number, min: number, max: number): number {
  const n = Number(query.get(name))
  return query.has(name) && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback
}

route('GET', '/v1/console/sources', async ({ query }) => {
  consoleAllowed()
  const reader = consoleReader()
  const all = consoleSources(requireWorkspace()).filter((s) => mayRead(reader, s.id, consoleWorkspaceOf))
  const offset = intParam(query, 'offset', 0, 0, all.length)
  const limit = intParam(query, 'limit', CONSOLE_SOURCES, 1, CONSOLE_SOURCES_MAX)
  return { total: all.length, offset, sources: all.slice(offset, offset + limit).map((s) => consoleRow(s, s.id)) }
})

route('GET', '/v1/console/events', async ({ query }) => {
  consoleAllowed()
  const id = await consoleSource(query)
  const ws = contextWorkspace()
  const source = consoleRow(ws ? consoleSources(ws).find((x) => x.id === id) : undefined, id)
  const seqs = (query.get('seq') ?? '').split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0)
  if (seqs.length) {
    if (seqs.length > CONSOLE_DETAIL_MAX) throw new HttpError(400, apiSaid(API.console.detailMax, { max: String(CONSOLE_DETAIL_MAX) }))
    const events = seqs.map((n) => devConsole.event(id, n)).filter((e): e is ConsoleEvent => !!e)
    return { source, events, missing: seqs.filter((n) => !events.some((e) => e.seq === n)) }
  }
  const kinds = (query.get('kinds') ?? '').split(',').map((k) => k.trim()).filter(Boolean)
  const unknown = kinds.filter((k) => !(CONSOLE_KINDS as readonly string[]).includes(k))
  if (unknown.length) throw new HttpError(400, apiSaid(API.console.unknownKinds, { kinds: unknown.slice(0, 5).map((k) => k.slice(0, 30)).join(', '), known: CONSOLE_KINDS.join(', ') }))
  const since = intParam(query, 'since', 0, 0, Number.MAX_SAFE_INTEGER)
  const limit = intParam(query, 'limit', CONSOLE_ROWS, 1, CONSOLE_ROWS_MAX)
  const after = devConsole.events(id, since).filter((e) => !kinds.length || kinds.includes(e.kind as ConsoleKind))
  // The first read gives the newest; a read with since carries on from there, oldest first, so paging misses none.
  const events = since ? after.slice(0, limit) : after.slice(-limit)
  const rest = after.length - events.length
  return { source, events: events.map(consoleRowOf), ...(rest ? (since ? { newer: rest } : { older: rest }) : {}), newest: events.length ? events[events.length - 1].seq : since }
})

route('GET', '/v1/progress', async () => {
  const ws = requireWorkspace()
  const workspacePath = ws.path!
  await progress.loadHistory(workspacePath)
  const me = agentCaller()
  const runs = progress.list(workspacePath).filter((r) => !me || (r.projectPath !== null && samePlace(r.projectPath, me.projectPath)))
  return { workspacePath, enabled: progressGate.on(), runs: runs.map(publicRun) }
})

/** How a run's card, revision and check are looked up (#1220): the board, git in its folder, the project's options. */
const runLinkDeps: RunLinkDeps = {
  card: (n) => tasks.getTask(n).then((c) => (c.archived ? null : { project: c.project, column: c.column, agent: c.agent }), () => null),
  doing: (projectPath, agentId) => tasks.agentCards(basename(projectPath), agentId).then((cs) => cs.filter((c) => c.column === 'doing').map((c) => c.number)),
  cardRun: (n, folder, named) => cardRunRevision(requireWorkspace(), n, folder, named),
  head: folderHead,
  commitOf: commitIn,
  projectName: (projectPath) => basename(projectPath),
  keyCard: (key, scope) => cardOfRef(requireWorkspace(), key, scope),
  // A folder in a review or check copy (#1435): its lease's card and revision, whatever the agent's card is. A project
  // agent's own project's copies only.
  copyAt: async (folder, scope) => {
    const ws = requireWorkspace()
    const projects = scope !== null ? [join(ws.path!, scope)] : await ws.listProjectPaths()
    for (const p of projects) {
      const got = await copyAt(ws, p, folder).catch(() => null)
      if (got) return got.lease && !got.lease.returned ? { copy: got.copy, card: got.lease.card, revision: got.lease.revision } : { copy: got.copy, card: null, revision: null }
    }
    return null
  },
  // The options' check commands (SPEC §16.6.6: project.json's `workflow.options`), until #1218 resolves them with defaults.
  checkCommand: async (project, name) => {
    const cfg = (await workspace.projectConfig(join(requireWorkspace().path!, project)).catch(() => null)) as { workflow?: { options?: { commands?: Record<string, unknown> } } } | null
    const command = cfg?.workflow?.options?.commands?.[name]
    return typeof command === 'string' && command.trim() ? command.trim() : null
  }
}

/** The links resolve gave out, for the starts that pass them back (runLink.ts). */
const issuedLinks = new IssuedLinks()

/** What a progress request says it runs for, resolved and checked (runLink.ts): its 400s as the API's. */
async function runLinkOf(body: Record<string, unknown>) {
  try {
    const caller = await progressCallerIn(requireWorkspace().path!)
    return { caller, link: await resolveRunLink(caller, body, runLinkDeps) }
  } catch (e) {
    throw e instanceof ProgressError ? httpFrom(e.status, e) : e
  }
}

// What a run would run for (#1220), checked before its command starts: cw-progress calls it first, so a revision that
// isn't checked out, an unknown card or a check with no command is refused before anything runs. Its `link` is for the
// start: the only way a start gets the checkout seen here rather than read again.
route('POST', '/v1/progress/resolve', async ({ body }) => {
  const ws = requireWorkspace()
  const b = bodyObject(body)
  const resolved = await runLinkOf(b)
  const caller = resolved.caller
  let link: RunLink = resolved.link
  // An isolated check (#1435, `--isolated`): leased a check copy at the card's revision, the run's folder that copy.
  const iso = b.isolated === true ? await isolatedFor(ws, caller, link, typeof b.ticket === 'string' ? b.ticket : undefined) : null
  if (iso) link = { ...link, folder: iso.folder, testedCheckout: link.revision, copy: iso.copy, isolated: true }
  const id = issuedLinks.issue(linkOwner(caller), link)
  if (iso) await isolatedLinked(ws, iso.project, iso.lease, id)
  // What a run for a card is checked against (#1222), read now: cw-progress starts its command after this reply, and
  // reports its start up to 2 s later. Its start takes it with the link.
  const bracket = await bracketFor(ws, link).catch((e) => (log.warn('could not read what a run is checked against', e), null))
  if (bracket) bracketResolved(id, bracket)
  return { ...publicLink(link, id), ...(iso ? { isolated: { lease: iso.lease, copy: iso.copy } } : {}) }
})

/**
 * An isolated check's copy (#1435): an agent's check for a card of its own project on Git, leased at the card's revision.
 * Refused (400) for anything else, with what to do; 409 with `wait` while no copy is free (cw-progress asks again).
 */
async function isolatedFor(ws: WorkspaceService, caller: ProgressCaller, link: RunLink, ticket?: string): Promise<{ project: string; lease: string; folder: string; copy: string }> {
  if (caller.source !== 'agent') throw new HttpError(400, apiSaid(API.check.isolatedAgentsOnly))
  if (!link.check) throw new HttpError(400, apiSaid(API.check.isolatedNeedsCheck))
  if (link.card === null || !link.revision) throw new HttpError(400, apiSaid(API.check.isolatedNeedsCard))
  const cfg = await ws.projectConfig(caller.projectPath).catch(() => null)
  // None has no check copies (OP-16): its remedy is running again once the deliverables are quiet.
  const platform = platformIdOf(caller.projectPath, cfg?.platform)
  if (!hasCapability(platform, 'isolation')) throw new HttpError(400, apiSaid(API.check.noVcs))
  // jj has slots but no check copies yet (HI-2868): refused before any copy is leased, the check run in the card's slot.
  if (!hasCapability(platform, 'checkCopies')) throw new HttpError(400, apiSaid(API.check.noCopies))
  // Leased and set up apart from this request (a first setup takes minutes): `wait` with a ticket to ask again with.
  const got = await isolatedRequest(ws, caller.projectPath, linkOwner(caller), { card: link.card, revision: link.revision, agent: caller.agentId }, ticket)
  if ('wait' in got) throw new HttpError(409, apiSaid(API.check.waiting, { what: got.wait }), { wait: got.wait, ...(got.ticket ? { ticket: got.ticket } : {}) })
  if ('refused' in got) throw new HttpError(400, got.refused)
  return { project: caller.projectPath, lease: got.lease.id, folder: got.folder, copy: got.copy }
}

// An isolated check's launcher put in its check copy's job before it runs the command (#1435): only by the agent the
// lease is for, while the lease is out.
route('POST', '/v1/progress/isolated', async ({ body }) => {
  const ws = requireWorkspace()
  const a = agentCaller()
  if (!a) throw new HttpError(403, apiSaid(API.check.onlyIsolated))
  const b = bodyObject(body)
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : NaN)
  const req = { lease: typeof b.lease === 'string' ? b.lease : '', pid: num(b.pid), after: num(b.after), before: num(b.before) }
  if (!req.lease || !Number.isInteger(req.pid) || req.pid <= 0 || Number.isNaN(req.after) || Number.isNaN(req.before)) throw new HttpError(400, apiSaid(API.check.leaseArgs))
  const why = await assignIsolated(ws, a.projectPath, a.agentId, req)
  if (why) throw new HttpError(409, why)
  return { ok: true }
})

// A start resolves what it runs for inside its admission (admitLinked): a panel turned off, or off and on, while its
// link is looked up (the board, git) ignores it, and a workspace closed meanwhile gets no run.
route('POST', '/v1/progress', async ({ body }) => {
  const b = bodyObject(body)
  const ws = requireWorkspace()
  const workspacePath = ws.path!
  const life = ws.lifetime
  // What the run is checked against as a check of its card (#1222): read at resolve, when it passes that link back;
  // else now (a start through the Agent API, its command its caller's own).
  let bracket: Bracket | null = null
  try {
    return await admitLinked<{ id: string; ignored?: true }>(
      progressGate,
      { id: `ignored-${randomBytes(6).toString('hex')}`, ignored: true },
      {
        caller: () => progressCallerIn(workspacePath),
        link: async (caller) => {
          const taken = issuedLinks.take(linkOwner(caller), b.link)
          if (taken) {
            bracket = takeResolved(b.link)
            return taken
          }
          const link = await resolveRunLink(caller, b, runLinkDeps)
          bracket = await bracketFor(ws, link).catch((e) => (log.warn('could not read what a run is checked against', e), null))
          return link
        },
        settled: () => progressWorkspaceOpen(ws, workspacePath, life)
      },
      (caller, link) => {
        const run = progress.start(caller, b, { ...link, check: link.check?.name ?? null })
        if (bracket) bracketStarted(run.id, bracket)
        // An isolated check's lease is its run's from now on (#1435): its finish returns the copy.
        if (link.copy && caller.source === 'agent' && typeof b.link === 'string') void retakeIsolated(ws, caller.projectPath, b.link, run.id)
        return { id: run.id }
      }
    )
  } catch (e) {
    throw e instanceof ProgressError ? httpFrom(e.status, e) : e
  }
})

route('PATCH', '/v1/progress/:id', async ({ params, body }) =>
  progressCall<{ ok: true; ignored?: true }>({ ok: true, ignored: true }, (caller) => {
    progress.update(caller, decodeURIComponent(params[0]), bodyObject(body))
    return { ok: true }
  })
)

/** How long a finish waits for its run's record as a check, to say how it counted (#1654): cw-progress waits a little longer. */
const CHECK_REPLY_MS = 8000

route('POST', '/v1/progress/:id/finish', async ({ params, body }) => {
  const recording: { check?: Promise<Recorded | null> } = {}
  const r = await progressCall<{ ok: true; ignored?: true }>({ ok: true, ignored: true }, (caller) => {
    const id = decodeURIComponent(params[0])
    // Ended by Stop in the Progress panel (#1435): stopped, whatever its command's exit says.
    const run = progress.finish(caller, id, takeStopped(id) ? { ...bodyObject(body), ok: false, stopped: true } : bodyObject(body))
    // Recorded as a check first (its copy still at the revision), then its isolated check's copy returned (#1435).
    recording.check = recordCheck(run)
    void recording.check.then(() => isolatedRunEnded(requireWorkspace(), run.id)).catch((e) => log.warn('returning a check copy', e))
    return { ok: true }
  })
  // How it counted as a check, once recorded (within CHECK_REPLY_MS): cw-progress says why one didn't (#1654).
  const c = recording.check ? await within(recording.check, CHECK_REPLY_MS) : null
  return c ? { ...r, check: { name: c.name, counted: c.counted, ...(c.whyNot ? { whyNot: c.whyNot } : {}), ...(c.changes ? { changes: c.changes } : {}), platform: c.platform } } : r
})

/** A promise's value, or null once `ms` has passed first. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)))
  try {
    return await Promise.race([p, late])
  } finally {
    clearTimeout(timer)
  }
}

/** An isolated check's lease, held by the link resolve gave out, taken by the run that started with it. */
async function retakeIsolated(ws: WorkspaceService, projectPath: string, linkId: string, runId: string): Promise<void> {
  const pool = await copiesFor(ws, projectPath)
  const l = pool.leaseByRef(linkId)
  if (l) await pool.setRef(l.id, runId)
}

/** A finished run for a card: its `CheckRan` in the card's facts (#1222), and how it counted on the run's row. */
async function recordCheck(run: ProgressRun): Promise<Recorded | null> {
  try {
    const c = await bracketFinished(run)
    if (c) progress.noteCheck(run.workspacePath, run.id, { name: c.name, counted: c.counted, ...(c.whyNot ? { whyNot: c.whyNot } : {}), ...(c.blocks ? { blocks: c.blocks } : {}) })
    return c
  } catch (e) {
    log.warn(`could not record run ${run.id} as a check of #${run.card}`, e)
    return null
  }
}

async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Measured from here to the response's end (or the client going away): latency on the monotonic clock, bodies'
  // UTF-8 bytes, outcome. Recorded once it ends, never in the way of the request.
  const started = metricsClock.mono()
  // agent-protocol: a metrics route label for a request no route matched
  const m: ApiRequest = { route: '(no route)', handle: null, project: null, role: 'unknown', requestBytes: 0, responseBytes: 0, skip: false, authenticated: false, waiting: false, ws: null }
  apiRequests.set(res, m)
  appMetrics.requestStarted()
  // Named in a "main process was busy" warning that it overlaps, by its route once known (mainStalls.ts).
  const working = beginWork(() => apiLabel(req.method, m.route))
  let who: Caller | null = null
  res.once('close', () => {
    appMetrics.requestEnded()
    working()
    if (!m.authenticated) appMetrics.unauthenticated()
    else if (!m.skip && m.handle) recordApi(m.handle, m.project, { route: m.route, method: req.method ?? '', role: m.role, outcome: outcomeOf(res, m), requestBytes: m.requestBytes, responseBytes: m.responseBytes, ms: metricsClock.mono() - started, ...(m.reason ? { reason: m.reason } : {}) })
    if (m.authenticated && !m.skip && !m.route.startsWith('/v1/console')) captureApiCall(req, res, url, m, who, metricsClock.mono() - started)
  })
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  // The fixed hook URL (HI-2777): a CLI's hooks, on their own route, never the API's (no API token counts there, and a hook
  // token counts nowhere else). Not in the API's metrics.
  if (url.pathname === '/hook') {
    m.authenticated = true
    m.skip = true
    return serveFixedHook(req, res)
  }
  // Browsers must not be able to drive the API from a web page.
  if (req.headers.origin) return send(res, 403, { error: say(API.http.crossOrigin) })
  const enabled = config.settings.agentApi.enabled
  if (url.pathname === '/v1/health' && enabled) {
    m.authenticated = true
    m.skip = true
    // agent-protocol: the app's name
    return send(res, 200, { ok: true, app: 'Combwork', version: app.getVersion() })
  }
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
  const ownWorkspace = bearer ? assistant.assistantForToken(bearer) : null
  // A project agent's own token and a viewer token work while the Agent API is on, as the workspace token does.
  const agent = enabled && bearer && !ownWorkspace ? agentForToken(bearer) : null
  const viewer = enabled && bearer && !ownWorkspace && !agent ? viewerForToken(bearer) : null
  const caller: Caller | null = ownWorkspace
    ? { kind: 'assistant', workspace: ownWorkspace, token: bearer }
    : agent
      ? { kind: 'agent', ...agent }
      : viewer
        ? { kind: 'viewer', id: viewer.id, name: viewer.name }
        : enabled && tokenMatches(req.headers.authorization, apiToken)
          ? { kind: 'api' }
          : null
  if (!caller) return send(res, enabled ? 401 : 403, { error: enabled ? say(API.http.badToken) : say(API.http.apiOff) })
  m.authenticated = true
  m.role = caller.kind
  who = caller
  // An agent's work is its project's; the Assistant's and scripts' are the workspace's own (not spread over projects).
  if (caller.kind === 'agent') m.project = basename(caller.projectPath)
  // Its replies are in the caller's dialect (HI-2065): its session's, or for a caller with none the API chain of the
  // workspace the request names (or the only one open), decided here once for the whole request, its early and error
  // replies too, never from the window with the focus (HR1 on HI-2443); none named among several: the Default. Loaded
  // first where it isn't yet (kept until that workspace's dialect files change).
  const apiWs = caller.kind === 'agent' || caller.kind === 'assistant' ? null : callerStore.run(caller, () => {
    try {
      return requestWorkspace(req, url)
    } catch {
      return null
    }
  })
  const apiDir = apiWs?.path ? apiWs.combworkDir : null
  if (apiDir) await apiChainReady(apiDir)
  return callerStore.run(caller, () => inApiWorkspace(apiDir, () => inRequestScope(caller.kind === 'agent' ? caller : caller.kind === 'assistant' ? { projectPath: join(caller.workspace, CW_DIR, ASSISTANT_DIR), agentId: ASSISTANT_AGENT_ID } : null, () => serveApi(req, res, url))))
}

async function serveApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const m = apiRequests.get(res)!
  if (url.pathname === '/v1/health') {
    m.skip = true
    // agent-protocol: the app's name
    return send(res, 200, { ok: true, app: 'Combwork', version: app.getVersion() })
  }

  // A viewer changes nothing: whatever the route (a wait that holds a watch, a report), only a GET is served. Refused
  // before its body is read or its route looked up, so no write is ever reached.
  if (viewerCaller() && req.method !== 'GET') return send(res, 403, { error: say(API.http.viewerReadOnly) })

  if (req.method === 'GET' && url.pathname === '/v1/events') {
    // Events are about every open workspace: not for an Assistant, which sees only its own (it has cw_wait_for_agents).
    if (assistantCaller()) return send(res, 403, { error: say(API.http.eventsForCallers) })
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    res.write(': connected\n\n')
    // A caller with no session keeps the workspace its request was for (the one it names, or the only one open): its
    // stream's lines are said in that workspace's API chain, whatever request is running when an event comes (HI-2465).
    const agent = agentCaller()
    sseClients.set(res, { agent, apiDir: agent ? null : requestApiWorkspace(), run: agentCallerRun(), viewer: viewerCaller()?.id ?? null })
    // A stream is counted as one (connections, events, bytes, how long it stayed open), not as a request's latency.
    m.skip = true
    // Named so in a "main process was busy" warning (mainStalls.ts), which leaves it out once it is just open.
    m.route = '/v1/events'
    const opened = metricsClock.mono()
    appMetrics.stream({ connections: 1 })
    req.on('close', () => {
      sseClients.delete(res)
      appMetrics.stream({ openMs: metricsClock.mono() - opened })
    })
    return
  }

  // Whose request it is, for metrics, known before the body is read: an unknown route or a client that goes away while
  // sending its body is still counted for the workspace. (The request's own errors come below, in their usual order.)
  try {
    const w = requestWorkspace(req, url)
    m.handle = metricsHandle(w)
    m.ws = w?.path ?? null
  } catch {
    m.handle = null
  }
  const r = routes.find((x) => x.method === req.method && x.pattern.test(url.pathname))
  if (!r) return send(res, 404, { error: say(API.http.noRoute, { method: req.method ?? '', path: url.pathname }) })
  m.route = r.template
  // The bridge's reports about its tool calls are bookkeeping, not traffic: counting them would count every call twice
  // (and its word that it has connected, #865, is the same).
  if (r.template === '/v1/metrics/mcp' || r.template === '/v1/launch/connected') m.skip = true
  try {
    // Counted as received (a body the client stops sending, or one too large, is counted as far as it came).
    const raw = req.method === 'GET' ? '' : await readBody(req, (bytes) => (m.requestBytes += bytes))
    let body: unknown = {}
    if (raw) {
      try {
        body = JSON.parse(raw)
      } catch {
        throw new HttpError(400, apiSaid(API.http.bodyJson))
      }
    }
    const params = url.pathname.match(r.pattern)!.slice(1)
    // With several Combwork windows, a request is for one workspace: the one it names, or the only one open.
    const ws = requestWorkspace(req, url)
    const gone = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) gone.abort()
    })
    // Its replies name cards by key (#1219: "HI-12 (#40)"), its workspace's.
    const run = (): Promise<unknown> => withCardNames(ws, () => r.handler({ params, query: url.searchParams, body, signal: gone.signal }), callerScope())
    // A project agent's replies say when a card it works on or reviews has a new decision (#357), whatever it called:
    // the Combwork tools add the line to their reply. (The bridge's own reports about its calls aren't the agent's.) Its
    // cards as they were when the call began count too, so the call that moves a card on (to Review, say) still hears
    // of a decision it hasn't read, unless the call read it.
    const flagged = r.template !== '/v1/metrics/mcp' && r.template !== '/v1/launch/connected'
    const began = Date.now()
    const before = flagged ? await decisionsNew(ws) : null
    const result = ws ? await inWorkspace(ws, run) : await run()
    const notice = flagged ? await withCardNames(ws, () => decisionsNotice(ws, before, began), callerScope()) : null
    send(res, 200, result ?? null, notice ? { 'X-Combwork-Notice': encodeURIComponent(notice) } : {})
  } catch (e) {
    const { status, body } = apiErrorReply(e)
    if (status === 500) log.error(`API ${req.method} ${url.pathname}`, e)
    // A wait (resolve's 409 while no check copy is free) is an answer to ask again, not a failure (HI-1831).
    if (e instanceof HttpError && e.extra && 'wait' in e.extra) m.waiting = true
    // Why it was refused or a wrong call (HI-2553): its rule's or message's id, never its text.
    if (status >= 400 && status < 500) m.reason = reasonOf(e)
    send(res, status, body)
  }
}

/**
 * The developer console (#636): an Agent API call as it ended, in its workspace's Combwork events and in the calling agent's
 * (or Assistant's) own session. Its route and how it went, never its body or the reply: the query's names only.
 */
function captureApiCall(req: IncomingMessage, res: ServerResponse, url: URL, m: ApiRequest, who: Caller | null, ms: number): void {
  const own = who?.kind === 'agent' ? sessionSourceId(who.projectPath, who.agentId) : who?.kind === 'assistant' ? sessionSourceId(join(who.workspace, CW_DIR, ASSISTANT_DIR), ASSISTANT_AGENT_ID) : null
  devConsole.capture([m.ws && combworkSourceId(m.ws), own], () => {
    const name = `${req.method ?? ''} ${m.route}`
    const outcome = outcomeOf(res, m)
    // agent-protocol: the developer console's record of a call (a log line)
    const by = who?.kind === 'agent' ? `agent ${who.agentId}` : who?.kind ?? 'unknown'
    return {
      kind: 'api',
      name,
      raw: { method: req.method, route: m.route, params: [...new Set(url.searchParams.keys())].slice(0, 20), role: m.role, project: m.project, requestBytes: m.requestBytes },
      made: { status: res.statusCode, outcome, ms: Math.round(ms), responseBytes: m.responseBytes },
      // The query's parameter names are kept (identifiers only, never their values).
      safe: { raw: { method: true, route: true, params: true, role: true, project: true }, made: { outcome: true } },
      // agent-protocol: the developer console's record of a call (a log line)
      summary: `${name} by ${by}${m.project ? ` (${m.project})` : ''} → ${res.statusCode} ${outcome} in ${Math.round(ms)} ms`
    }
  })
}

/** A project agent's cards with decisions new to it (#357), now; null for other callers. Never fails the call. */
async function decisionsNew(ws: WorkspaceService | null): Promise<Map<number, number> | null> {
  const me = agentCaller()
  const w = ws ?? (me ? workspaceFor(me.projectPath) : null)
  if (!me || !w) return null
  try {
    const actor = await inWorkspace(w, taskActor)
    return await newDecisions(w, me, tasks.actorName(actor))
  } catch (e) {
    log.warn('decision notice', e)
    return null
  }
}

/**
 * The "new decision" flag for a project agent's reply to any call (null for others, or when there is none): its cards
 * now, and those it had when the call began (`before`, at `began`) unless the call read them in full.
 */
async function decisionsNotice(ws: WorkspaceService | null, before: Map<number, number> | null, began: number): Promise<string | null> {
  const me = agentCaller()
  const now = await decisionsNew(ws)
  if (!me || !now) return null
  for (const [n, k] of before ?? []) if (!now.has(n) && lastCardRead(me, n) < began) now.set(n, k)
  return noticeText(now)
}

/**
 * The Agent API's answer to an error: its status, and its text whatever language Combwork shows (#845), in the caller's
 * dialect (dialects, HI-2440: a CombworkError's text, also one answered with another status, said in the request's scope).
 */
export function apiErrorReply(e: unknown): { status: number; body: Record<string, unknown> } {
  // A refusal's `error` is its `message`, word for word (HI-3136: the same sentence, filled as the reader's).
  if (e instanceof tasks.WorkflowRefusedError) {
    const refused = refusalBody(e.refusal)
    return { status: errorStatus(e), body: { error: refused.message, ...refused } }
  }
  // agent-protocol: a CombworkError's text, carried by httpFrom: its messages are found where it was thrown
  const error = e instanceof HttpError && e.text !== undefined ? agentText(e.text) : agentError(e)
  return { status: errorStatus(e), body: { error, ...(e instanceof HttpError ? e.extra : undefined) } }
}

/**
 * Combwork's own text as data beside an English field (#845, `WindowTextField` in types.ts) is the window's: agents read
 * the English. Replies are built field by field (sessions' status, skills, MCP servers, events); where a whole object
 * goes out, these leave its companions behind, and only them: the rest of the object, whatever it holds, as it is.
 */
/**
 * A card's history entry or comment: without its id (replies stay lean) or its text as data, its English said in the
 * reader's dialect where its chain overrides the line's message (storedForAgents, dialects HI-2440), else as stored.
 */
export const entryForAgents = <T extends { id?: string; what?: string; text?: string; whatText?: unknown; appText?: unknown }>({ id: _id, whatText, appText, ...rest }: T): Omit<T, 'id' | 'whatText' | 'appText'> =>
  ({ ...rest, ...(typeof rest.what === 'string' && whatText ? { what: storedForAgents(rest.what, whatText) } : {}), ...(typeof rest.text === 'string' && appText ? { text: storedForAgents(rest.text, appText) } : {}) }) as Omit<T, 'id' | 'whatText' | 'appText'>
/** A metrics report: its lists of what wasn't measured or filtered in English only. */
/**
 * /v1/metrics in 0.9.3 only (#1084; deprecated, gone in the next release): each guidance series also under its names from before 0.9.3, when the
 * Assistant's mode was its persona (`personaBytes`, `personaChars`).
 */
export function withPersonaAliases(r: MetricsReport): MetricsReport {
  const part = (p: MetricsPart): MetricsPart => ({ ...p, guidance: p.guidance.map((g) => ({ ...g, personaBytes: g.modeBytes, personaChars: g.modeChars }) as GuidanceSeries) })
  return { ...r, projects: Object.fromEntries(Object.entries(r.projects).map(([k, p]) => [k, part(p)])), ...(r.workspace ? { workspace: part(r.workspace) } : {}) }
}

export function metricsForAgents<R extends { notMeasured?: string[]; notMeasuredText?: TextPart[]; providersNote?: string; providersNoteText?: TextPart; filters?: { notFiltered?: string[]; notFilteredText?: TextPart[] } }>(r: R): Omit<R, 'notMeasuredText' | 'providersNoteText'> {
  // Their English said in the caller's dialect (agentField, dialects HI-2440), each item from its text as data.
  const said = (english: string[] | undefined, texts: TextPart[] | undefined): string[] | undefined => english?.map((e, i) => agentField(e, texts?.[i]))
  const { notMeasuredText, providersNoteText, ...rest } = r
  const out = { ...rest, ...(rest.notMeasured ? { notMeasured: said(rest.notMeasured, notMeasuredText) } : {}), ...(rest.providersNote !== undefined ? { providersNote: agentField(rest.providersNote, providersNoteText) } : {}) }
  if (!out.filters) return out
  const { notFilteredText, ...filters } = out.filters
  return { ...out, filters: { ...filters, ...(filters.notFiltered ? { notFiltered: said(filters.notFiltered, notFilteredText) } : {}) } }
}
/** An agent just added: its reuse note in English only. */
export function addedForAgents<A extends { reuse?: { notReused?: string; notReusedText?: TextPart } }>(a: A): A {
  if (!a.reuse) return a
  const { notReusedText, ...reuse } = a.reuse
  return { ...a, reuse: { ...reuse, ...(reuse.notReused !== undefined ? { notReused: agentField(reuse.notReused, notReusedText) } : {}) } }
}

/** What a CombworkError's kind answers with (#845). */
const KIND_STATUS = { invalid: 400, forbidden: 403, notFound: 404, conflict: 409 } as const

/**
 * The status the Agent API answers an error with. The session and workspace services don't know about HTTP: a
 * Combwork error's kind says it (CombworkError, SaidError, KindedError), given where it is thrown from its message
 * alone, never from a name or a quoted value in it (HI-2704). Errors that aren't Combwork's own go by statusFor().
 */
function errorStatus(e: unknown): number {
  const own = ownStatus(e)
  if (own !== undefined) return own ?? 500
  return e instanceof HttpError ? e.status : e instanceof tasks.TaskPermissionError ? 403 : e instanceof tasks.TaskConflictError ? 409 : statusFor(e as Error)
}

/**
 * A Combwork error's own status: its kind's, null for one with none (it answers 500, whatever its words), undefined for
 * an error that isn't Combwork's. A route that wraps a service's refusals keeps it (HI-2704), its own status only for one
 * with none.
 */
function ownStatus(e: unknown): number | null | undefined {
  if (!(e instanceof CombworkError || e instanceof SaidError || e instanceof KindedError)) return undefined
  return e.kind ? KIND_STATUS[e.kind] : null
}

/**
 * The status of an error that isn't Combwork's own, by its words; anything else with no kind answers 500. Combwork's
 * own errors give theirs as a kind where they are thrown (HI-2704: the English patterns this held for them are gone, so
 * a name such as "busy" in a message no longer changes its status).
 * - `URI malformed`: decodeURIComponent's error, for a request path that doesn't decode (400).
 * - `EBUSY`: Node's, for a file another program holds open (409, as before HI-2704).
 */
function statusFor(e: Error): number {
  const m = String(e?.message ?? '')
  if (/URI malformed/.test(m)) return 400
  if (/^EBUSY\b/.test(m)) return 409
  return 500
}

/**
 * Each stream client's line for an event (apiEvents.ts: every event for the workspace token and viewers, a project agent
 * its project's), said in that client's own dialect scope (HI-2465), bound here whatever request or none is running as
 * the event comes: an agent's session's chain; for the workspace token and viewers, the API chain of the workspace their
 * stream was opened for while it is open (`open`, .combwork folders in lower case; closed, or none named: the Default). One
 * line per agent, and per such workspace.
 */
function streamLines(event: CombworkEvent, open: ReadonlySet<string>): (client: { agent: AgentIdentity | null; apiDir: string | null }) => string | null {
  const lines = new Map<AgentIdentity | string, string | null>()
  return ({ agent, apiDir }) => {
    const dir = !agent && apiDir && open.has(apiDir.toLowerCase()) ? apiDir : null
    const key = agent ?? `api:${dir?.toLowerCase() ?? ''}`
    if (!lines.has(key)) {
      const payload = inApiWorkspace(dir, () => inRequestScope(agent ? { projectPath: agent.projectPath, agentId: agent.agentId } : null, () => apiEventFor(event, agent)))
      lines.set(key, payload ? `event: ${event.type}\ndata: ${replyText(payload)}\n\n` : null)
    }
    return lines.get(key)!
  }
}

function broadcast(event: CombworkEvent): void {
  if (!sseClients.size || !(API_EVENTS as readonly string[]).includes(event.type)) return
  const lineFor = streamLines(event, new Set(openWorkspaces().map((w) => w.combworkDir.toLowerCase())))
  for (const [c, client] of sseClients) {
    const line = lineFor(client)
    if (line === null) continue
    // A client that stopped reading would make Combwork hold every event for it: it is disconnected instead.
    if (c.writableLength > SSE_MAX_BUFFERED) {
      sseClients.delete(c)
      c.destroy()
    } else {
      c.write(line)
      appMetrics.stream({ events: 1, bytes: Buffer.byteLength(line, 'utf8') })
    }
  }
}

/** How much an event-stream client may fall behind (bytes not yet sent) before it is disconnected. */
const SSE_MAX_BUFFERED = 1024 * 1024

/** The (re)start in progress: settings changed quickly twice restart the server one after the other. */
let apiRestart: Promise<unknown> = Promise.resolve()

/** The start whose listen is under way (tried again while its port is in use): stopApiServer aborts it. */
let apiListening: AbortController | null = null

/**
 * Starts (or restarts) the server. retryInUse: a port in use is tried again for a few seconds (listenRetry.ts) — start-up
 * passes it after an unexpected close (HI-2196), when the copy just ended may still hold its port; any other start, a
 * settings change's among them, fails at once as before.
 */
export function startApiServer({ retryInUse = false }: { retryInUse?: boolean } = {}): Promise<AgentApiInfo> {
  const run = apiRestart.then(() => startApiServerNow(retryInUse))
  apiRestart = run.catch(() => undefined)
  return run
}

async function startApiServerNow(retryInUse: boolean): Promise<AgentApiInfo> {
  await stopApiServer()
  apiError = undefined
  if (!apiToken) apiToken = await loadToken()
  await loadViewerTokens()
  const port = apiPort()
  const listening = new AbortController()
  apiListening = listening
  try {
    // Runs with the Agent API off too, for the Combwork Assistant's token alone (see handleApi).
    const got = await listenWithRetry(() => http.createServer((req, res) => void handleApi(req, res)), port, '127.0.0.1', {
      retry: retryInUse,
      signal: listening.signal,
      onWait: () => log.info(`Agent API: port ${port} is in use after an unexpected close; trying again for up to ${LISTEN_RETRY_BOUND_MS / 1000} s`)
    })
    // Stopped just as it listened: never the server of a start that was stopped.
    if (listening.signal.aborted) {
      got.server.close()
      return apiInfo()
    }
    apiServer = got.server
    log.info(`Agent API listening on 127.0.0.1:${port}${got.tries > 1 ? ` after ${got.tries} tries in ${got.waitedMs} ms` : ''}`)
  } catch (e) {
    // Stopped while it was being tried again: whatever stopped it has the server and the discovery file now.
    if ((e as Error).name === 'AbortError') return apiInfo()
    const tries = (e as { tries?: number }).tries ?? 1
    apiError = (e as NodeJS.ErrnoException).code === 'EADDRINUSE' ? say(API.http.portInUse, { port: String(port) }) : (e as Error).message
    log.warn(`Agent API failed to start: ${apiError}${tries > 1 ? ` (after ${tries} tries)` : ''}`)
    apiServer = null
  } finally {
    if (apiListening === listening) apiListening = null
  }
  // Another app finds a running Combwork's API by the discovery file (#620): there while the Agent API listens.
  const info = apiInfo()
  if (info.running && info.url) await writeDiscovery({ url: info.url, port: apiPort(), version: app.getVersion(), api: API_VERSION })
  else await clearDiscovery()
  return info
}

export async function stopApiServer(): Promise<void> {
  apiListening?.abort()
  apiListening = null
  for (const c of sseClients.keys()) c.end()
  sseClients.clear()
  if (apiServer) await new Promise<void>((resolve) => apiServer!.close(() => resolve()))
  apiServer = null
}

/** A new viewer token (Settings → Agent API → Viewer tokens). */
export async function createViewer(name: string): Promise<AgentApiInfo> {
  await createViewerToken(name)
  return apiInfo()
}

/** Revokes a viewer token: its requests are refused from now on, and its open event streams end. */
export async function revokeViewer(id: string): Promise<AgentApiInfo> {
  await revokeViewerToken(id)
  for (const [c, client] of sseClients) {
    if (client.viewer !== id) continue
    sseClients.delete(c)
    c.end()
  }
  return apiInfo()
}

/**
 * A project agent's launch whose token stopped working (it ended, or a new launch replaced it): its open event streams
 * end, as a revoked viewer's do (HI-2416); a new request with that token is refused (401). Only that launch's: the next
 * launch's streams, with its own token, stay open.
 */
function endLaunchStreams(ended: EndedLaunch): void {
  for (const [c, client] of sseClients) {
    const a = client.agent
    if (!a || client.run !== ended.runId || a.agentId !== ended.agentId || a.projectPath.toLowerCase() !== ended.projectPath.toLowerCase()) continue
    sseClients.delete(c)
    c.end()
  }
}

onCombworkEvent(broadcast)
onAgentTokenEnded(endLaunchStreams)
// A project agent's watch refused, under the watches' lock, while Combwork is giving it a card in a slot (HI-2197).
onWatchPlacing(watchWhilePlaced)

/** For unit tests: request parts whose refusals tests say through the canary (tests/agentTextApi.test.ts, HI-2436). */
/** A route's handler by its method and template (HI-2681: tests run a route's real errors through metrics.ts reasonOf). */
const routeHandler = (method: string, template: string): Handler | undefined => routes.find((r) => r.method === method && r.template === template)?.handler
/** Runs fn as a project agent's request (HI-2691: tests run its routes' real errors), as serveApi's caller scope does. */
const asAgent = <T>(workspacePath: string, projectPath: string, agentId: string, fn: () => T): T => callerStore.run({ kind: 'agent', runId: 'test', workspace: workspacePath, projectPath, agentId }, () => inRequestScope({ projectPath, agentId }, fn))
export const apiTextTestHooks = { notifyTarget, isolatedFor, lanePlacement, readUsageWatch, streamLines, routeHandler, asAgent, httpFrom }
