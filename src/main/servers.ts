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
import type { AgentApiInfo, AgentDef, AgentInfo, Connection, AssistantControl, AssistantUndoResult, LaneInfo, EffortLevel, HiveEvent, LiveSessionState, McpServerInfo, PermissionMode, ProgressRun, ProjectConfig, ProviderId, SkillInfo, TaskCard, TaskColumn, TaskPatch, TaskStartTarget, ToastLevel, ToastMessage, ToastTarget, WorkspaceConnections } from '../shared/types'
import { callsMade } from '../shared/activity'
import { DEFAULT_API_PORT, HIVE_DIR, projectAgents, stopAsksUser, transcriptWarnLimit } from '../shared/defaults'
import { PROVIDERS, agentProvider, isProviderEnabled, offeredModes, providerDescriptor, providerName } from '../shared/providers'
import type { SafeguardNote } from '../shared/safeguards'
import { agentChoosesMcp, agentGetsMcp, cleanMcpServers, serverOnIn } from '../shared/agentMcp'
import { publicReason, UNDO_FINAL, type ActivityAgent, type ActivityKind, type ActivityTarget } from '../shared/assistantActivity'
import { changeGroups, noteAgent, noteChange, recordedHere, recordingChanges } from './assistantChanges'
import { undoChanges, UndoNotFound } from './assistantUndo'
import { cardAgent, knownAgent } from './activityTargets'
import { routePattern } from './routePattern'
import { fallbackEfforts, modelGroups } from '../shared/models'
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
import type { HandoverAuthor } from '../shared/hiveGuidance'
import { cardRequests, modelInUse, newestComments, progressLabel, retryWaitsView, taskRow, withoutHistory, type CardRequest, type IntentDone, type ProjectRow, type SkillRow, type TaskBatch, type TaskChange, type TaskReorder, type TaskView, type AccountUsagePublic } from '../shared/toolReplies'
import * as assistant from './assistantControl'
import { STOP_ASK_MS } from './mcp/agentApiCall'
import { SettingRefused, applySetting, checkedValue, entryOf, projectOf, restartText, settingDetail, settingRows } from './settingsTools'
import { settingChangeTexts, settingPath, type SettingEntry, type SettingScope } from '../shared/settingsCatalog'
import { addAgent, updateAgent } from './projectAgents'
import { DOC_MAX, SHARED_PREFIX, readDoc } from './docSections'
import { docOutline, findHeading, sectionText, type DocHeading } from '../shared/docSections'
import { providerService } from './providerService'
import { config } from './config'
import { refusal, type Refusal } from '../shared/workflow/refusals'
import { testsGiven, type FocusedTest } from '../shared/workflow/focused'
import { askAssistant, AskRefused } from './assistantAsk'
import { agentWorkflowRole, isWorkflowRole, workflowPairs, type WorkflowRole } from '../shared/workflow/roles'
import { deleteEntry, JournalBusy, JournalError, readEntry, recall, updateEntry, writeEntry } from './journal'
import { journalSettingsOf, journalSuggestion } from './journalService'
import { recordBuild } from './buildFacts'
import { buildFactOf } from '../shared/buildFacts'
import type { JournalSettings } from '../shared/journal'
import { emit, onHiveEvent, toast } from './events'
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
import { LANE_BRIEF_MAX, laneCards, laneName, laneNumber, type LaneChange } from '../shared/lanes'
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
import { agentNowOf, cardStall, laneOrderView, stepWaitOf, type StallAgent } from './cardStall'
import { cancelMessages, leaveMessage, MESSAGE_MAX_CHARS } from './agentMessages'
import { ackDeliveries, ackThenRead, deliveriesOf, deliverNow, deliveryView, inboxSwitch, launchWith, NotGiven, readInbox } from './deliveries'
import { INBOX_SWITCHES, type InboxSwitch } from '../shared/inboxSwitches'
import { isDoorbell } from '../shared/doorbell'
import type { DeliverySender, InboxItem } from '../shared/deliveries'
import * as tasks from './tasks'
import { runCardIntent, type CardIntent, type CardRefIn } from './cardIntents'
import { armIntentWatch } from './intentWatch'
import { pauseQueue, queueCardChange, queueViews, resumeQueue } from './workflow/queueControls'
import type { QueuePublic, QueueView } from '../shared/workflow/queue'
import * as taskBatch from './taskBatch'
import { startTask } from './taskStart'
import { hiveSkills, listSkills, skillFiles, validSkillName } from './skills'
import { transcripts } from './transcripts'
import { contextWorkspace, inWorkspace, openWorkspaces, workspace, workspaceFor, workspaceOf, type WorkspaceService } from './workspace'
import { accountOnIn, connectionRef, connectionsFor, connectionsOn, usableConnections, workspaceAccounts, type ConnectionPatch } from '../shared/accounts'
import { accountById, addConnection, allAccounts, allConnections, connectionProblem, firstUsableAccount, getConnection, hiveAccounts, updateConnection } from './accounts'
import { workspaceNotesFile } from './workspaceNotes'
import { WORKSPACE_NOTES_PATH } from '../shared/workspaceNotes'
import { cardStages } from './boardStore'
import { cardFacts, cardKind, cardReviewSkip, factRow, forYouOfCards } from './workflow/cardWork'
import type { ForYouItem } from '../shared/workflow/workView'
import { bracketFinished, bracketFor, bracketResolved, bracketStarted, cardRunRevision, takeResolved, type Bracket, type Recorded } from './workflow/runChecks'
import { workflowSummary } from './workflow/optionsForm'
import { detect, platformIdOf } from './platform/registry'
import { revisionShort, type PlatformId, type ProjectPlatform } from '../shared/platform/descriptors'
import { ASK_ACTIONS, ASK_ACTIONS_MAX, CATEGORY_STAGE, LOOP_STEPS, type AskAction, type ForYouKind } from '../shared/workflow/facts'
import { lastCardRead, newDecisions, noteCardRead, noticeText } from './decisionNotices'
import { actorOf, recordDecisionsReceived } from './workflow/recorder'
import { workflowFor } from './workflow/service'
import { unsubmittedOf } from './unsubmitted'
import { apiOutcome, appMetrics, clock as metricsClock, knownRoute, metricsHandle, recordApi, recordCatalog, recordMcp, MCP_REPORT_LIMITS, type MetricsHandle } from './metrics'
import { metricsReport } from './metricsUsage'
import { apiLabel, beginWork, hookLabel } from './mainStalls'
import type { GuidanceSeries, MetricOutcome, MetricsPart, MetricsQuery, MetricsReport } from '../shared/metrics'
import { agentForToken, agentToken, agentTokenFile, type AgentIdentity } from './agentTokens'
import { API_EVENTS, apiEventFor, publicRun } from './apiEvents'
import { clearDiscovery, writeDiscovery } from './apiDiscovery'
import { createViewerToken, loadViewerTokens, revokeViewerToken, viewerForToken, viewerTokens } from './viewerTokens'
import { hookTokenMatches, refusedHookNote } from './hookTokens'
import { unusedWorktreeCounts } from './unusedWorktrees'
import { devConsole, hiveSourceId, sessionSourceId } from './devConsole'
import { consoleSources } from './devConsoleSources'
import { englishError, HiveError, shownError } from './hiveError'
import { CONSOLE_KINDS, hiveName, mayRead, type ConsoleEvent, type ConsoleKind, type ConsoleReader, type ConsoleSource } from '../shared/devConsole'
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
        reject(new HttpError(413, 'Request body too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    /** More of the reply's body, beside `error` (a conflict's current revision). */
    public extra?: Record<string, unknown>
  ) {
    super(message)
  }
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
// Hook server: receives the agents' CLI hooks. Random port; ?run=<runId> names the launch, whose own token it needs.
// ---------------------------------------------------------------------------

let hookServer: http.Server | null = null

export async function startHookServer(): Promise<string> {
  hookServer = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/hook')) return send(res, 404, { error: 'not found' })
    const query = new URL(req.url, 'http://127.0.0.1').searchParams
    const run = query.get('run')
    // Only the launch's own token, while it runs (#345).
    if (!hookTokenMatches(run, req.headers.authorization)) {
      // The developer console (#636): a hook refused (an ended launch's, or a wrong token), in every workspace watched.
      devConsole.capture(devConsole.capturedLike('hive:'), () => ({ kind: 'hook-server', name: 'refused', raw: { statusline: query.has('statusline'), run: !!run }, made: { status: 401 }, summary: `hook refused (${run ? "not this launch's token, or it has ended" : 'no launch named'})` }))
      // In the log too, once a run (#711): a hook the CLI sent but Hive refused leaves a trace on Hive's side.
      const note = refusedHookNote(run)
      if (note) log.info(note)
      return send(res, 401, { error: 'unauthorized' })
    }
    // Tests lose every hook while the file HIVE_TEST_DROP_HOOKS names is there (#1371: a CLI whose hooks Hive can't
    // stop at its end, Copilot), answered as if Hive had taken them; unpackaged builds only.
    const drop = !app.isPackaged ? process.env.HIVE_TEST_DROP_HOOKS : undefined
    if (drop && existsSync(drop)) {
      await readBody(req).catch(() => '')
      return send(res, 200, {})
    }
    let done: (() => void) | null = null
    // What Hive observes of it, for the launch's Hooks dialog (HI-982): from here, on its own authenticated route, so
    // a body Hive can't read is recorded too.
    let obs: HookObservation | null = null
    let step = 'read'
    try {
      const raw = await readBody(req)
      let body: Record<string, any>
      try {
        body = JSON.parse(raw || '{}')
      } catch (e) {
        obs = query.has('statusline') ? null : sessions.observeHook(run, {})
        throw e
      }
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
      // A hook about to edit files waits for Hive's file-lock decision (made at once, in the order hooks came); a tool's
      // end and a Stop that may carry a notice wait for their place in the launch's hook order, where the turn ledger
      // decides whose turn they are (#650: a notice of what is unread, or the drain carrying the turn on); other hooks
      // are answered at once so they never slow the agent down. Each is handled in the launch's order from when it came,
      // with its reply: the turn ledger learns what the Stop was told (#648).
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
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(answer ?? {}))
      await handled
      if (obs) sessions.hookHandled(obs, answer, failed)
      obs = null
    } catch (e) {
      log.warn('hook error', e)
      if (obs) sessions.hookHandled(obs, null, { step, error: e })
      if (!res.headersSent) send(res, 400, { error: 'bad request' })
    } finally {
      done?.()
    }
  })
  await new Promise<void>((resolve) => hookServer!.listen(0, '127.0.0.1', resolve))
  const addr = hookServer.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  sessions.hookUrl = `http://127.0.0.1:${port}/hook`
  log.info(`Hook server listening on ${sessions.hookUrl}`)
  return sessions.hookUrl
}

// ---------------------------------------------------------------------------
// Agent API: documented REST API for agents and scripts. See docs/AGENT_API.md.
// ---------------------------------------------------------------------------

let apiServer: http.Server | null = null
let apiToken = ''

/**
 * Who made a request: a caller with the Agent API's token (agents' hive tools, scripts), which Settings → Agent
 * API governs, or a workspace's Hive Assistant with its own token, which Settings → Assistant → Control governs.
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
/** Event-stream clients: the project agent each is (null: a script or a viewer, which gets every event), and the viewer token it came with. */
const sseClients = new Map<ServerResponse, { agent: AgentIdentity | null; viewer: string | null }>()

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
  /** The request's workspace, as far as it was known (the developer console's Hive events). */
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
  await writeJsonAtomic(tokenFile(), { token: apiToken, note: 'Bearer token for the Hive Agent API. Regenerate it in Settings → Agent API.' })
  return apiToken
}

/** HIVE_API_PORT overrides the setting; development builds default to the next port so they don't clash with the installed app. */
function apiPort(): number {
  const env = Number(process.env.HIVE_API_PORT)
  if (env > 0) return env
  const port = config.settings.agentApi.port
  return !app.isPackaged && port === DEFAULT_API_PORT ? port + 1 : port
}

export function apiInfo(): AgentApiInfo {
  const s = config.settings.agentApi
  // With the Agent API off, the server still runs for the Hive Assistant alone.
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

/** The server's address for the Hive Assistant, which reaches it whether or not the Agent API is turned on. */
export function assistantApiUrl(): string | null {
  return apiServer?.listening ? `http://127.0.0.1:${apiPort()}` : null
}

/**
 * Environment passed to an agent's session so it (and its hive tools) can reach the API: the file holding the agent's
 * own token for this launch (agentTokens.ts), never the workspace's, so the API knows which project's agent is calling.
 * Never the token itself (HI-2262, Darren's decision): an agent listing its environment printed it (HI-2259).
 */
export function apiEnv(projectPath: string, agentId: string): Record<string, string> {
  const info = apiInfo()
  const token = agentToken(projectPath, agentId)
  if (!info.running || !info.url || !token) return {}
  // How long hive-progress waits for the API's answers (HI-1892: Settings → Advanced, its reply time).
  return { HIVE_API_URL: info.url, HIVE_API_TOKEN_FILE: agentTokenFile(projectPath, agentId),HIVE_PROGRESS_REPLY_SECONDS: String(advanced.number('hive.progress.replySeconds')) }
}

/** An open workspace by its folder path or its name. A name two open workspaces share is refused (409): use the path. */
export function findWorkspace(want: string): WorkspaceService | null {
  const v = want.toLowerCase()
  // By path, the same place by any other name: a junction, an 8.3 short name (#494).
  const at = /[\\/]/.test(want) ? placeMatcher(resolvePath(want)) : null
  const hits = openWorkspaces().filter((w) => (at ? at(w.path!) : basename(w.path!).toLowerCase() === v))
  if (hits.length > 1) {
    throw new HttpError(409, `Several open workspaces are named "${want}" (${hits.map((w) => w.path).join(', ')}): say which by its full path in the X-Hive-Workspace header or ?workspace=`)
  }
  return hits[0] ?? null
}

/** The workspace a request names (X-Hive-Workspace header, or ?workspace=), else the only open one. */
function requestWorkspace(req: IncomingMessage, url: URL): WorkspaceService | null {
  const own = assistantCaller()
  if (own) {
    const w = openWorkspaces().find((x) => x.path!.toLowerCase() === own)
    if (!w) throw new HttpError(409, "The Assistant's workspace isn't open in Hive")
    return w
  }
  // An agent's calls are about its own workspace, whatever the request names.
  const agent = agentCaller()
  if (agent) {
    const w = openWorkspaces().find((x) => x.path!.toLowerCase() === agent.workspace.toLowerCase())
    if (!w) throw new HttpError(409, "The agent's workspace isn't open in Hive")
    return w
  }
  const header = req.headers['x-hive-workspace']
  const raw = typeof header === 'string' && header ? decodeURIComponent(header) : url.searchParams.get('workspace')
  if (raw) {
    const w = findWorkspace(raw)
    if (!w) throw new HttpError(404, `Unknown workspace "${raw}": it isn't open in Hive`)
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
  if (!openWorkspaces().length) throw new HttpError(409, 'No workspace is open')
  throw new HttpError(400, 'Several workspaces are open in Hive: say which with ?workspace=<name> or the X-Hive-Workspace header')
}

/**
 * A project by name: "<project>" in the request's workspace (or, with none named, in whichever open
 * workspace has it: 409 if several do), or "<workspace>/<project>" (encoded as %2F in a URL path).
 */
function projectByName(name: string): string {
  const raw = decodeURIComponent(name)
  if (!openWorkspaces().length) throw new HttpError(409, 'No workspace is open')
  const slash = raw.search(/[\\/]/)
  let project = raw
  let candidates: WorkspaceService[]
  if (slash > 0) {
    const w = findWorkspace(raw.slice(0, slash))
    if (!w) throw new HttpError(404, `Unknown workspace "${raw.slice(0, slash)}": it isn't open in Hive`)
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
  if (!hits.length) throw new HttpError(404, `Unknown project "${raw}"`)
  if (hits.length > 1) throw new HttpError(409, `"${project}" is a project in several open workspaces: name it as <workspace>/<project>, e.g. ${basename(dirname(hits[0]))}/${project}`)
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
 * An agent's status message: a watching agent's is what it waits for; one whose state is unknown says so (#648), as
 * does one whose hooks aren't reaching Hive (#1336) and one whose CLI waits to retry its model request (HI-1972).
 */
const statusMessageOf = (live: LiveSessionState | null | undefined): string | null =>
  live?.hooksMissing
    ? `${hooksMissingText(live)}: its CLI's hooks aren't reaching Hive, so its status may be wrong and it isn't given work; the user can restart its session`
    : live?.status === 'watching'
    ? (live.watch?.label ?? null)
    : live?.status === 'signin'
      ? `Its CLI's sign-in has expired: the user must sign in again (${live.signIn?.message ?? 'not signed in'})`
      : retryWaitText(live)
        ? `${retryWaitText(live)}: its CLI is waiting to retry its model request and carries on by itself; it isn't given work meanwhile`
        : unknownStateText(live)
          ? `${unknownStateText(live)}: Hive has heard nothing of its turn and seen no sign of its end, so it isn't given work; the user can mark it idle`
          : (live?.statusMessage ?? live?.mergeSlot ?? null)

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
      // The project's MCP servers it gets (the built-in hive server besides): all of them, or only those it was given.
      mcpServers: mcpOn.filter((n) => agentGetsMcp(a, n)),
      mcpChoice: agentChoosesMcp(a) ? 'only' : 'all',
      // The guidance and skill revisions it launched with (compare with GET /v1/status's to spot an old launch).
      launched: a.live?.launched ?? null,
      // Its connection (HI-1771, for a CLI with connections): the one chosen (null: the default), the one its run is on, and a switch waiting.
      ...agentConnectionFields(p, a, a.live?.provider ?? agentProvider(a, config.settings))
    })),
    // Its builder and reviewer pairs (#1531): its running lanes', then by name; empty without either.
    pairs: workflowPairs(info.agents, await lanes.listLanes(workspaceOf(p), { project: basename(p) }).catch(() => [])),
    // The workspace's MCP servers (HI-2059): all available to the project, those added to it running; `on` is `added`'s
    // old name, kept for 1.0 (deprecated).
    mcp: { available: servers.filter((m) => m.def).map((m) => m.name), added: mcpOn, on: mcpOn },
    // Its version control, what Hive finds in its folder now, and the switch it offers when they differ (#1419): never
    // switched silently; the user switches it (the Assistant within Control: project.workflow.platform).
    ...(info.platform ? { versionControl: versionControlOf(info.platform) } : {}),
    // The workflow options in force (#1278), and which the project, the workspace or Hive's settings set.
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
  const found = d.other ? `${d.other} (not supported: None)` : d.platform === 'git' ? `git at ${d.root ?? ''}${d.subfolder ? ' (a subfolder of that repository)' : ''}` : 'none' // i18n-ignore: agent-facing (English)
  return { platform: p.id, found, ...(p.offer ? { offers: p.offer.offer, why: p.offer.why } : {}) }
}

/** The agent an API call is for: an agent id or name, else the project's only agent (400 with several, 409 with none). */
async function agentParam(p: string, value: unknown): Promise<string> {
  if (typeof value !== 'string' || !value) {
    const agents = projectAgents(await workspace.projectConfig(p))
    if (agents.length === 1) return agents[0].id
    throw agents.length ? new HttpError(400, 'This project has several agents: say which one with "agent" (its id or name)') : new HttpError(409, 'This project has no agents yet')
  }
  const a = projectAgents(await workspace.projectConfig(p)).find((x) => x.id === value || x.name.toLowerCase() === value.toLowerCase())
  if (!a) throw new HttpError(404, `Unknown agent "${value}"`)
  return a.id
}

/** `signal` aborts when the client goes away before its reply (a long wait it no longer waits for). */
type Handler = (ctx: { params: string[]; query: URLSearchParams; body: any; signal: AbortSignal }) => Promise<unknown>


/** The status a refusal answers with (an HttpError's, the change boundary's, a setting's), for its public reason (#763). */
const statusOf = (e: unknown): number => (e instanceof assistant.ChangeRefused || e instanceof SettingRefused || e instanceof lanes.LaneError ? e.status : errorStatus(e))

/** A refusal of the Assistant's change boundary, or of a batch's request, as the Agent API answers it. */
const httpOf = (e: unknown): unknown => (e instanceof assistant.ChangeRefused ? new HttpError(e.status, e.message, e.extra) : e)

async function asRefused<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    throw httpOf(e)
  }
}

/**
 * A change the Hive Assistant asks for: admitted by the Assistant's change boundary (control level, limit), run, and
 * recorded (its panel's list and hive.log) with `act`, its kind and targets (#763), and what `fn` adds to them once
 * known (`act`: a new card's number, a new agent). `fn` gets the boundary's guard, to run again as each write is made.
 * Other callers can't make these changes through the API.
 */
async function assistantChange<T>(need: AssistantControl, what: string, act: ActivityTarget, fn: (guard: () => void) => Promise<{ done: string; said?: string; brief?: string; act?: Partial<ActivityTarget>; result: T } & UndoNotes>): Promise<T> {
  const ws = assistantCaller()
  if (!ws) throw new HttpError(403, `Only the Hive Assistant can ${what} through the Agent API.`)
  const line = what.charAt(0).toUpperCase() + what.slice(1)
  const guard = await asRefused(async () => assistant.admit(ws, assistantCallerToken() ?? '', need, what, act))
  try {
    // `said`: what the line quotes (a prompt, a message), which the Agent API's event stream leaves out.
    // `brief`: the line in Hive's own words when `done` carries an error's text (#763: the stream never does).
    // Recorded for undo as it is made (#1282): a card's fields as the card is saved, the rest here once it is done.
    const { done, said, brief, act: more, result } = await recordingChanges(ws, act.kind, what, async () => {
      const out = await fn(guard)
      await noteDone(requireWorkspace(), { ...act, ...out.act }, out)
      return out
    })
    const pub = brief ?? (said ? done : undefined)
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
function assistantMay(need: AssistantControl, what: string, act: ActivityTarget): void {
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
export const API_VERSION = 12

/** Who Hive takes a request's caller for, and what it may reach (GET /v1/status). */
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
 * The request's workspace's Hive skills (null without one), read once its open has brought them up to date, as a launch
 * reads them (HI-1781: during the update after an open, a list half copied).
 */
async function hiveSkillsNow(): Promise<Awaited<ReturnType<typeof skillRevisions>> | null> {
  const ws = contextWorkspace()
  if (!ws) return null
  await ws.itemsUpToDate()
  return inWorkspace(ws, () => skillRevisions())
}

route('GET', '/v1/status', async () => ({
  app: { name: 'Hive', version: app.getVersion() },
  api: { version: API_VERSION },
  caller: await callerInfo(),
  // The guidance this Hive gives sessions, and the request's workspace's Hive skills (null without one).
  guidance: { revision: GUIDANCE_REVISION, skills: await hiveSkillsNow() },
  providers: providerService.all(),
  /** The request's workspace (or the only open one); `workspaces` lists every window's. */
  workspace: contextWorkspace()?.path ? { name: basename(contextWorkspace()!.path!), path: contextWorkspace()!.path } : null,
  workspaces: openWorkspaces().map((w) => ({ name: basename(w.path!), path: w.path })),
  // The Hive Assistant belongs to its workspace, not a project; it sees its own workspace's sessions only.
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
  return { name: s.name, workspace: s.workspace, active: s.active, branch: s.branch, agents: s.agents.map((a) => ({ name: a.name, provider: a.provider, workflowRole: a.workflowRole, status: a.status, branch: a.branch, backgroundTasks: a.backgroundTasks, ...(a.watching ? { watching: a.watching.label } : {}), ...(a.progress ? { progress: progressLabel(a.progress) } : {}) })) }
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

route('POST', '/v1/projects/:name/activate', async ({ params }) => {
  const p = projectByName(params[0])
  if (assistantCaller()) {
    return assistantChange('agents', `activate the project ${basename(p)}`, { kind: 'activate-project', project: basename(p) }, async () => {
      workspace.setActive(p, true)
      await workspaceOf(p).refresh()
      return { done: `Activated ${basename(p)}`, result: await projectSummary(p) }
    })
  }
  workspace.setActive(p, true)
  await workspaceOf(p).refresh()
  return projectSummary(p)
})

route('POST', '/v1/projects/:name/deactivate', async ({ params }) => {
  const p = projectByName(params[0])
  assistantMay('agents', `deactivate the project ${basename(p)}`, { kind: 'deactivate-project', project: basename(p) })
  if (sessions.liveFor(p)) throw new HttpError(409, 'Stop the running session before deactivating the project')
  workspace.setActive(p, false)
  await workspaceOf(p).refresh()
  return projectSummary(p)
})

/**
 * A project agent (by its own token) looks into and types into only its own project's agents: another project's
 * conversations can hold that project's cards (a card started on an agent is its prompt), which are not its to see.
 * Status stays open to it (projects, project status, waiting for agents); the Assistant and scripts see everything.
 */
function ownProjectOnly(p: string, what: string): void {
  const a = agentCaller()
  if (a && resolvePath(a.projectPath).toLowerCase() !== resolvePath(p).toLowerCase()) {
    throw new HttpError(403, `${what} is only for your own project's agents (${basename(a.projectPath)}). Another project's work is for its own agents, the Hive Assistant and the user.`)
  }
}

route('GET', '/v1/projects/:name/sessions', async ({ params }) => {
  const p = projectByName(params[0])
  ownProjectOnly(p, "Reading an agent's sessions")
  return sessions.list(p)
})

route('POST', '/v1/projects/:name/sessions', async ({ params, body }) => {
  const p = projectByName(params[0])
  if (assistantCaller()) throw new HttpError(400, 'Use hive_start_agent (POST /v1/projects/{name}/agents/{agent}/start) to start agents.')
  return sessions.start(p, { resumeId: body?.resumeId, name: body?.name, agentId: await agentParam(p, body?.agent) })
})

route('POST', '/v1/projects/:name/stop', async ({ params, query, body }) => {
  const p = projectByName(params[0])
  if (assistantCaller()) throw new HttpError(400, 'Use hive_stop_agent (POST /v1/projects/{name}/agents/{agent}/stop) to stop agents.')
  const agent = query.get('agent') ?? body?.agent
  // Its cause from the caller's token (HI-1881): an agent's; a script's or another caller's unknown, just "stopped".
  sessions.stop(p, agent ? await agentParam(p, agent) : undefined, agentCaller() ? 'agent' : undefined)
  return { ok: true }
})

route('GET', '/v1/projects/:name/usage', async ({ params, query }) => {
  const p = projectByName(params[0])
  const agent = query.get('agent')
  const id = query.get('sessionId') ?? sessions.liveFor(p, agent ? await agentParam(p, agent) : undefined)?.sessionId ??(await sessions.list(p)).find((s) => s.source === 'hive')?.id
  if (!id) throw new HttpError(404, 'No sessions for this project')
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
  if (assistantCaller()) throw new HttpError(400, 'Use hive_prompt_agent (POST /v1/projects/{name}/agents/{agent}/prompt) to give agents work.')
  if (!config.settings.agentApi.allowSessionInput) throw new HttpError(403, 'Session input is disabled. Enable it in Settings → Agent API.')
  const p = projectByName(params[0])
  ownProjectOnly(p, 'Typing into an agent')
  const agentId = await agentParam(p, body?.agent)
  if (!sessions.liveFor(p, agentId)) throw new HttpError(409, 'That agent is not running')
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
  if (!own && !config.settings.agentApi.allowSessionInput) throw new HttpError(403, 'Session input is disabled. Enable it in Settings → Agent API.')
  const p = projectByName(params[0])
  const from = await agentParam(p, body?.from)
  if (typeof body?.to !== 'string' || !body.to) throw new HttpError(400, 'to is required')
  const to = await agentParam(p, body.to)
  const handover = body?.handover !== false
  // Known at once rather than later in a notification: from the latest handover, there has to be one.
  if (!handover && !(await sessions.latestHandover(p))) throw new HttpError(409, `There is no handover for ${basename(p)} yet. Hand over with a new handover (handover: true) instead.`)
  const names = projectAgents(await workspace.projectConfig(p))
  const name = (id: string): string => names.find((a) => a.id === id)?.name ?? id
  // To itself it ends its conversation (#1057): not while it works, merges or is on a running card loop's card.
  if (from === to && !(await sessions.handOverAllowed(p, from))) throw new HttpError(409, `${name(from)} is working, merging or on a card loop's card: its conversation isn't ended now. Hand it over when it has finished.`)
  const act: ActivityTarget = { kind: 'hand-over', project: basename(p), agent: { id: from, name: name(from) }, toAgent: { id: to, name: name(to) } }
  const start = async (): Promise<void> => {
    // It can take minutes (the handover is written first): answer now, report failures in Hive.
    void sessions.handOver(p, from, to, { handover }).catch((e) => {
      handOverFailedToast(p, name(to), e)
      if (own) assistant.record(own, act, `Hand over in ${basename(p)}`, (e as Error).message, { reason: publicReason(undefined) })
    })
  }
  if (!own) {
    await start()
    return { ok: true }
  }
  return assistantChange('agents', `hand ${name(from)}'s work over to ${name(to)} in ${basename(p)}`, act, async () => {
    // Known at once rather than minutes later: without Hive's tools agents can't write or read a handover.
    if (!sessions.hiveMcp(p)) throw new HttpError(409, "The project's agents don't have Hive's tools (Settings → Agent API is off, or Provide Hive tools to sessions), so they can't write or read a handover. Tell the user.")
    for (const id of [from, to]) {
      if (sessions.userMayBeTyping(p, id)) throw new HttpError(409, `The user has just typed in ${name(id)}'s terminal and may still be writing there. Ask the user before handing over.`)
    }
    await start()
    return {
      done: `Handing ${name(from)}'s work over to ${name(to)} in ${basename(p)}${handover ? '' : ' (from the latest handover)'}`,
      result: { ok: true, note: `Hive ${handover ? `asks ${name(from)} for a handover, waits until it exists, then ` : ''}starts ${name(to)} on it. Use hive_wait_for_agents to follow; problems show as notifications and in your actions.` }
    }
  })
})

// ---------------------------------------------------------------------------
// Agents and projects for the Hive Assistant (Settings → Assistant → Control). Reading is open to every caller.
// ---------------------------------------------------------------------------

/** The providers agents can run: whether each is on and installed, and its models, effort levels and modes. */
route('GET', '/v1/providers', async () => {
  // Installed or not is only known once Hive has looked for the CLIs (#506).
  await providerService.detected()
  const s = config.settings
  const here = contextWorkspace()
  return PROVIDERS.map((p) => {
    const info = providerService.info(p.id)
    return {
      id: p.id,
      name: p.name,
      enabled: isProviderEnabled(s, p.id),
      installed: info.found,
      version: info.version,
      // The version this Hive release was tested with, and how the installed one compares (#365).
      tested: info.tested ? { version: info.tested.version, installed: info.found ? info.tested.installed : 'not installed' } : null,
      problem: info.readiness?.find((r) => r.level === 'error')?.message ?? null,
      defaultModel: info.defaultModel ?? null,
      // What the pickers offer: the CLI's own models, else the fallback list in Settings (#125).
      models: modelGroups(p.id, info, s).filter((g) => !g.unavailable).flatMap((g) => g.models.map((m) => ({ value: m.value, label: m.label }))),
      efforts: fallbackEfforts(p.id, s),
      // Whether agents can be given context200k (a 200K window instead of the model's 1M).
      context200k: p.capabilities.contextLimit,
      modes: offeredModes(p.id, s).map((m) => ({ value: m.value, label: m.label, description: m.description })),
      // Its connections usable in the caller's workspace (HI-2108), in the order: what hive_add_agent's connection names.
      ...(here ? { connections: connectionsHere(here).filter((c) => accountById(c.account)?.provider === p.id).map((c) => ({ id: c.id, name: c.name })) } : {})
    }
  })
})

// --- Hive's settings (#186): anyone with a token reads them (the settings catalog's entries with their values); only
// the Hive Assistant changes them, with Settings → Assistant → Control → Change settings on, and never a sensitive one.
const SETTING_SCOPES: readonly SettingScope[] = ['app', 'provider', 'workspace', 'project']

/** A settings call's project, by name (null without one). */
const settingsProject = (name: unknown): string | null => (typeof name === 'string' && name.trim() ? projectByName(name.trim()) : null)

/** Runs a settings call, turning what settingsTools refuses into the API's answer. */
async function settingsCall<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    throw e instanceof SettingRefused ? new HttpError(e.status, e.message) : e
  }
}

route('GET', '/v1/settings', ({ query }) =>
  settingsCall(async () => {
    const scope = query.get('scope') || undefined
    if (scope && !SETTING_SCOPES.includes(scope as SettingScope)) throw new HttpError(400, `scope is one of ${SETTING_SCOPES.join(', ')}.`)
    const p = settingsProject(query.get('project'))
    if (scope === 'project' && !p) throw new HttpError(400, "A project's settings need its name: project=<name>.")
    return settingRows({ query: query.get('query') ?? '', scope: scope as SettingScope | undefined, project: await projectOf(p) })
  })
)

route('GET', '/v1/settings/:id', ({ params, query }) => settingsCall(async () => settingDetail(entryOf(decodeURIComponent(params[0])), await projectOf(settingsProject(query.get('project'))))))

route('PATCH', '/v1/settings/:id', ({ params, body }) =>
  settingsCall(async () => {
    const e = entryOf(decodeURIComponent(params[0]))
    const p = settingsProject(body?.project)
    if (e.scope === 'project' && !p) throw new HttpError(400, `${e.id} is a project's setting: say which project.`)
    return settingsChange(e, body?.value, e.scope === 'project' ? p : null)
  })
)

/**
 * A setting the Hive Assistant changes: only with Change settings on, never a sensitive one (its own Control included),
 * and listed in its panel with old → new for Revert. Other callers can't.
 */
async function settingsChange(e: SettingEntry, value: unknown, projectPath: string | null) {
  const path = settingPath(e)
  const where = projectPath ? ` in ${basename(projectPath)}` : ''
  const ws = assistantCaller()
  if (!ws) throw new HttpError(403, `Only the Hive Assistant can change Hive's settings through the Agent API: the user changes them in ${path}.`)
  const line = `Change ${path}${where}`
  // Which setting, never its value (#763).
  const act: ActivityTarget = { kind: 'setting', settingId: e.id, ...(projectPath ? { project: basename(projectPath) } : {}) }
  if (config.settings.assistant?.changeSettings !== true) {
    assistant.record(ws, act, line, 'not allowed: Settings → Assistant → Control → Change settings is off', { reason: 'Not allowed: Settings → Assistant → Control → Change settings is off' })
    throw new HttpError(403, `The user's settings don't let you change settings (Settings → Assistant → Control → Change settings is off). Tell the user how to change it in ${path}, or that turning Change settings on lets you.`)
  }
  if (e.sensitive) {
    assistant.record(ws, act, line, 'only the user can change it', { reason: 'Only the user can change it' })
    throw new HttpError(403, `${e.readOnly} Tell the user how, instead.`)
  }
  // Checked before the change: a value it can't take is the Assistant's to fix.
  await settingsCall(() => checkedValue(e, value, projectPath))
  // Asked again at the moment of the change (a project's under its lock, after any wait for it): Change settings may have
  // been turned off, or the Assistant stopped, meanwhile.
  // The same session, too: one started since (a restart) mustn't carry out this one's pending change.
  const token = assistantCallerToken() ?? ''
  const stillAllowed = (): void => {
    if (config.settings.assistant?.changeSettings !== true) throw new SettingRefused(403, `Settings → Assistant → Control → Change settings was turned off before the change was made: nothing changed. Tell the user how to change ${path} themselves.`)
    if (!assistant.isCurrentToken(ws, token)) throw new SettingRefused(409, "The Assistant's session that asked for this ended before the change was made: nothing changed.")
  }
  try {
    // The value as sent (applySetting checks it again): a provider's prices take null, Hive's own, as more than {}.
    const r = await applySetting(e, value, projectPath, stillAllowed)
    // What changed, as the list and the reply show it: a table's changed entries, not its size.
    const { oldText, newText } = settingChangeTexts(e, r.old, r.new, r.removed)
    const changed = JSON.stringify(r.old) !== JSON.stringify(r.new) || !!r.removed
    if (changed) {
      // The event stream says which setting, not its values (`brief`).
      assistant.record(ws, act, `Changed ${path}${where}: ${oldText} → ${newText}`, undefined, { brief: `Changed ${path}${where}`, setting: { id: e.id, ...(projectPath ? { project: projectPath } : {}), path, old: r.old, new: r.new, ...(r.removed ? { removed: r.removed } : {}), oldText, newText } })
      // For undo (#1282): its value (and a provider's removed models) as it was and as set.
      const fields = [{ field: 'value', old: r.old, new: r.new }, ...(r.removed ? [{ field: 'removed', old: r.removed.old, new: r.removed.new }] : [])]
      await recordingChanges(ws, 'setting', `change ${path}${where}`, () => noteChange(requireWorkspace(), { kind: 'setting', project: projectPath ? basename(projectPath) : null, target: e.id, fields }))
    }
    const restart = restartText(e)
    return { id: e.id, title: e.title, path, ...(projectPath ? { project: basename(projectPath) } : {}), changed, old: oldText, new: newText, ...(restart ? { restart } : {}), ...(r.note ? { note: r.note } : {}) }
  } catch (err) {
    assistant.record(ws, act, line, (err as Error).message, { reason: publicReason(statusOf(err)) })
    throw err instanceof SettingRefused ? new HttpError(err.status, err.message) : err
  }
}

/** How many of its messages' changes the Assistant's list gives (its newest; GET /v1/assistant/changes). */
const CHANGE_GROUPS_LISTED = 10

/**
 * The Assistant's own changes, kept for undo (#1282, SPEC §16.14): its newest messages' groups, each change with its id,
 * its line, its card, the fields it set, whether it was undone, and why one can't be (`final`). Only the Assistant's.
 */
route('GET', '/v1/assistant/changes', async () => {
  if (!assistantCaller()) throw new HttpError(403, 'Only the Hive Assistant has changes to undo: they are its own.')
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
  if (!change === !group) throw new HttpError(400, 'Name one change (change: its id) or one message\'s changes (group: its id, or "latest").')
  if (group === 'latest') {
    group = changeGroups(ws).find((g) => g.changes.some((c) => !c.undoneAt && !c.final))?.id
    if (!group) throw new HttpError(404, 'None of your changes of the last 7 days is left to undo.')
  }
  return assistantChange('agents', change ? `undo a change of yours` : `undo your changes for a message`, { kind: 'undo' }, async (guard) => {
    let results: AssistantUndoResult[]
    try {
      // Its control level and its launch, checked again at each change's write (#1282 round 1): turned down or ended
      // meanwhile, the rest isn't undone.
      results = await undoChanges(ws, change ? { change } : { group }, 'assistant', guard)
    } catch (e) {
      throw e instanceof UndoNotFound ? new HttpError(404, e.message) : e
    }
    const undone = results.filter((r) => r.undone.length).length
    const skipped = results.reduce((n, r) => n + r.skipped.length, 0)
    const cards = [...new Set(results.flatMap((r) => (r.card !== undefined ? [r.card] : [])))]
    return { done: `Undid ${undone} of ${results.length} change${results.length === 1 ? '' : 's'} of its own${skipped ? ` (${skipped} field${skipped === 1 ? '' : 's'} left: changed since or gone)` : ''}`, act: cards.length === 1 ? { card: cards[0] } : cards.length ? { cards } : {}, result: { results } }
  })
})

route('POST', '/v1/projects', async ({ body }) => {
  const name = String(body?.name ?? '').trim()
  if (!name) throw new HttpError(400, 'name is required')
  return assistantChange('projects', `create the project "${name}"`, { kind: 'create-project', project: name }, async () => {
    await workspace.createProject(name)
    const p = join(workspace.path!, name)
    workspace.setActive(p, true)
    await workspace.refresh()
    return { done: `Created the project ${name}`, result: await projectSummary(p) }
  })
})

const busy = (s: LiveSessionState | null): boolean => !!s && (s.status === 'working' || s.status === 'waiting' || s.status === 'starting' || s.status === 'background' || s.status === 'signin')
const STATUS_WORDS: Record<string, string> = {
  working: 'working',
  waiting: 'waiting for the user',
  signin: 'waiting for the user to sign in to its CLI again (its sign-in expired)',
  starting: 'starting',
  background: 'waiting on background tasks it started',
  watching: 'waiting for cards to change (a card watch: its card loop pauses until it is resumed)',
  ready: 'idle',
  finished: 'idle (finished its task)',
  error: 'in error',
  stopped: 'stopped'
}
const tasksWord = (n: number): string => `${n} background task${n === 1 ? '' : 's'}`
const clip = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n)}…` : t)

async function agentDefOf(p: string, agentId: string) {
  const a = projectAgents(await workspace.projectConfig(p)).find((x) => x.id === agentId)
  if (!a) throw new HttpError(404, 'Unknown agent')
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
    throw new HttpError(400, `${(e as Error).message} mcpServers is a list of the project's server names, [] for none, or ["*"] for all of them.`)
  }
}

/** A workspace's connections per CLI, as they apply (dropping ids gone or another CLI's). */
function workspaceConnections(ws: WorkspaceService): Partial<Record<ProviderId, WorkspaceConnections>> {
  const all = hiveAccounts()
  return Object.fromEntries(PROVIDERS.flatMap((x) => (x.capabilities.connections ? [[x.id, workspaceAccounts(ws.config, x.id, all) ?? { on: [], default: null }]] : [])))
}

/** The connections usable in a workspace (HI-2108), in the order: what an agent's `connection` may name there. */
const connectionsHere = (ws: WorkspaceService): Connection[] => usableConnections(ws.config, allAccounts(), allConnections())

/** A connection's values as the Agent API shows them (HI-2108): only those set (each absent: the CLI decides); its extra arguments to `wide` callers only. */
function connectionValues(c: Connection, wide: boolean): Record<string, unknown> {
  return { ...(c.model ? { model: c.model } : {}), ...(c.effort ? { effort: c.effort } : {}), ...(c.use200kContext ? { context200k: true } : {}), ...(c.permissionMode ? { mode: c.permissionMode } : {}), ...(wide && c.extraArgs ? { extraArgs: c.extraArgs } : {}) }
}

/** A connection as the Agent API lists it (HI-2108): its id, name, account (its name and CLI), its values, and `usable: false` where it can't be used here. */
function connectionRow(c: Connection, usable: boolean, wide: boolean): Record<string, unknown> {
  const a = accountById(c.account)
  return { id: c.id, name: c.name, account: a?.name ?? c.account, cli: a?.provider ?? null, ...connectionValues(c, wide), ...(usable ? {} : { usable: false }) }
}

/** An account's connections by name, for a refusal (HI-2108): "On Personal: Personal, Personal · High." */
function connectionNamesOn(accountId: string | undefined): string {
  const a = accountById(accountId)
  if (!a) return 'No account is on in this workspace: the user adds one in Settings → Accounts & Connections.'
  return `On ${a.name}: ${connectionsOn(a.id, allConnections()).map((c) => c.name).join(', ')}.`
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
  throw new HttpError(400, `An agent no longer takes ${old.join(', ')}: it runs on a connection, which holds its model, effort, context and mode, and its CLI follows from it. Pass connection (its id or name). ${connectionNamesOn(account)} hive_connection lists every one, and makes one when the user agrees.`)
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
  if (!r.ok) throw r.why === 'ambiguous' ? new HttpError(409, `Several connections are named "${v}": use its id (${r.ids!.join(', ')}).`) : new HttpError(404, `No connection named "${v}" is usable in this workspace, and none has that id. hive_connection lists them.`)
  return { connection: r.id, cli: accountById(getConnection(r.id)?.account)?.provider }
}

/**
 * An agent row's connection fields (HI-2108): `connection`, the one chosen as saved (its id, its name, and `problem`
 * when it can't be used here: removed, or its account off here, so it runs on its CLI's first usable one), or null for
 * none; `launchedConnection`, the account its run is on; `switchPending`. A project agent is never told the name of one
 * that can't be used in its workspace.
 */
function agentConnectionFields(p: string, a: AgentInfo, cli: ProviderId): Record<string, unknown> {
  const c = getConnection(a.connection)
  const problem = a.connection ? (c ? connectionProblem(c.account, cli, p) : 'missing') : null
  const shown = !!c && (!problem || !agentCaller())
  return {
    connection: a.connection ? { id: a.connection, name: shown ? c!.name : null, ...(problem ? { problem } : {}) } : null,
    launchedConnection: a.live?.launchedConnection ? { id: a.live.launchedConnection.id, name: a.live.launchedConnection.name, ...(a.live.launchedConnection.note ? { note: a.live.launchedConnection.note } : {}) } : null,
    ...(a.live?.switchPending ? { switchPending: true } : {})
  }
}

/**
 * Hive's connections as the caller may see them (HI-2108): `connections`, the setups agents choose (a project agent only
 * those usable in its workspace; the user's token and the Assistant every one, `usable: false` on the rest, with their
 * extra arguments); `accounts`, the sign-ins and servers they are on (a project agent only those on in its workspace: id,
 * name, CLI, kind, signed in; the others with on here and who each is signed in as). Never a token, a key or where a login
 * is kept.
 */
route('GET', '/v1/connections', async () => {
  const ws = requireWorkspace()
  const wide = !agentCaller()
  const here = new Set(connectionsHere(ws).map((c) => c.id))
  const accounts = connectionsFor(hiveAccounts(), workspaceConnections(ws), wide)
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
    const limits = (config.get().connectionPlanUsage?.[id]?.limits ?? []).filter((l) => !l.resetsAt || Date.parse(l.resetsAt) > now).map((l) => ({ label: l.label, usedPercent: Math.round(l.usedPercent * 10) / 10, resetsAt: l.resetsAt }))
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
  if (r.ok === false && r.why === 'ambiguous') throw new HttpError(409, `Several connections are named "${ref}": use its id (${r.ids!.join(', ')}).`)
  if (!c || (agentCaller() && !here.includes(c.id))) throw new HttpError(404, `No connection named "${ref}" is usable in this workspace, and none has that id.`)
  return connectionRow(c, here.includes(c.id), !agentCaller())
})

/**
 * A connection's name and values from a request body (HI-2108: hive_connection add and update): model, effort, mode,
 * context200k and extraArgs, each "" or null for the CLI's own (on an update: cleared). Saving checks them as the
 * connection dialog's save does (a mode the CLI has, an effort the model takes: decision E).
 */
export function connectionValuesArg(body: any): ConnectionPatch {
  const out: ConnectionPatch = {}
  const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v).trim() || null)
  if (body?.name !== undefined) {
    const n = String(body.name ?? '').trim()
    if (!n) throw new HttpError(400, 'A connection needs a name.')
    out.name = n
  }
  if (body?.model !== undefined) out.model = text(body.model)
  if (body?.effort !== undefined) out.effort = text(body.effort) as EffortLevel | null
  if (body?.mode !== undefined) out.permissionMode = text(body.mode) as PermissionMode | null
  if (body?.extraArgs !== undefined) out.extraArgs = text(body.extraArgs)
  const c = body?.context200k
  if (c !== undefined) {
    if (c === true || c === 'on') out.use200kContext = true
    else if (c === false || c === 'off' || c === null || c === '') out.use200kContext = null
    else throw new HttpError(400, 'context200k is "on", or "off" (or "") for the model\'s 1M.')
  }
  return out
}

/**
 * The Assistant makes or changes a connection (HI-2108, hive_connection): only with Settings → Assistant → Control →
 * Change settings on, asked again at the change, and listed in its panel. Accounts (sign-ins, servers, keys) stay the
 * user's: a connection goes only on an account that exists.
 */
async function connectionChange<T>(act: ActivityTarget, what: string, fn: (atTheChange: <R>(change: () => R) => R) => Promise<{ done: string; act?: Partial<ActivityTarget>; result: T }>): Promise<T> {
  connectionsAllowed()
  return assistantChange('look', what, act, async (guard) => {
    connectionsAllowed()
    return fn((change) => atTheChange(guard, change))
  })
}

/** Change settings on (HI-2108): else a connection change is refused, saying where the user changes it. */
function connectionsAllowed(): void {
  if (config.settings.assistant?.changeSettings !== true) throw new HttpError(403, "The user's settings don't let you change connections (Settings → Assistant → Control → Change settings is off). Tell the user how to change it in Settings → Accounts & Connections, or that turning Change settings on lets you.")
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
    throw new HttpError(e instanceof HiveError && e.kind === 'notFound' ? 404 : 409, (e as Error).message)
  }
}

route('POST', '/v1/connections', async ({ body }) =>
  connectionChange({ kind: 'add-connection' }, 'make a connection', async (checked) => {
    const ref = String(body?.account ?? '').trim()
    if (!ref) throw new HttpError(400, "Name the account it goes on (account: its id or name, from hive_connection list). Adding an account is the user's, in Settings → Accounts & Connections.")
    const accounts = allAccounts()
    const byName = accounts.filter((a) => a.name.trim().toLowerCase() === ref.toLowerCase())
    const account = accounts.find((a) => a.id === ref) ?? (byName.length === 1 ? byName[0] : undefined)
    if (!account) throw byName.length > 1 ? new HttpError(409, `Several accounts are named "${ref}": use its id (${byName.map((a) => a.id).join(', ')}).`) : new HttpError(404, `No account named "${ref}": hive_connection list names them. Adding one is the user's, in Settings → Accounts & Connections.`)
    const v = connectionValuesArg(body)
    if (!v.name) throw new HttpError(400, 'A connection needs a name.')
    const c = await checked(() => connectionsCall(() => addConnection(account.id, { ...v, name: v.name! })))
    return { done: `Made the connection ${c.name} on ${account.name}`, act: { connection: c.id }, result: connectionRow(c, connectionsHere(requireWorkspace()).some((x) => x.id === c.id), true) }
  })
)

route('PATCH', '/v1/connections/:ref', async ({ params, body }) =>
  connectionChange({ kind: 'update-connection' }, 'change a connection', async (checked) => {
    const ref = decodeURIComponent(params[0] ?? '')
    const r = connectionRef(ref, allConnections(), allConnections().map((c) => c.id))
    if (!r.ok) throw r.why === 'ambiguous' ? new HttpError(409, `Several connections are named "${ref}": use its id (${r.ids!.join(', ')}).`) : new HttpError(404, `No connection named "${ref}", and none has that id.`)
    const v = connectionValuesArg(body)
    if (!Object.keys(v).length) throw new HttpError(400, 'Nothing to change: give name, model, effort, mode, context200k or extraArgs.')
    const c = await checked(() => connectionsCall(() => updateConnection(r.id, v)))
    return { done: `Changed the connection ${c.name} (agents running on it take it when restarted)`, act: { connection: c.id }, result: connectionRow(c, connectionsHere(requireWorkspace()).some((x) => x.id === c.id), true) }
  })
)

/** A workflowRole argument (#1430): builder, reviewer, either or generalist (HI-686). */
function workflowRoleArg(v: unknown): WorkflowRole {
  if (isWorkflowRole(v)) return v
  throw new HttpError(400, 'workflowRole is "builder", "reviewer", "either" or "generalist".')
}

/** Why a worktree of an agent's own is refused (#1451): the Agent API's short note. */
const NOT_PINNED = "Agents aren't pinned to worktrees in 1.0: slots are lent per card or lane." // i18n-ignore: an Agent API refusal (agents read it)

route('POST', '/v1/projects/:name/agents', async ({ params, body }) => {
  const p = projectByName(params[0])
  const project = basename(p)
  return assistantChange('agents', `add an agent to ${project}`, { kind: 'add-agent', project }, async () => {
    const conn = connectionArg(body, p)
    const ws = workspaceOf(p)
    // Decision D (HI-2108): provider, model, effort, mode and context are a connection's now, refused naming those there.
    refuseOldFields(body, getConnection(conn?.connection)?.account ?? firstUsableAccount(ws.path ? ws.config : null)?.id)
    const mcp = agentMcpArg(body)
    if (conn?.cli && !isProviderEnabled(config.settings, conn.cli)) throw new HttpError(409, `${PROVIDERS.find((x) => x.id === conn.cli)?.name ?? conn.cli} is turned off in Settings → Providers.`)
    // 1.0 (#1451): no agent has a worktree of its own (slots are lent per card or lane): the old arguments are refused.
    if (body?.worktree || body?.existingWorktree || body?.branch || body?.base || (body?.location && body.location !== 'project')) throw new HttpError(400, NOT_PINNED)
    // Its connection: the one named, else the first usable here (decision A), its CLI following from it.
    const def = await addAgent(p, {
      name: body?.name ? String(body.name) : undefined,
      ...(body?.workflowRole !== undefined ? { workflowRole: workflowRoleArg(body.workflowRole) } : {}),
      location: 'project',
      mcpServers: mcp.mcpServers ?? undefined,
      ...(conn?.connection ? { connection: conn.connection } : {})
    })
    // The view stays where the user has it; the new agent is marked for them.
    emit({ type: 'agent-added', projectPath: p, agentId: def.id })
    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : ''
    let started = ''
    let didStart: boolean | null = null
    // The launch it started, for undo (#1282): stopped only while that one runs.
    let launched: string | null = null
    if (body?.start || prompt) {
      try {
        launched = (prompt ? await startOnTask(p, def.id, def.name, prompt, (line) => sessions.start(p, { agentId: def.id, prompt: line })) : await sessions.start(p, { agentId: def.id }))?.runId ?? null
        started = ' and started it'
        didStart = true
      } catch (e) {
        started = ` (it didn't start: ${(e as Error).message})`
        didStart = false
      }
    }
    const said = prompt && didStart ? ` on: ${clip(prompt.replace(/\s+/g, ' '), 80)}` : undefined
    // The stream's line is Hive's own words: never why it didn't start.
    const brief = `Added ${def.name} to ${project}${didStart === true ? ' and started it' : didStart === false ? "; it didn't start" : ''}`
    return { done: `Added ${def.name} to ${project}${started}`, said, brief, act: { agent: actAgent(def) }, ...(launched ? { started: { project, agentId: def.id, run: launched } } : {}), result: { agent: addedForAgents(def), project: await projectSummary(p) } }
  })
})

route('PATCH', '/v1/projects/:name/agents/:agent', async ({ params, body }) => {
  const p = projectByName(params[0])
  const agentId = await agentParam(p, params[1] && decodeURIComponent(params[1]))
  const a = await agentDefOf(p, agentId)
  return assistantChange('agents', `change ${a.name}'s settings in ${basename(p)}`, { kind: 'update-agent', project: basename(p), agent: actAgent(a) }, async () => {
    // What of its settings changed, for undo (#1282): as saved when the change was made, under the project's lock.
    let was: AgentDef | undefined
    const role = body?.workflowRole !== undefined ? { workflowRole: workflowRoleArg(body.workflowRole) } : {}
    const conn = connectionArg(body, p)
    // Decision D (HI-2108): refused, naming the connections on its account.
    refuseOldFields(body, getConnection(a.connection)?.account)
    // Another CLI's connection is a change of CLI: only while it is stopped (updateAgent refuses it otherwise).
    const def = await updateAgent(p, agentId, { ...(body?.name !== undefined ? { name: String(body.name) } : {}), ...agentMcpArg(body), ...(conn ? { connection: conn.connection } : {}), ...role }, { check: (current) => void (was = structuredClone(current)) })
    if (was) await noteAgent(requireWorkspace(), basename(p), was, def)
    const live = sessions.liveFor(p, agentId)
    return { done: `Changed ${def.name}'s settings in ${basename(p)}${live ? ' (it applies them when restarted)' : ''}`, act: { agent: actAgent(def) }, result: def }
  })
})

route('POST', '/v1/projects/:name/agents/:agent/start', async ({ params, body }) => {
  const p = projectByName(params[0])
  const agentId = await agentParam(p, decodeURIComponent(params[1]))
  const a = await agentDefOf(p, agentId)
  return assistantChange('agents', `start ${a.name} in ${basename(p)}`, { kind: 'start-agent', project: basename(p), agent: actAgent(a) }, async () => {
    if (sessions.liveFor(p, agentId)) throw new HttpError(409, `${a.name} is already running. Use hive_prompt_agent to give it work once it's idle.`)
    let resumeId: string | undefined
    if (typeof body?.resume === 'string' && body.resume) resumeId = body.resume
    else if (body?.resume) {
      resumeId = (await workspace.projectInfo(p)).agents.find((x) => x.id === agentId)?.resume?.id
      if (!resumeId) throw new HttpError(409, `${a.name} has no conversation to resume. Start it without resume.`)
    }
    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : ''
    const st = prompt ? await startOnTask(p, agentId, a.name, prompt, (line) => sessions.start(p, { agentId, resumeId, prompt: line })) : await sessions.start(p, { agentId, resumeId })
    return { done: `${resumeId ? 'Resumed' : 'Started'} ${a.name} in ${basename(p)}`, said: prompt ? ` on: ${clip(prompt.replace(/\s+/g, ' '), 80)}` : undefined, result: st, ...(st?.runId ? { started: { project: basename(p), agentId, run: st.runId } } : {}) }
  })
})

route('POST', '/v1/projects/:name/agents/:agent/stop', async ({ params, body, signal }) => {
  const p = projectByName(params[0])
  const agentId = await agentParam(p, decodeURIComponent(params[1]))
  const a = await agentDefOf(p, agentId)
  const ws = assistantCaller()
  return assistantChange('agents', `stop ${a.name} in ${basename(p)}`, { kind: 'stop-agent', project: basename(p), agent: actAgent(a) }, async () => {
    const st = sessions.liveFor(p, agentId)
    if (!st) return { done: `${a.name} in ${basename(p)} wasn't running`, result: { ok: true, wasRunning: false } }
    // Stopping an agent in the middle of something is the user's call; one only watching is idle (HI-1994).
    if (stopAsksUser(st.status) && ws) {
      const said = typeof body?.reason === 'string' ? clip(body.reason.trim(), 300) : ''
      const reason = said ? ` Its reason: ${said}${/[.!?]$/.test(said) ? '' : '.'}` : ''
      const how = await assistant.ask(
        ws,
        {
          title: `Stop ${a.name} in ${basename(p)}?`,
          message: `The Assistant wants to stop ${a.name}, which is ${STATUS_WORDS[st.status] ?? st.status}.${reason} Its conversation is kept and can be resumed.`,
          yes: 'Stop',
          no: "Don't stop"
        },
        { timeoutMs: STOP_ASK_MS, signal }
      )
      // Its question closed, whatever ended it: never left open in the panel with nobody waiting on it (HI-1994).
      if (how === 'timedOut') throw new HttpError(408, `Your request to stop ${a.name} timed out: the user didn't answer in ${STOP_ASK_MS / 1000} seconds, and it was withdrawn. ${a.name} keeps running; ask the user in chat if it should still stop.`)
      if (how === 'gone') throw new HttpError(409, `Your request to stop ${a.name} was withdrawn: you stopped waiting for the user's answer. ${a.name} keeps running.`)
      if (how === 'no') throw new HttpError(409, `The user chose not to stop ${a.name}. Leave it running.`)
      // The answer can come minutes later: only the run the user was asked about, and only if Control still allows it.
      if (sessions.liveFor(p, agentId)?.runId !== st.runId) return { done: `${a.name} in ${basename(p)} had already stopped`, result: { ok: true, wasRunning: false } }
      if (!assistant.allows('agents')) throw new HttpError(403, `The user's settings (Settings → Assistant → Control: ${assistant.LEVEL_NAME[assistant.controlLevel()]}) no longer let you stop agents.`)
    }
    // Its cause from the caller's token (HI-1881): the Assistant's, an agent's, or unknown (a script).
    sessions.stop(p, agentId, ws ? 'assistant' : agentCaller() ? 'agent' : undefined)
    return { done: `Stopped ${a.name} in ${basename(p)}`, result: { ok: true, wasRunning: true } }
  })
})

route('POST', '/v1/projects/:name/agents/:agent/prompt', async ({ params, body }) => {
  const p = projectByName(params[0])
  const agentId = await agentParam(p, decodeURIComponent(params[1]))
  const a = await agentDefOf(p, agentId)
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  if (!text) throw new HttpError(400, 'text is required')
  // A new conversation for the task (a new lane, say): the current one ends, as when it hands over to itself.
  const fresh = body?.newConversation === true
  return assistantChange<{ ok: boolean; id?: string; newConversation?: boolean }>('agents', `give ${a.name} in ${basename(p)} a task${fresh ? ' in a new conversation' : ''}`, { kind: 'prompt-agent', project: basename(p), agent: actAgent(a) }, async (guard) => {
    const st = sessions.liveFor(p, agentId)
    // Never over the top of the agent's work, a question to the user, or the user's own typing.
    if (!st) throw new HttpError(409, `${a.name} isn't running. Start it with the task instead (hive_start_agent with prompt).`)
    if (st.status === 'starting') throw new HttpError(409, `${a.name} is still starting. Wait for it (hive_wait_for_agents), then try again, or leave it a message (hive_message_agent).`)
    if (st.status === 'waiting') throw new HttpError(409, `${a.name} is waiting for the user${st.statusMessage ? ` (${st.statusMessage})` : ''}. Tell the user; don't answer for them.`)
    if (st.status === 'working') throw new HttpError(409, `${a.name} is working. Wait until it's idle (hive_wait_for_agents), then give it the task, or leave it a message it gets when it is (hive_message_agent).`)
    if (st.status === 'signin') throw new HttpError(409, `${a.name}'s CLI needs the user to sign in again (its sign-in expired). Tell the user; nothing it is given runs until then.`)
    if (st.status === 'watching') throw new HttpError(409, `${a.name} is ${st.watch?.label.replace(/^Waiting/, 'waiting') ?? 'waiting on cards'} (${st.watch?.agents && !st.watch.lanes ? 'an agent watch' : 'a card watch'}): it takes no new task until it is woken or the user cancels the watch. To tell it something for the work it is waiting on, leave it a message (hive_message_agent): it is woken by it and its watch carries on.`)
    if (st.status === 'background') {
      throw new HttpError(409, `${a.name} is waiting on ${tasksWord(st.backgroundTasks ?? 0)} it started (such as a test run) and carries on by itself when they end. Wait for it (hive_wait_for_agents), then give it the task, or leave it a message it gets when it is idle (hive_message_agent). If it seems stuck, tell the user.`)
    }
    if (sessions.userMayBeTyping(p, agentId)) throw new HttpError(409, `The user has just typed in ${a.name}'s terminal and may still be writing there. Ask the user before giving it a task.`)
    // A line Hive typed that its CLI hasn't taken (#430): more typing would be lost behind it, or clear it.
    if (sessions.lineUntaken(p, agentId)) throw new HttpError(409, `${a.name}'s CLI hasn't taken a line Hive typed into it (it wasn't reading its input). Tell the user: they can click its terminal and press Enter. Nothing is typed into it until then.`)
    if (agentNowFor(p, agentId).pending) throw new HttpError(409, `${a.name} has just been given a prompt that its CLI hasn't taken yet. Wait for it (hive_wait_for_agents), then give it the task.`)
    if (fresh) {
      // The Assistant's authority (Control, its session) again after the stop and at the launch: it may end meanwhile.
      await startOnTask(p, agentId, a.name, text, (line) => sessions.newConversation(p, agentId, line, guard)).catch((e: Error) => {
        const stopped = !sessions.liveFor(p, agentId)
        if (e instanceof assistant.ChangeRefused) {
          if (!stopped) throw e
          const why = e.status === 403 ? 'the user turned Settings → Assistant → Control down meanwhile' : "the Assistant's session that asked for it ended meanwhile"
          throw new HttpError(e.status, `${a.name}'s conversation ended (it is kept in the Sessions tab), but no new one was started: ${why}. It is stopped now.`)
        }
        throw new HttpError(409, `${a.name} wasn't given the task in a new conversation: ${e.message}${stopped ? ' It is stopped now (its conversation is kept): start it with the task (hive_start_agent with prompt).' : ''}`)
      })
      return { done: `Gave ${a.name} in ${basename(p)} a task in a new conversation`, said: `: ${clip(text.replace(/\s+/g, ' '), 80)}`, result: { ok: true, newConversation: true } }
    }
    // A task delivery (#649), given now or not at all: never queued behind the agent's work.
    const r = await deliverNow(p, { agentId, agentName: a.name, conversation: st.sessionId || null, kind: 'task', from: callerSender(), body: text, need: 'free' }).catch((e: Error) => {
      if (e instanceof NotGiven) throw new HttpError(409, `${a.name} wasn't given the task: ${e.message}.`)
      throw e
    })
    return { done: `Gave ${a.name} in ${basename(p)} a task${r ? ` (${r.id})` : ''}`, said: `: ${clip(text.replace(/\s+/g, ' '), 80)}`, result: { ok: true, ...(r ? { id: r.id } : {}) } }
  })
})

// A message for a running agent that may not take a prompt now (#530): a delivery (#647) offered at once when it can be
// (idle, or watching: its watch carries on), else queued and offered as its next line once it is idle; the agent can also
// fetch it with hive_inbox. cancel=true cancels those waiting.
route('POST', '/v1/projects/:name/agents/:agent/message', async ({ params, body }) => {
  const p = projectByName(params[0])
  const agentId = await agentParam(p, decodeURIComponent(params[1]))
  const a = await agentDefOf(p, agentId)
  if (body?.cancel === true) {
    return assistantChange<{ cancelled: number }>('agents', `cancel the messages waiting for ${a.name} in ${basename(p)}`, { kind: 'cancel-messages', project: basename(p), agent: actAgent(a) }, async () => {
      const n = await cancelMessages(p, agentId, 'the Assistant')
      return { done: n ? `Cancelled ${n === 1 ? 'the message' : `${n} messages`} waiting for ${a.name} in ${basename(p)}` : `No message was waiting for ${a.name} in ${basename(p)}`, result: { cancelled: n } }
    })
  }
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  if (!text) throw new HttpError(400, 'text is required')
  if (text.length > MESSAGE_MAX_CHARS) throw new HttpError(400, `text is at most ${MESSAGE_MAX_CHARS} characters (this has ${text.length})`)
  // Tied to a card's round (#652): stale, never given, once the card has moved on.
  const card = body?.card === undefined || body?.card === null ? undefined : Number(cardRefIn(body.card))
  if (card !== undefined && !(Number.isInteger(card) && card > 0)) throw new HttpError(400, 'card must be a card: its number or key (12 or HI-12)')
  return assistantChange<{ id: string; typed: boolean; queued: number; status: string; tells?: InboxSwitch[]; round?: number; card?: number; names?: Record<string, string> }>('agents', `leave ${a.name} in ${basename(p)} a message`, { kind: 'message-agent', project: basename(p), agent: actAgent(a), ...(card !== undefined ? { card } : {}) }, async (guard) => {
    const st = sessions.liveFor(p, agentId)
    if (!st) throw new HttpError(409, `${a.name} isn't running. Start it with the message as its task instead (hive_start_agent with prompt).`)
    guard()
    // Its sender saved with it: the Assistant's launch, whose permission is worked out again at every step (#645).
    const r = await leaveMessage(p, agentId, a.name, callerSender(), text, card).catch((e: Error) => {
      throw new HttpError(409, e.message)
    })
    if (r.fate === 'cancelled' || r.fate === 'expired' || r.fate === 'refused' || r.fate === 'stale') throw new HttpError(409, `The message wasn't typed into ${a.name}: ${r.fate === 'cancelled' ? (r.detail ?? 'cancelled') : `${r.fate}, ${r.detail ?? ''}`}.`)
    const typed = r.fate === 'typed'
    const tied = r.round && card !== undefined ? ` for ${cardRef(card)} round ${r.round}` : ''
    // Queued: the ways Hive tells it, by the carrying-on switches on for it now (#1497: its project's own, else Settings').
    const on = typed ? null : await Promise.all(INBOX_SWITCHES.map((s) => inboxSwitch(p, s)))
    const tells = on ? INBOX_SWITCHES.filter((_s, i) => on[i]) : null
    return { done: `${typed ? 'Gave' : 'Left'} ${a.name} in ${basename(p)} a message (${r.id})${tied}${typed ? '' : ' (queued)'}`, said: `: ${clip(text.replace(/\s+/g, ' '), 80)}`, result: { id: r.id, typed, queued: r.queued, status: typed ? (sessions.liveFor(p, agentId)?.status ?? 'stopped') : st.status, ...(tells ? { tells } : {}), ...(r.round ? { round: r.round, ...(card !== undefined ? { card, ...withNames([card]) } : {}) } : {}) } }
  })
})

/**
 * Who an Agent API call's delivery is from (#645, #649): the Assistant's launch, whose permission is worked out again at
 * every step; else the user (their own scripts).
 */
function callerSender(): DeliverySender {
  const ws = assistantCaller()
  if (!ws) return { kind: 'user', name: 'the user' }
  const launch = sessions.liveFor(assistant.assistantHome(ws), ASSISTANT_AGENT_ID)?.runId ?? ''
  return { kind: 'assistant', name: 'the Assistant', workspace: ws, launch }
}

/** Starts an agent on a task (#649): a task delivery its launch carries as its prompt, received once its CLI takes it. */
const startOnTask = (p: string, agentId: string, agentName: string, prompt: string, start: (line: string) => Promise<LiveSessionState>): Promise<LiveSessionState> =>
  launchWith(p, { agentId, agentName, kind: 'task', from: callerSender(), body: prompt }, start).then((x) => x.launched)

// The Assistant's journal (#1031): its tools (hive_journal_*) only, only while it is on (Settings → Assistant → Journal).
// The tools come and go with the Assistant's start; each call checks again, so one turned off meanwhile is refused.
function journalHome(): { home: string; settings: JournalSettings } {
  if (!assistantCaller()) throw new HttpError(403, "Only the Hive Assistant keeps a journal.")
  const ws = requireWorkspace()
  const settings = journalSettingsOf(ws)
  if (!settings.enabled) throw new HttpError(409, 'The journal is off (Settings → Assistant → Journal): nothing is written or recalled. Its entries are kept.')
  return { home: ws.assistantHome, settings }
}
/** A journal call: the caller's mistakes are 400s, said plainly; one while the journal is being deleted, 409. */
function journalCall<T>(fn: () => T): T {
  try {
    return fn()
  } catch (e) {
    if (e instanceof JournalBusy) throw new HttpError(409, e.message)
    if (e instanceof JournalError) throw new HttpError(400, e.message)
    throw e
  }
}
const entryId = (raw: string): number => {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'An entry id is a whole number.')
  return n
}
/**
 * A card link's ref as the journal keeps it (HI-1661): the card's number, as Hive's own facts link it, so an entry the
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
  if (!e) throw new HttpError(404, `There is no entry ${params[0]}.`)
  return e
})
route('PATCH', '/v1/journal/:id', async ({ params, body }) => {
  const { home, settings } = journalHome()
  const id = entryId(params[0])
  const patch = withCardLinks(requireWorkspace(), body, ['addLinks'])
  if (!journalCall(() => updateEntry(home, settings, id, patch))) throw new HttpError(404, `There is no entry ${id}.`)
  return { id, updated: true }
})
route('DELETE', '/v1/journal/:id', async ({ params }) => {
  const { home } = journalHome()
  const id = entryId(params[0])
  if (!journalCall(() => deleteEntry(home, id))) throw new HttpError(404, `There is no entry ${id}.`)
  return { id, deleted: true }
})

// A successful build of Hive itself (#1534): scripts/buildFact.mjs, from npm run dist or npm run release, with the
// workspace token or the agent's own (an agent running the build). Hive writes it into the workspace's journal as its fact.
route('POST', '/v1/builds', async ({ body }) => {
  const f = buildFactOf(body)
  if ('error' in f) throw new HttpError(400, f.error)
  return recordBuild(requireWorkspace(), f)
})

/** Who is calling hive_inbox: a project agent (its own), or the Assistant (its home's). */
function inboxOwner(): { host: string; agentId: string } {
  const me = agentCaller()
  if (me) return { host: me.projectPath, agentId: me.agentId }
  if (assistantCaller()) return { host: requireWorkspace().assistantHome, agentId: ASSISTANT_AGENT_ID }
  throw new HttpError(400, 'Only an agent or the Assistant has an inbox.')
}

// hive_inbox (#647): the caller's deliveries not received yet (a card's events in one item), now received; with ack, marks
// those ids acked and lists nothing. With ack and read: true (#1531, opt-in), both in one call: the ack first, by the
// ack's own rules, then the read, whose items are received only (an item is never acked by being read). An id that
// isn't the caller's is unknown, like one that doesn't exist.
route('POST', '/v1/inbox', async ({ body }) => {
  const { host, agentId } = inboxOwner()
  if (body?.read !== undefined && typeof body.read !== 'boolean') throw new HttpError(400, 'read is true or false')
  // Its rows name cards by key, for the hive tools' words (#1219).
  const named = <T extends { items: InboxItem[] }>(inbox: T) => ({ ...inbox, ...withNames(inbox.items.flatMap((i) => (i.card ? [i.card] : []))) })
  if (body?.ack !== undefined) {
    if (!Array.isArray(body.ack) || !body.ack.length || body.ack.length > 200 || !body.ack.every((x: unknown) => typeof x === 'string' && x.length <= 32)) throw new HttpError(400, 'ack is a list of delivery ids ("m12"), at most 200')
    const ids = (body.ack as string[]).map((x) => x.trim())
    return body.read === true ? named(await ackThenRead(host, agentId, ids)) : ackDeliveries(host, agentId, ids)
  }
  return named(await readInbox(host, agentId))
})

// An agent's deliveries with their states and times (#647): the newest `limit` (default 20, at most 200).
route('GET', '/v1/projects/:name/agents/:agent/deliveries', async ({ params, query }) => {
  const p = projectByName(params[0])
  ownProjectOnly(p, "Reading an agent's deliveries")
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
  if (!a) throw new HttpError(404, 'Unknown agent')
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
      // Its last prompt Hive's doorbell (#650: ids only): the task it was last given is the newest one (or handover) delivered.
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
  // Only while the user may still be typing there (Settings → Assistant → Pause after you type), as Hive itself holds off
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
    // A long transcript slows the CLI and Hive; handing over to itself (a new conversation) makes it short again.
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
    ...(st?.safeguard ? { safeguard: safeguardActivity(st.safeguard) } : providerDescriptor(provider).safeguardHelp === null ? { safeguard: 'not detected' } : {}),
    lockedFiles: sessions.locksFor(p, agentId).map((f) => placeRelative(folder, f) || f),
    userTypedSecondsAgo: typed ? Math.round((Date.now() - typed) / 1000) : null,
    ...(inbox.deliveries.length ? { inbox } : {})
  }
}

route('GET', '/v1/projects/:name/agents/:agent/activity', async ({ params, query }) => {
  const p = projectByName(params[0])
  ownProjectOnly(p, "Reading an agent's activity")
  return agentActivity(p, await agentParam(p, decodeURIComponent(params[1])), query.get('detail') === 'true')
})

/**
 * Whether a launch of an agent (its HIVE_RUN_ID) is still its running one (#1008): a test run started in an agent's
 * shell records it, and a run waiting for a test slot asks, to say when the holder was left over by a session that has
 * ended (Hive closed, the agent stopped or restarted). Status, as agents' is: open to every caller.
 */
route('GET', '/v1/projects/:name/agents/:agent/launches/:run', async ({ params }) => {
  const p = projectByName(params[0])
  const id = await agentParam(p, decodeURIComponent(params[1]))
  return { running: sessions.liveFor(p, id)?.runId === decodeURIComponent(params[2]) }
})

/** An agent as a wait reads it: a prompt Hive just typed that its CLI hasn't taken yet counts as working (#416). */
const agentNowFor = (p: string, id: string): AgentNow => sessions.agentNow(p, id) ?? { status: 'stopped', runId: null, prompts: 0, pending: false }

/**
 * Waits until agents stop working (or `timeoutSeconds`, at most 10 minutes): the ones named, else every agent
 * working in the workspace. Answers with each one's status, so the caller sees who finished and who needs the user.
 * `wake: true` (#416): the calling agent or Assistant registers an agent watch instead and ends its turn; Hive types one
 * line into it when one finishes, waits for the user or stops (main/watches.ts). `cancel: true` ends its watch. Agents'
 * status is open to every caller, as before; another project's agent's reply isn't in a project agent's line.
 */
route('POST', '/v1/agents/wait', async ({ body }) => {
  const me = agentCaller()
  const home = assistantCaller() ? requireWorkspace().assistantHome : null
  const who = me ? { projectPath: me.projectPath, agentId: me.agentId } : home ? { projectPath: home, agentId: 'assistant' } : null
  if (body?.cancel === true) {
    if (!who) throw new HttpError(400, 'Only an agent or the Assistant has a watch to cancel.')
    const w = sessions.watchFor(who.projectPath, who.agentId)
    const kind = w?.lanes ? 'lane' : w?.agents ? 'agent' : 'card'
    const had = await cancelWatch(requireWorkspace(), who.projectPath, who.agentId)
    return { done: had ? `Cancelled your ${kind} watch.` : 'You had no watch.' }
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
    if (!who) throw new HttpError(400, 'Only an agent or the Assistant can be woken: a script waits without wake (timeoutSeconds).')
    if (targets.some((t) => self(t.p, t.id))) throw new HttpError(400, "You can't watch yourself: nothing would wake you.")
    const limit = body?.limitMinutes === undefined ? WATCH_DEFAULT_LIMIT_MINUTES : Number(body.limitMinutes)
    if (!Number.isFinite(limit) || limit < 1 || limit > WATCH_MAX_LIMIT_MINUTES) throw new HttpError(400, `limitMinutes must be from 1 to ${WATCH_MAX_LIMIT_MINUTES}`)
    const unique = targets.filter((t, i) => targets.findIndex((u) => resolvePath(u.p).toLowerCase() === resolvePath(t.p).toLowerCase() && u.id === t.id) === i)
    if (!unique.length) return { already: ['No agent is working'] }
    if (unique.length > AGENT_WATCH_MAX_AGENTS) throw new HttpError(400, `at most ${AGENT_WATCH_MAX_AGENTS} agents in one watch`)
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
  if (!a) throw new HttpError(403, "Only a project's own agents hold its merge slot (with their own token). Scripts and the Assistant can read it.")
  ownProjectOnly(p, 'The merge slot')
  const live = sessions.liveFor(a.projectPath, a.agentId)
  if (!live) throw new HttpError(409, 'Only a running agent can hold the merge slot.')
  const def = projectAgents(await workspace.projectConfig(a.projectPath)).find((x) => x.id === a.agentId)
  return { projectPath: a.projectPath, agentId: a.agentId, agentName: def?.name ?? a.agentId, runId: live.runId }
}

/**
 * A claim naming cards Hive merges (each card's own rules, #1354): refused before the slot is touched, as the card's
 * report merge would be (`merge.hiveMerges`, recorded as Refused, saying where it is in the merge queue). A claim naming
 * no card, or cards the agent merges, is unchanged: the slot stays for agents' merges and the user's own.
 */
async function refuseHiveMerges(projectPath: string, cards: number[]): Promise<void> {
  if (!cards.length) return
  const wf = await workflowFor(workspace, projectPath).catch(() => null)
  if (!wf) return
  const actor = actorOf(await taskActor())
  for (const n of cards) {
    const refused = await wf.refuseHiveMerge(`#${n}`, actor, 'merge slot') // i18n-ignore: the refused move's name, agent-facing
    if (refused) throw new tasks.WorkflowRefusedError(refused)
  }
}

/** The branch a slot call names, or the one the project folder is on (what Hive's Merge dialog merges into). */
async function slotBranchFor(p: string, v: unknown): Promise<string> {
  if (v !== undefined && v !== null) return slotBranch(v)
  const b = await workspace.branch(p)
  if (!b) throw new HttpError(409, "The project folder isn't on a branch: name the branch to merge into.")
  return b
}

const slotCall = async <T>(fn: () => Promise<T> | T): Promise<T> => {
  try {
    // The cards the slot's holders merge, named by key for the hive tools' words (#1219).
    return withCardsNamed(await fn())
  } catch (e) {
    throw e instanceof MergeSlotError ? new HttpError(e.status, e.message) : e
  }
}

route('GET', '/v1/projects/:name/merge-slot', async ({ params, query }) =>
  slotCall(async () => {
    const p = projectByName(params[0])
    ownProjectOnly(p, "Reading a project's merge slot")
    return mergeSlots.status(p, await slotBranchFor(p, query.get('branch') ?? undefined))
  })
)

route('POST', '/v1/projects/:name/merge-slot/claim', async ({ params, body, signal }) =>
  slotCall(async () => {
    const p = projectByName(params[0])
    const agent = await slotAgent(p)
    const branch = await slotBranchFor(p, body?.branch)
    const cards = slotCards(cardRefsIn(body?.cards))
    await refuseHiveMerges(p, cards)
    const t = body?.timeoutSeconds
    if (t !== undefined && (typeof t !== 'number' || !Number.isFinite(t) || t < 0)) throw new HttpError(400, 'timeoutSeconds must be a number of seconds')
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
    throw e instanceof lanes.LaneError ? new HttpError(e.status, e.message) : e
  }
}

/**
 * A lane reply with `names` for its cards (#1219 round 2, finding 1): on each lane (a list, an ended lane) or on the
 * change (started, joined), for the hive MCP server that words it.
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
    if (v !== undefined && v !== null && v !== '') ownProjectOnly(projectByName(String(v)), 'A lane')
    return a.projectPath
  }
  if (typeof v !== 'string' || !v) throw new HttpError(400, 'project is required')
  return projectByName(v)
}

/** A lane's numbers and texts from a request body (undefined: not given). */
function laneArgs(body: any): { cards?: number[]; rounds?: number; waitMinutes?: number; name?: string | null; brief?: string } {
  const out: { cards?: number[]; rounds?: number; waitMinutes?: number; name?: string | null; brief?: string } = {}
  if (body?.cards !== undefined) {
    const c = laneCards(cardRefsIn(body.cards))
    if (typeof c === 'string') throw new HttpError(400, c)
    out.cards = c
  }
  for (const k of ['rounds', 'waitMinutes'] as const) {
    if (body?.[k] === undefined) continue
    const v = laneNumber(body[k], k, 0)
    if (typeof v === 'string') throw new HttpError(400, v)
    out[k] = v
  }
  if (body?.name !== undefined) out.name = laneName(body.name)
  // The builder's brief (HI-1795): text, or '' to clear it; left out, a running lane keeps its own.
  if (body?.brief !== undefined) {
    if (typeof body.brief !== 'string') throw new HttpError(400, "brief must be text ('' clears it)")
    if (body.brief.length > LANE_BRIEF_MAX) throw new HttpError(400, `brief is at most ${LANE_BRIEF_MAX} characters`)
    out.brief = body.brief
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

// The next card of the calling agent's running lane (#1270, hive_lane next): to start, to carry on, or why it waits.
route('GET', '/v1/lanes/next', async () =>
  laneCall(async () => {
    const a = agentCaller()
    if (!a) throw new HttpError(400, "next is a lane agent's: read a lane with GET /v1/lanes/{id}")
    const r = await lanes.laneNext(requireWorkspace(), basename(a.projectPath), a.agentId)
    // Its passed cards Hive merges, each with where it is in the merge queue (#1354): the next waits for them.
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
 * hive_lane start (POST /v1/lanes), and a new card placed on a lane as it is made (HI-2167, `place`: POST /v1/tasks with
 * lane): one path, the same rules, launches and the Assistant's change for both.
 */
async function laneStartCall(body: any, place?: lanes.LanePlace): Promise<LaneChange> {
  const ws = requireWorkspace()
  const p = laneProject(body?.project)
  const args = laneArgs(body)
  if (place) args.cards = [place.card]
  if (!args.cards) throw new HttpError(400, 'cards must be the card numbers, in order (at least one)')
  const a = agentCaller()
  // A project agent registers its own lane: it is the builder.
  const builder = a ? (body?.builder !== undefined && body.builder !== '' && (await agentParam(p, body.builder)) !== a.agentId ? null : a.agentId) : await agentParam(p, body?.builder)
  if (!builder) throw new HttpError(403, "An agent starts its own lane, as its builder: a reviewer joins its builder's lane (join)")
  // A reviewer Hive doesn't know isn't a reason to refuse a new lane: it starts without one, and its reviewer can join it.
  // A running lane's start naming one is refused, naming its reviewer (HI-2273: startLane, under its lock).
  let reviewer: string | null | undefined
  let unknownReviewer: string | undefined
  let note: string | undefined
  if (body?.reviewer === null || body?.reviewer === '') reviewer = null
  else if (body?.reviewer !== undefined) {
    reviewer = await agentParam(p, body.reviewer).catch(() => null)
    if (!reviewer) {
      unknownReviewer = String(body.reviewer)
      note = `No agent "${unknownReviewer}" in ${basename(p)}: the lane has no reviewer until one joins it.`
    }
  }
  // Reviewed by the project's reviewer pool (HI-1581, G17), the Assistant's and a script's: refused as Start Lane…
  // refuses it (the rules have no pool, nobody but the builder reviews), and with a reviewer of its own.
  if (body?.pool !== undefined && typeof body.pool !== 'boolean') throw new HttpError(400, 'pool must be true or false')
  const pool = body?.pool === true
  // A changed list applied now, its card in flight put back (HI-1995).
  if (body?.applyNow !== undefined && typeof body.applyNow !== 'boolean') throw new HttpError(400, 'applyNow must be true or false')
  const applyNow = body?.applyNow === true
  if (pool && a) throw new HttpError(403, "A lane reviewed by the pool is started by the Assistant or the user (Start Lane): an agent's own lane names its reviewer")
  if (pool && body?.reviewer !== undefined && body.reviewer !== null && body.reviewer !== '') throw new HttpError(400, 'A lane reviewed by the pool has no reviewer of its own: leave reviewer out')
  if (pool) await checkLanePool(ws, p, builder)
  const start = async () => {
    // Hive's own start of the lane's card waits for this one to launch its agents (HI-2029); a builder registering its
    // own loop is at work already.
    const release = a ? null : lanes.holdLaneStart(ws, basename(p), builder)
    try {
      return await started()
    } finally {
      release?.()
    }
  }
  const started = async () => {
    const r = await lanes.startLane(ws, { project: basename(p), builder, reviewer, ...(unknownReviewer !== undefined ? { unknownReviewer } : {}), cards: args.cards!, rounds: args.rounds, waitMinutes: args.waitMinutes, name: args.name, brief: args.brief, briefNotIn: sessions.liveFor(p, builder)?.sessionId ?? null, by: await laneBy(), ...(pool ? { pool: true } : {}), ...(applyNow ? { applyNow: true } : {}), ...(place ? { place } : {}), ...(a ? { ownBuilder: true } : {}) })
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
  return assistantChange('agents', `start a lane in ${basename(p)}`, { kind: 'lane-start', project: basename(p), ...(args.cards ? { cards: args.cards } : {}), ...(builderAct ? { agent: builderAct } : {}) }, async () => {
    // Recorded for undo by lanes.ts, from the lane as read under its lock, in its save (#1282).
    const r = await start()
    // #402: a lane the Assistant starts but doesn't watch goes unfollowed ("they'll tell you"): its reply says so. A
    // lane watch (#531) on every running lane, or on this one, follows it.
    const w = sessions.watchFor(ws.assistantHome, ASSISTANT_AGENT_ID)
    const followed = !!w?.lanes && (w.lanes.includes('all') || w.lanes.includes(r.lane.id))
    const nudge = followed ? '' : 'No watch of yours follows this lane: watch the lanes (hive_wait_for_tasks with lanes ["all"], wake) to follow it to its end.'
    const result = nudge ? { ...r, note: [r.note, nudge].filter(Boolean).join(' ') } : r
    // A reorder applied now put a card back and gave the lane a card to start next (HI-1995): neither is undone.
    const putBack = applyNow && (r.note ?? '').startsWith('Applied now: ')
    return { done: `Lane ${r.lane.id} ${r.did} in ${basename(p)}: ${r.lane.builder.name} / ${r.lane.reviewer?.name ?? 'no reviewer'}, ${r.lane.cards.map((c) => cardRef(c.number)).join(', ')}${putBack ? ` (${r.note!.replace(/^Applied now: /, 'applied now: ')})` : ''}`, act: laneAct(r.lane), result, ...(putBack ? { stays: UNDO_FINAL.laneReorderNow } : {}) }
  })
}

route('POST', '/v1/lanes/join', async ({ body }) =>
  laneCall(async () => {
    const ws = requireWorkspace()
    const p = laneProject(body?.project)
    const args = laneArgs(body)
    const a = agentCaller()
    const reviewer = a ? a.agentId : await agentParam(p, body?.reviewer)
    if (typeof body?.builder !== 'string' || !body.builder) throw new HttpError(400, "builder is required: the name of the lane's builder")
    const builder = await agentParam(p, body.builder)
    const joined = async () => lanes.joinLane(ws, { project: basename(p), builder, reviewer, cards: args.cards, by: await laneBy() })
    if (!assistantCaller()) return joined()
    const reviewerAct = await knownAgent(basename(p), reviewer)
    return assistantChange('agents', `join a lane in ${basename(p)}`, { kind: 'lane-join', project: basename(p), ...(args.cards ? { cards: args.cards } : {}), ...(reviewerAct ? { agent: reviewerAct } : {}) }, async () => {
      const r = await joined()
      return { done: `${r.lane.reviewer?.name ?? 'A reviewer'} joined lane ${r.lane.id} in ${basename(p)}`, act: { ...laneAct(r.lane), ...(r.lane.reviewer ? { agent: actAgent(r.lane.reviewer) } : {}) }, result: r }
    })
  })
)

route('POST', '/v1/lanes/:id/end', async ({ params, body }) =>
  laneCall(async () => {
    const ws = requireWorkspace()
    const id = decodeURIComponent(params[0])
    const a = agentCaller()
    const commit = body?.mergeCommit
    if (commit !== undefined && commit !== null && (typeof commit !== 'string' || !/^[0-9a-zA-Z._/-]{4,64}$/.test(commit))) throw new HttpError(400, 'mergeCommit must be a commit (its hash)')
    // With rules enforced Hive records the merge from the cards' facts (#1270, §16.8.2): an agent's commit is ignored, said.
    const ignored = commit && a && (await lanes.lanesEnforced()) ? { note: 'mergeCommit is ignored: Hive records the lane\'s merge from its cards\' facts.' } : {} // i18n-ignore: an agent's reply (English)
    const end = async () => ({ ...(await lanes.endLane(ws, id, { abandoned: body?.abandoned === true, mergeCommit: commit ?? null, ...(a ? { project: basename(a.projectPath), agent: a.agentId } : {}) })), ...ignored })
    if (!assistantCaller()) return end()
    const laneId = /^[\w.-]{1,64}$/.test(id) ? id : null
    return assistantChange('agents', laneId ? `end lane ${laneId}` : 'end a lane', { kind: 'lane-end', ...(laneId ? { lane: laneId } : {}) }, async () => {
      const l = await end()
      return { done: `Lane ${l.id} in ${l.project}: ${l.state}`, act: laneAct(l), result: l }
    })
  })
)

// A lane agent's new conversation no more tried, tried again (HI-2034): the user's (the lane's row) and the Assistant's
// within Settings → Assistant → Control, never a project agent's (it would restart another agent).
route('POST', '/v1/lanes/:id/fresh-start', async ({ params }) =>
  laneCall(async () => {
    notAgents("retry a lane's new conversations")
    const ws = requireWorkspace()
    const id = decodeURIComponent(params[0])
    const lane = (await lanes.rawLanes(ws)).find((l) => l.id === id)
    if (!lane) throw new HttpError(404, `No lane ${id}`)
    const retry = async () => ({ retried: await retryFreshStart(ws, id) })
    if (!assistantCaller()) return retry()
    return assistantChange('agents', `retry lane ${id}'s new conversations`, { kind: 'lane-fresh-start', lane: id, project: lane.project }, async () => {
      const r = await retry()
      return { done: r.retried ? `Lane ${id}: ${r.retried} new conversation${r.retried > 1 ? 's' : ''} tried again` : `Lane ${id}: no new conversation was waiting to be retried`, result: r }
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
    if (v !== undefined && v !== null && v !== '') ownProjectOnly(projectByName(String(v)), 'A merge queue')
    return a.projectPath
  }
  if (typeof v !== 'string' || !v) throw new HttpError(400, 'project is required')
  return projectByName(v)
}

/** A queue's target from a request: the one given, else the project's only queue's (several or none: say which). */
async function queueTargetOf(ws: WorkspaceService, p: string, v: unknown): Promise<string> {
  if (v !== undefined && v !== null && v !== '') {
    if (typeof v !== 'string' || v.length > 255 || /[\s~^:?*[\\]/.test(v)) throw new HttpError(400, 'target is a branch name')
    return v
  }
  const views = await queueViews(ws, p)
  if (views.length === 1) return views[0].target
  throw new HttpError(400, `target is required: the branch the queue merges into${views.length ? ` (${views.map((x) => x.target).join(', ')})` : ''}`)
}

/** A queue as the Agent API gives it: no folder (a stuck advance's neither), and whether an outcome has a log rather than the log itself (lean). */
const publicQueue = ({ projectPath: _p, paused, hiveMerges: _h, inFlight: _i, returns: _r, returnsMore: _more, pauses: _pauses, ...v }: QueueView): QueuePublic => ({
  ...v,
  paused: paused ? (({ stuck, message: _m, ...p }) => (stuck ? { ...p, stuck: (({ folder: _f, ...s }) => s)(stuck) } : p))(paused) : null,
  recent: v.recent.map(({ log: output, seen: _s, revision: _rev, tookMs: _took, push: _push, logPath: _lp, ...r }) => (output ? { ...r, hasLog: true as const } : r))
})

/** A project agent asking to change a queue: refused, saying whose controls these are. */
function notAgents(what: string): void {
  if (agentCaller()) throw new HttpError(403, `Project agents can't ${what}: the merge queue's controls are the user's, and the Hive Assistant's within Settings → Assistant → Control. Tell the user if it should be done.`)
}

route('GET', '/v1/queue', async ({ query }) => {
  const ws = requireWorkspace()
  const p = queueProject(query.get('project'))
  const target = query.get('target') || undefined
  if (target && (target.length > 255 || /[\s~^:?*[\\]/.test(target))) throw new HttpError(400, 'target is a branch name')
  return (await queueViews(ws, p, target)).map(publicQueue)
})

route('POST', '/v1/queue/pause', async ({ body }) => {
  notAgents('pause a merge queue')
  const ws = requireWorkspace()
  const p = queueProject(body?.project)
  return assistantChange('agents', `pause the merge queue of ${basename(p)}`, { kind: 'queue-pause', project: basename(p) }, async (guard) => {
    const target = await queueTargetOf(ws, p, body?.target)
    const v = await pauseQueue(ws, p, target, 'assistant', guard)
    return { done: `Paused the merge queue for ${target} in ${basename(p)}`, result: publicQueue(v) }
  })
})

route('POST', '/v1/queue/resume', async ({ body }) => {
  notAgents('resume a merge queue')
  const ws = requireWorkspace()
  const p = queueProject(body?.project)
  return assistantChange('agents', `resume the merge queue of ${basename(p)}`, { kind: 'queue-resume', project: basename(p) }, async (guard) => {
    const target = await queueTargetOf(ws, p, body?.target)
    const r = await resumeQueue(ws, p, target, guard)
    return { done: r.resumed ? `Resumed the merge queue for ${target} in ${basename(p)}` : `The merge queue for ${target} in ${basename(p)} is still paused (${r.view.paused?.reason ?? 'paused'})`, result: { resumed: r.resumed, queue: publicQueue(r.view) } }
  })
})

// --- Pausing the team before an update (HI-2081): the Assistant's, for its own workspace only (HR1's s12 check); the
// user's pause of every workspace is the window's. Another open workspace is told as one line, with none of its agents.

/** Agents (and scripts) don't pause or resume the team: the user's, and the Assistant's within Control agents. */
function notTeamAgents(what: string): void {
  if (agentCaller()) throw new HttpError(403, `Project agents can't ${what}: pausing the team is the user's, and the Hive Assistant's within Settings → Assistant → Control. Tell the user if it should be done.`)
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
      lines.push("Another open workspace isn't paused: the user pauses it from its window, or with Pause the Team.")
    } else if (!v.parked) {
      othersOk = false
      lines.push('Another open workspace is paused, not parked yet.')
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
  notTeamAgents('read the team pause')
  return teamFor(requireWorkspace())
})

route('POST', '/v1/team/pause', async () => {
  notTeamAgents('pause the team')
  const ws = requireWorkspace()
  return assistantChange('agents', 'pause the team', { kind: 'team-pause' }, async (guard) => {
    guard()
    const p = await pauseTeam(ws, 'assistant')
    return { done: `Paused the team (${p.pauseId})`, result: await teamFor(ws) }
  })
})

route('POST', '/v1/team/resume', async () => {
  notTeamAgents('resume the team')
  const ws = requireWorkspace()
  return assistantChange('agents', 'resume the team', { kind: 'team-resume' }, async (guard) => {
    guard()
    const was = await resumeTeam(ws)
    return { done: was ? 'Resumed the team' : 'The team was not paused', result: await teamFor(ws) }
  })
})

/** A held writer as the Agent API lists it (#1561): who holds it, its run and Hive, and the processes Hive lists of it. */
const publicHeld = (w: HeldRow) => ({ slot: w.slot, agent: w.agentName, run: w.run, hive: w.hive.self ? 'this Hive' : `gone (process ${w.hive.pid})`, processes: w.processes ? { list: w.processes.list.map((p) => ({ pid: p.pid, label: p.label })), more: w.processes.more } : null })

/** Release Slot's refusals (#1561) as the Agent API answers them. */
const slotRefusal = (e: unknown): unknown => (e instanceof SlotReleaseRefused ? new HttpError(e.status, e.message) : e)

// What a project has to release (#1561): carried slots (#1441) and held writers (#1506), as the agents' ⋯ offer them.
route('GET', '/v1/projects/:name/slots/releasable', async ({ params }) => {
  const p = projectByName(params[0])
  ownProjectOnly(p, "Reading a project's slots to release")
  const r = await releasableSlots(p)
  return { project: basename(p), carried: r.carried.map((c) => ({ slot: c.slot, agent: c.agent.name })), held: r.held.map(publicHeld) }
})

// Release Slot (#1561): a carried slot, or a held writer once confirmed (its slot and run), as the window's ⋯ does.
route('POST', '/v1/projects/:name/slots/:slot/release', async ({ params, body }) => {
  if (agentCaller()) throw new HttpError(403, "Project agents can't release a slot: that is the user's, and the Hive Assistant's within Settings → Assistant → Control once the user agrees. Tell the user if a slot is stuck.")
  const p = projectByName(params[0])
  const slot = decodeURIComponent(params[1])
  const kind = body?.kind === undefined ? undefined : body.kind === 'carried' || body.kind === 'writer' ? body.kind : null
  if (kind === null) throw new HttpError(400, 'kind is carried or writer')
  const confirm = body?.confirm && typeof body.confirm === 'object' ? (body.confirm as { slot?: unknown; run?: unknown }) : null
  return assistantChange('agents', `release slot ${slot} in ${basename(p)}`, { kind: 'release-slot', project: basename(p) }, async (guard) => {
    const r = await releaseSlot(requireWorkspace(), p, slot, { ...(kind ? { kind } : {}), confirm, end: body?.end === true, guard }).catch((e) => {
      throw slotRefusal(e)
    })
    await workspaceOf(p).refresh()
    const what = r.kind === 'carried' ? `${r.slot} in ${basename(p)}: no longer kept for ${r.agent.name}` : `${r.slot} in ${basename(p)} from ${r.agent.name}'s ended run${r.ended ? ', its listed processes ended first' : ''}`
    return { done: `Released ${what}`, act: { agent: { id: r.agent.id, name: r.agent.name } }, result: { project: basename(p), ...r, agent: r.agent.name } }
  })
})

/** The Assistant's alone (HI-1502): a template's list, plan and load. Project agents, scripts and the user's token are refused before any template is read. */
function assistantTemplates(what: string): void {
  if (!assistantCaller()) throw new HttpError(403, `Only the Hive Assistant can ${what} through the Agent API: templates are loaded in Hive's window.`)
}

/** A body's workflow argument: true unless false (HI-1502: its workflow is applied by default, as the window's tick box is). */
function workflowArg(body: any): boolean {
  if (body?.workflow !== undefined && typeof body.workflow !== 'boolean') throw new HttpError(400, 'workflow is true or false')
  return body?.workflow !== false
}

// The templates a project can use (HI-1502): Hive's own, the workspace's and its own, a row each.
route('GET', '/v1/projects/:name/templates', async ({ params }) => {
  assistantTemplates("list a project's templates")
  const p = projectByName(params[0])
  return { project: basename(p), templates: await templateRows(p) }
})

// What loading a template would do (HI-1502): nothing is changed.
route('POST', '/v1/projects/:name/templates/plan', async ({ params, body }) => {
  assistantTemplates('plan loading a template')
  const p = projectByName(params[0])
  const e = await findTemplate(p, body ?? {})
  return (await planReply(p, e, body?.names, workflowArg(body), body?.connections)).reply
})

// Loading a template (HI-1502): the window's load, its names given, its workflow saved unless workflow is false; undoable.
route('POST', '/v1/projects/:name/templates/load', async ({ params, body }) => {
  assistantTemplates('load a template')
  const p = projectByName(params[0])
  const applyWorkflow = workflowArg(body)
  const named = typeof body?.template === 'string' ? clip(body.template, 60) : 'a template'
  return assistantChange('agents', `load the template "${named}" into ${basename(p)}`, { kind: 'load-template', project: basename(p) }, async (guard) => {
    const e = await findTemplate(p, body ?? {})
    const r = await loadForAssistant(p, e, body?.names, applyWorkflow, guard, body?.connections)
    const wf = r.workflow ? (r.workflow.saved ? `, and its workflow (${r.workflow.changes.length} options changed)` : '; its workflow was not saved') : ''
    return { done: `Loaded the template "${r.template.name}" into ${r.project}: ${r.created.length} agents${wf}`, stays: UNDO_FINAL.templateCards, result: r }
  })
})

// Choose Connections… (HI-2109): the project's existing agents given connections by role or name, nothing loaded; undoable.
route('POST', '/v1/projects/:name/templates/apply', async ({ params, body }) => {
  assistantTemplates("choose a project's agents' connections")
  const p = projectByName(params[0])
  return assistantChange('agents', `choose connections for ${basename(p)}'s agents`, { kind: 'update-agent', project: basename(p) }, async (guard) => {
    const r = await applyForAssistant(p, body?.connections, guard)
    return { done: `Chose connections in ${r.project}: ${r.changed.length} agents changed${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}`, result: r }
  })
})

/** Remove from queue or Retry merge, the Assistant's: its reason required, run as the card's intent (#1353). */
async function queueCard(body: any, kind: 'removeFromQueue' | 'retryMerge'): Promise<IntentDone> {
  notAgents(kind === 'removeFromQueue' ? 'take a card out of the merge queue' : "retry a card's merge")
  const ws = requireWorkspace()
  const ref = intentRef(String(body?.card ?? ''))
  const reason = textField(body, 'reason', true)
  const was = await tasks.getTask(ref.n).catch(() => null)
  return assistantChange('agents', `${INTENT_WORDS[kind]} ${cardRef(ref.n)}`, { kind: 'update-task', card: ref.n, ...(was?.project ? { project: was.project } : {}) }, async (guard) => {
    const { done, card } = await queueCardChange(ws, ref.n, await taskActor(), kind, reason, guard)
    const moved = done.from && done.to && done.from !== done.to ? `, ${done.from} → ${done.to}` : ''
    return { done: `${cardName(card)} ${clip(card.title, 60)}: ${INTENT_DONE[kind]}${moved}`, act: { column: card.column, agent: await cardAgent(card) }, result: done, stays: INTENT_STAYS[kind] }
  })
}

route('POST', '/v1/queue/remove', async ({ body }) => queueCard(body, 'removeFromQueue'))
route('POST', '/v1/queue/retry', async ({ body }) => queueCard(body, 'retryMerge'))

route('GET', '/v1/shared', async () => inWorkspace(requireWorkspace(), () => notesTree()))

// A project's handovers, newest first (under its earlier folder names too, #514); no project: every one. Their paths
// as /v1/shared/file takes them. What hive_read_latest_handover and the session guidance find.
route('GET', '/v1/shared/handovers', async ({ query }) => {
  const name = query.get('project')
  const project = name ? projectByName(name) : null
  const ws = project ? workspaceOf(project) : requireWorkspace()
  const list = await inWorkspace(ws, () => handoversFor(ws, project ? basename(project) : undefined))
  return list.map((f) => ({ path: f.relPath, ...(f.modified ? { modified: f.modified } : {}) }))
})

route('GET', '/v1/shared/file', async ({ query }) => {
  const rel = query.get('path')
  if (!rel) throw new HttpError(400, 'path is required')
  const abs = inWorkspace(requireWorkspace(), () => assertInShared(rel))
  return { path: rel, ...(await readNote(abs).catch(() => { throw new HttpError(404, 'Not found') })) }
})

route('PUT', '/v1/shared/file', async ({ query, body }) => {
  const rel = query.get('path') ?? body?.path
  if (!rel) throw new HttpError(400, 'path is required')
  const abs = inWorkspace(requireWorkspace(), () => assertInShared(rel))
  // Workspace notes reach every agent at launch (#1433): the user's and the Assistant's to write, never a project agent's.
  if (agentCaller() && resolvePath(abs).toLowerCase() === resolvePath(inWorkspace(requireWorkspace(), () => workspaceNotesFile(workspace.sharedDir))).toLowerCase()) {
    throw new HttpError(403, `The shared note "${WORKSPACE_NOTES_PATH}" is the user's and the Hive Assistant's: project agents read it but don't change it. Tell the user what it should say.`)
  }
  const content = String(body?.content ?? '')
  // Only a write that leaves it out is unguarded: one given (null, empty, not a string) must be a revision.
  const expected: unknown = body && typeof body === 'object' && 'expectedRevision' in body ? body.expectedRevision : undefined
  if (expected !== undefined && (typeof expected !== 'string' || !expected)) throw new HttpError(400, 'expectedRevision must be the revision reading the note gave; nothing was written')
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
  if (!path) throw new HttpError(400, 'path is required: a project file ("docs/PLAN.md") or a shared note ("shared:plans/plan.md")')
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
    if (!name && !own) throw new HttpError(400, 'project is required for a project file (or a shared note: shared:<path>)')
    const p = name ? projectByName(name) : own!.projectPath
    // An agent: its own project only. The Assistant: its own workspace's (projectByName).
    ownProjectOnly(p, "Reading a project's documents")
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
    outside: `${path} isn't inside ${path.startsWith(SHARED_PREFIX) ? 'the shared notes' : 'the project'}: give a path relative to it`,
    hidden: `${path} is in Hive's or git's own folder: read shared notes as shared:<path>`,
    notMarkdown: `${path} isn't a Markdown file (.md)`,
    notFound: `Not found: ${path}`,
    tooBig: `${path} is over ${Math.round(DOC_MAX / 1048576)} MB`
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
  const list = (hs: DocHeading[]): string => hs.map((h) => `#${h.slug} (${h.text}, line ${h.line})`).join(', ')
  if ('ambiguous' in found) throw new HttpError(409, `Several sections of ${ref} are called "${asked}": ${list(found.ambiguous)}. Ask for one as #<slug>.`, { matches: found.ambiguous.map(headingRow) })
  if ('closest' in found) throw new HttpError(404, found.closest.length ? `No section "${asked}" in ${ref}. Closest: ${list(found.closest)}.` : `${ref} has no headings.`, { closest: found.closest.map(headingRow) })
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
 * Who is writing a handover, for its header: the Assistant (its own token), or the agent whose hive tools sent
 * it (they pass its id and project). Others (scripts, the user) leave no author.
 */
async function handoverAuthor(body: any): Promise<HandoverAuthor | null> {
  const own = assistantCaller()
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
  if (!body?.title || !body?.content) throw new HttpError(400, 'title and content are required')
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
  return { kind: 'agent', name: 'Agent API' }
}

/**
 * A card with what its agent is doing now (and its name now), for callers deciding what to do next. `agents` keeps
 * each project's agents for a whole list, so a long board reads each project.json once.
 */
/** A card's merge-queue line (#1354, queueState.ts), when its project has a workflow and its rules say Hive merges it. */
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

async function taskView(c: TaskCard, agents =new Map<string, Promise<ReturnType<typeof projectAgents>>>(), waitingOf?: ReadonlyMap<number, ForYouItem[]>): Promise<TaskView> {
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
  // for its cost in Hive's window: left out.
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
    stalled: cardStall(c, now, workspace.path, lane && inLane ? laneOrderView(lane, (n) => inLane.get(n)) : null, await stepWaitOf(workspace, c))
  }
  // A review whose reviewer has gone or isn't running (Hive ends those, but one can show while that happens).
  if (c.review && c.project) {
    try {
      const p = projectByName(c.project)
      const key = p.toLowerCase()
      if (!agents.has(key)) agents.set(key, workspace.projectConfig(p).then(projectAgents))
      const def = (await agents.get(key)!).find((a) => a.id === c.review!.agent)
      const why = reviewStalled(c, def ? { name: def.name, running: !!sessions.liveFor(p, def.id) || isResuming(p, def.id) } : null)
      if (why) view.reviewStalled = why
    } catch {
      view.reviewStalled = `${c.review.agentName} was removed.`
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
  // Who merges it and where it is with the merge queue, by its own rules (#1354): additive, only when Hive merges it.
  const merge = c.project && !c.archived ? await queueLineFor(c.project, c.number) : null
  // A code card's checks before review and how to run one (HI-2276): additive, only when its rules name some.
  const checks = c.project && !c.archived ? await checksFor(c.project, c.number) : null
  const attachments = files.length ? files.map((a) => attachmentForAgents(a, c)) : null
  return { ...(elsewhere.length ? { ...view, elsewhere } : view), ...(attachments ? { attachments } : {}), ...(k ? { kind: k.kind, ...(k.kindProposed ? { kindProposed: k.kindProposed } : {}) } : {}), ...(rs?.skip ? { reviewSkipped: rs.skip } : {}), ...(rs?.proposed != null ? { reviewSkipProposed: rs.proposed } : {}), stage, ...(merge ? { merge } : {}), ...checks }
}

/** A card attachment as agents read it (HI-1700): its path, name and size, who added it and when, and where it came. */
function attachmentForAgents(a: CardAttachment, c: TaskCard): NonNullable<TaskView['attachments']>[number] {
  const said = a.comment && a.comment !== 'description' && a.comment !== 'pane' ? c.comments.find((x) => x.id === a.comment) : undefined
  const from = said ? `comment by ${said.by} at ${said.at}` : a.comment === 'description' ? 'description' : a.comment === 'pane' ? 'attached from a session' : a.comment ? 'a comment no longer on the card' : 'attached to the card' // i18n-ignore: agent-facing
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
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string' || !x)) throw new HttpError(400, 'attachments is a list of file paths (strings).')
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
    if (!known) throw new HttpError(404, `Unknown project "${project}"`)
    if (agent && basename(agent.projectPath).toLowerCase() !== project.toLowerCase()) throw new HttpError(403, `Cards stay in your project (${basename(agent.projectPath)}).`)
  } else if (agent) throw new HttpError(403, `Cards stay in your project (${basename(agent.projectPath)}).`)
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
const attachedLines = (c: TaskCard & { attached?: { name: string; path: string; added: boolean }[] }): string[] => (c.attached ?? []).map((a) => `${a.added ? 'Attached' : 'Already attached'}: ${a.name} (${a.path})`)

/** The short reply a hive tool asks for (reply: "short") instead of the whole card or column. */
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
    if (n === null) throw new HttpError(404, `Unknown card ${ref}`)
    return n
  }
  const n = Number(ref.replace(/^#/, ''))
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, `"${v}" is not a card number or key (12, #12 or HI-12)`)
  return n
}

/**
 * A card reference in a request's body (#1219): a key (`"HI-12"`) or `"#12"` becomes the card's number; a number, or
 * anything else, is left as it is for the route's own check (a key no card has is 404).
 */
function cardRefIn(v: unknown): unknown {
  if (typeof v !== 'string' || !isCardRef(v) || /^\d+$/.test(v.trim())) return v
  const n = cardOfRef(requireWorkspace(), v, callerScope())
  if (n === null) throw new HttpError(404, `Unknown card ${v.trim()}`)
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

/** How a reply's text names these cards (#1219), for the hive MCP server that words it: `names`, or nothing. */
const withNames = (numbers: number[]): { names?: Record<string, string> } => {
  const names = namesOf(numbers)
  return names ? { names } : {}
}

function columnParam(v: unknown): TaskColumn | undefined {
  if (v === undefined || v === null || v === '') return undefined
  if (!isTaskColumn(v)) throw new HttpError(400, `Unknown column "${String(v)}": ${COLUMN_CHOICES}.`)
  return v
}

/** The fields of a request body a card change may set. */
function taskPatch(body: any): TaskPatch {
  const out: TaskPatch = {}
  // Archiving is the user's (#351), one card or a batch: no call of the Agent API's makes it.
  if (body?.archived !== undefined) throw new HttpError(403, 'Only the user archives cards or brings them back, from the board: ask the user.')
  for (const k of ['title', 'description', 'project', 'blocked'] as const) if (body?.[k] !== undefined) out[k] = body[k] === null ? (null as never) : String(body[k])
  if (body?.agent !== undefined) out.agent = body.agent ? String(body.agent) : null
  if (body?.column !== undefined) out.column = columnParam(body.column)
  if (body?.before !== undefined) out.before = body.before === null ? null : Number(String(cardRefIn(body.before)).replace(/^#/, ''))
  if (body?.position !== undefined && body.position !== null && body.position !== '') {
    if (body.position !== 'top' && body.position !== 'bottom') throw new HttpError(400, `Unknown position "${String(body.position)}": top or bottom.`)
    out.position = body.position
  }
  for (const k of ['labels', 'addLabels', 'removeLabels', 'blockedBy', 'links', 'context'] as const) if (body?.[k] !== undefined) out[k] = k === 'blockedBy' || k === 'links' ? cardRefsIn(body[k]) : body[k]
  if (body?.decision !== undefined && body.decision !== null) out.decision = String(body.decision)
  // HI-1932: the open requests the decision answers, by id, as sent: never coerced (a nested list isn't an id), checked
  // (shape, who, each request) by the route and where it is recorded.
  if (body?.answers !== undefined && body.answers !== null) out.answers = body.answers as string[]
  if (body?.review !== undefined && body.review !== null && body.review !== '') {
    if (body.review !== 'start' && body.review !== 'passed' && body.review !== 'failed') throw new HttpError(400, `Unknown review "${String(body.review)}": start, passed or failed.`)
    out.review = body.review
  }
  if (body?.override !== undefined && body.override !== null) out.override = overrideParam(body.override)
  return out
}

/** A move's override (#1265, SPEC §16.8.4): `{ reason }`, the Assistant's, why it moves the card across the rules. */
export function overrideParam(v: unknown): { reason: string } {
  const reason = v && typeof v === 'object' ? (v as { reason?: unknown }).reason : undefined
  if (typeof reason !== 'string' || !reason.trim()) throw new HttpError(400, 'override is { "reason": "<why>" }, the reason not empty.')
  return { reason: reason.trim() }
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
  return short ? views.map(taskRow) : views
})

route('GET', '/v1/tasks/:n', async ({ params, query }) => {
  requireWorkspace()
  // The card with its decision generation, read together (#1216): what this reply gives an agent is what its receipt records.
  const seen = await tasks.readTaskSeen(taskNumber(params[0]), await taskActor())
  const view = await taskView(seen.card)
  // Read in full, decisions included: those aren't new to the agent any more (#357).
  const me = agentCaller()
  if (me) {
    noteCardRead(me, view.number)
    // What it has received of the card's decisions, as a fact (#1216), in the background: the generation read with this
    // reply's decisions, never one written since.
    const ws = contextWorkspace()
    if (ws) void recordDecisionsReceived(ws, me.agentId, view.number, seen.generation, view.project)
  }
  const raw = query.get('comments')
  const n = raw === null ? null : Number(raw)
  if (n !== null && (!Number.isInteger(n) || n < 1)) throw new HttpError(400, `comments must be a whole number from 1: "${raw}"`)
  const lean = n === null ? view : newestComments(view, n)
  // summary=true (#532): each comment as its first line, with the whole comment's length when there is more; its open
  // requests' words too (HI-1992).
  const told = query.get('summary') === 'true' ? { ...lean, ...(lean.forYou ? { forYou: lean.forYou.map(commentSummary) } : {}), comments: lean.comments.map(commentSummary) } : lean
  return query.get('history') === 'false' ? withoutHistory(told) : told
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
  if (typeof o.builder !== 'string' || !o.builder.trim()) throw new HttpError(400, 'lane is the builder whose running lane takes the card ("HB1"), or { builder, reviewer, brief, name, position } to start one if it has none')
  for (const k of Object.keys(o)) if (!['builder', 'reviewer', 'brief', 'name', 'position'].includes(k)) throw new HttpError(400, `lane takes builder, reviewer, brief, name and position, not ${k}`)
  if (o.position !== undefined && o.position !== 'last' && o.position !== 'next') throw new HttpError(400, "lane's position is last (the default) or next (before its first card still in Todo)")
  if (input.column !== undefined && input.column !== 'todo') throw new HttpError(400, 'A card placed on a lane is made in Todo: leave column out')
  const project = typeof input.project === 'string' && input.project ? input.project : null
  if (!project) throw new HttpError(400, 'A card placed on a lane needs its project')
  const p = laneProject(project)
  const builder = await agentParam(p, o.builder.trim())
  const a = agentCaller()
  if (a && builder !== a.agentId) throw new HttpError(403, "An agent places a new card on its own lane only, as its builder: another builder's lane is theirs, the Assistant's or the user's")
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

route('POST', '/v1/tasks', async ({ body }) => {
  requireWorkspace()
  const title = String(body?.title ?? '').trim()
  if (!title) throw new HttpError(400, 'title is required')
  const input = { title, description: body?.description, project: body?.project, agent: body?.agent, column: columnParam(body?.column), labels: body?.labels, blocked: body?.blocked, blockedBy: cardRefsIn(body?.blockedBy), links: cardRefsIn(body?.links), context: body?.context, ...(body?.kind !== undefined ? { kind: body.kind } : {}), ...(body?.skipReview !== undefined ? { skipReview: body.skipReview as string } : {}) }
  const actor = await taskActor()
  // Placed on a lane as it is made (HI-2167): checked before the card is made; placed after, through hive_lane start's
  // own path, so nobody guesses its key.
  const lane = await lanePlacement(body?.lane, input)
  // Files to keep with it (HI-1700): the list checked now; copied inside the operation that makes the card, once its
  // project is known to be allowed, and published with it.
  const paths = attachmentList(body)
  const create = () => withAttachments(paths, typeof input.project === 'string' && input.project ? input.project : callerScope(), (files) => tasks.changeWithAttachments(actor, files, 'description', () => tasks.createTask(input, actor)))
  // A long title is kept, with a line suggesting a shorter one (HI-1872), or one with what belongs in the description (HI-2061).
  const nudge = titleNudge(title, actor, titleKeys())
  const reply = async (c: TaskCard) => ({ ...(shortReply(body) ? await taskChange(c, attachedLines(c)) : await taskView(c)), ...(nudge ? { nudge } : {}) })
  // Placed once it is made (the Assistant's: its own change, as hive_lane start is), never inside the card's own change.
  const placing = async <R extends { number: number }>(r: R) => (lane ? { ...r, ...(await placeOnLane(lane, r.number)) } : r)
  if (actor.kind !== 'assistant') return placing(await reply(await create()))
  const project = typeof input.project === 'string' && input.project ? input.project : null
  // Made in Doing with nobody on it (HI-2062): refused before the user is asked to approve it (checked again as it is made).
  if (project && input.column === 'doing' && !input.agent) throw new tasks.TaskConflictError(tasks.DOING_NOBODY_NEW)
  const given = await knownAgent(project, input.agent)
  return placing(await assistantChange('agents', `add the task "${clip(title, 60)}" to the board`, { kind: 'create-task', ...(project ? { project } : {}), ...(given ? { agent: given } : {}) }, async () => {
    const c = await create()
    return { done: `Added ${cardName(c)} to the board${c.project ? ` (${c.project})` : ''}: ${clip(c.title, 80)}`, act: { card: c.number, column: c.column, ...(c.project ? { project: c.project } : {}), agent: await cardAgent(c) }, result: await reply(c) }
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
  if (patch.answers !== undefined) tasks.checkDecisionAnswers(actor, body.answers, ['kind', 'confirmKind', 'skipReview', 'attachments'].some((k) => body[k] !== undefined))
  const changes: string[] = []
  // Its kind (#1277): changed after it was made (the Assistant's, with override.reason), or an agent's proposal answered.
  const kind = body?.kind
  const confirmKind = body?.confirmKind
  if (confirmKind !== undefined && typeof confirmKind !== 'boolean') throw new HttpError(400, 'confirmKind is true (make it no-code, as proposed) or false (keep it as code).')
  // Checked before anything is written (HR3's #1277 round 1): a kind no card has is refused whole.
  if (kind !== undefined) tasks.kindOf(kind)
  // The override's reason is the kind change's when no column moves with it.
  if (kind !== undefined && patch.column === undefined) delete patch.override
  // Whether it skips review (#1625): the user's reason (the Assistant's), or false; checked before anything is written.
  const skipReview = body?.skipReview === undefined ? undefined : tasks.reviewSkipArg(body.skipReview)
  const write = async (commit?: () => void): Promise<TaskCard> => {
    if (confirmKind !== undefined) {
      await tasks.confirmKind(n, confirmKind, actor, { commit })
      changes.push(confirmKind ? 'Confirmed as no code' : 'Kept as code')
    }
    if (kind !== undefined) {
      await tasks.setKind(n, kind, actor, { commit, reason: body?.override && typeof body.override === 'object' ? String((body.override as { reason?: unknown }).reason ?? '') : '' })
      changes.push(`Kind: ${kind}`)
    }
    if (skipReview !== undefined) {
      await tasks.setReviewSkip(n, skipReview !== false, actor, { commit, reason: skipReview || '' })
      changes.push(skipReview !== false ? 'Skips review' : 'Reviewed')
    }
    // A change and its comment are saved together: a card watch woken by the change names this comment.
    const c = Object.keys(patch).length ? await tasks.updateTask(n, patch, actor, { said: changes, comment: comment || undefined, commit }) : comment ? await tasks.commentTask(n, comment, actor) : await tasks.readTask(n, actor)
    if (comment) changes.push('Commented')
    return c
  }
  // Files to keep with it (HI-1700), with its comment if it has one: checked and copied first, published in its change.
  if (body?.attachments !== undefined && patch.project !== undefined) throw new HttpError(400, 'Move the card to the other project first, then attach files to it.')
  const paths = attachmentList(body)
  // A change of its kind with anything else is one board change (HR3's #1277 round 1): refused part way, none of it.
  const once = (commit?: () => void): Promise<TaskCard> => (kind !== undefined || confirmKind !== undefined || skipReview !== undefined ? tasks.cardBatch(workspace, () => write(commit)) : write(commit))
  const apply = async (commit?: () => void): Promise<TaskCard> => {
    // Its files copied here, inside the operation (the Assistant's: once admitted), to the card's own project.
    const c = await withAttachments(paths, paths ? ((await tasks.readTask(n, actor)).project ?? null) : null, (files) => tasks.changeWithAttachments(actor, files, comment ? 'comment' : 'description', () => once(commit)))
    changes.push(...attachedLines(c))
    return c
  }
  const nudge = patch.title === undefined ? null : titleNudge(patch.title, actor, titleKeys())
  const reply = async (c: TaskCard) => ({ ...(shortReply(body) ? await taskChange(c, changes) : await taskView(c)), ...(nudge ? { nudge } : {}) })
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
  if (was?.project && patch.column === 'doing' && was.column !== 'doing' && !patch.override && (patch.agent === undefined ? !was.agent : !patch.agent)) throw new tasks.WorkflowRefusedError(refusal('move.doingNobody', { card: cardRef(n), stage: 'active' }, 'the user or the Assistant')) // i18n-ignore: who can override, agent-facing (§16.8.3)
  const given = typeof patch.agent === 'string' ? await knownAgent(was?.project, patch.agent) : was ? await cardAgent(was) : undefined
  return assistantChange('agents', `change ${cardRef(n)} on the board`, { kind: 'update-task', card: n, ...(patch.column ? { column: patch.column } : {}), ...(was?.project ? { project: was.project } : {}), ...(given ? { agent: given } : {}) }, async (commit) => {
    const before = await tasks.getTask(n)
    const placed = (patch.before !== undefined && patch.before !== null) || patch.position !== undefined
    const c = await apply(commit)
    const at = patch.position ? `at the ${patch.position}` : placed ? `before ${typeof patch.before === 'number' ? cardRef(patch.before) : patch.before}` : ''
    const what = [
      patch.column && patch.column !== before.column
        ? `moved it to ${columnLabel(patch.column)}${at ? `, ${at}` : ''}`
        : patch.position
          ? `moved it to the ${patch.position} of ${columnLabel(c.column)}`
          : at
            ? `moved it ${at}`
            : '',
      comment ? 'commented' : '',
      patch.decision !== undefined ? 'recorded a decision' : '',
      confirmKind !== undefined ? (confirmKind ? 'confirmed it as no code' : 'kept it as code') : '',
      kind !== undefined ? `made it ${kind}` : '',
      skipReview !== undefined ? (skipReview !== false ? 'set it to skip review' : 'set it to be reviewed') : '',
      Object.keys(patch).some((k) => k !== 'column' && k !== 'before' && k !== 'position' && k !== 'decision') ? 'changed it' : ''
    ]
      .filter(Boolean)
      .join(', ')
    return { done: `${cardName(c)} ${clip(c.title, 60)}: ${what || 'no change'}`, act: { column: c.column, ...(c.project ? { project: c.project } : {}), agent: await cardAgent(c) }, result: await reply(c) }
  })
})

/** A batch change (hive_update_tasks): checked by taskBatch; its refusals are the Agent API's statuses. */
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
  const refused: TaskBatch['refused'] = [...unknown.map((ref) => ({ number: 0, ref, error: `Unknown card ${ref}` })), ...items.filter((i) => !i.card).map((i) => ({ number: i.number, error: i.error ?? 'refused', ...i.refused }))]
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
  if (!column) throw new HttpError(400, 'column is required: hold, todo, doing, review or passed')
  const cards = cardRefsIn(body?.cards)
  const actor = await taskActor()
  const view = async (list: TaskCard[]): Promise<TaskView[] | TaskReorder> => {
    // Short: the agent chose the cards and their order; it only needs to know it worked.
    if (shortReply(body)) {
      const top = (cards as unknown[]).map((x) => Number(String(x).replace(/^#/, '')))
      return { column, top, count: list.length, ...withNames(top) }
    }
    const agents = new Map<string, Promise<ReturnType<typeof projectAgents>>>()
    return Promise.all(list.map((c) => taskView(c, agents)))
  }
  if (actor.kind !== 'assistant') return view(await tasks.reorderTasks(column, cards, actor))
  const count = Array.isArray(cards) ? cards.length : 0
  const ordered = Array.isArray(cards) ? cards.map((x) => Number(String(x).replace(/^#/, ''))).filter((x) => Number.isInteger(x) && x > 0) : []
  return assistantChange('agents', `put ${count} card${count === 1 ? '' : 's'} in order in ${columnLabel(column)}`, { kind: 'reorder-tasks', column, cards: ordered }, async () => {
    const list = await tasks.reorderTasks(column, cards, actor)
    const top = (cards as unknown[]).map((x) => cardRef(Number(String(x).replace(/^#/, '')))).join(', ')
    return { done: `Put ${top} at the top of ${columnLabel(column)}`, result: await view(list) }
  })
})

// Only a card's newest comment (its author, time and whole text), for "check the latest comment": the card's
// description, earlier comments and history stay out of the reply. A card without comments gives comment null.
// A card's attachment, read through Hive (HI-1751: the document tools refuse `.hive`, so a reviewer couldn't read the
// builder's evidence): a page of its text, or its kind and path for an image or a binary file. Only a card the caller may
// read (its scope, as GET /v1/tasks/:n), from that card's own folder.
route('GET', '/v1/tasks/:n/attachments/:name', async ({ params, query }) => {
  requireWorkspace()
  const c = await tasks.readTask(taskNumber(params[0]), await taskActor())
  let name: string
  try {
    name = decodeURIComponent(params[1] ?? '')
  } catch {
    throw new HttpError(400, "The attachment's name isn't a valid path segment: give it as hive_read_task lists it")
  }
  const r = await readCardAttachment(workspace, { number: c.number, project: c.project ?? null }, name, query.get('offset'))
  if (!('problem' in r)) return r
  const card = c.key ?? `#${c.number}`
  const choices = r.choices?.length ? `: ${r.choices.join(', ')}` : ''
  const why = {
    unknown: `${card} has no attachment called "${name}"${choices || ' (it has none)'}`,
    ambiguous: `Several of ${card}'s attachments are called "${name}": name one by its file${choices}`,
    missing: `${card}'s attachment "${name}" is listed, but its file is gone`,
    outside: `${card}'s attachment "${name}" isn't where its card keeps it, so it isn't read`,
    changed: `${card} or its attachment "${name}" changed while it was read: read the card again`,
    offset: `offset is a byte of the file: a whole number from 0 to ${r.size ?? 0}`
  }[r.problem] // i18n-ignore: agent-facing
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
  return { number: r.number, ...(forYou ? { forYou } : {}), comment: summary && r.comment ? commentSummary(r.comment) : r.comment }
})

// A card's facts (#1223, SPEC §16.4): a short row each (seq, kind, time, actor and a few words, revisions as its project's
// platform shows them); view=full gives them as recorded. None for a card from before 1.0, or on a board not upgraded.
route('GET', '/v1/tasks/:n/facts', async ({ params, query }) => {
  requireWorkspace()
  const view = query.get('view') ?? 'short'
  if (view !== 'short' && view !== 'full') throw new HttpError(400, `Unknown view "${view}": short or full.`)
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
    return detect(workspace.path!).platform
  }
}

route('POST', '/v1/tasks/:n/comments', async ({ params, body }) => {
  requireWorkspace()
  const n = taskNumber(params[0])
  const text = typeof body?.text === 'string' ? body.text : ''
  const actor = await taskActor()
  const paths = attachmentList(body)
  const comment = async () => withAttachments(paths, paths ? ((await tasks.readTask(n, actor)).project ?? null) : null, (files) => tasks.changeWithAttachments(actor, files, 'comment', () => tasks.commentTask(n, text, actor)))
  const reply = async (c: TaskCard) => (shortReply(body) ? taskChange(c, ['Commented', ...attachedLines(c)]) : taskView(c))
  if (actor.kind !== 'assistant') return reply(await comment())
  return assistantChange('agents', `comment on ${cardRef(n)}`, { kind: 'comment-task', card: n }, async () => ({ done: `Commented on ${cardRef(n)}`, result: await reply(await comment()) }))
})

/** Bounded waits running now, per caller (an agent, the Assistant, a script): at most WAITS_PER_CALLER at a time. */
const taskWaits = new Map<string, number>()
const WAITS_PER_CALLER = 2

/**
 * Waiting on cards (#128). `wake: true`: the calling agent (or the Assistant) registers a watch and ends its turn; Hive
 * types one line into it when a watched card changes (main/watches.ts). `cancel: true`: ends its watch. Otherwise the
 * call waits itself, up to its longest (Settings → Advanced, #367), for a change since `since` (or since the call), driven by the board's
 * change events (no polling). A project agent waits only on its own project's cards.
 */
/**
 * A usage watch's accounts (HI-2195): each { account (its id or name), percent (1 to 100), limit (weekly, fiveHour or any,
 * the default) }. A project agent names only accounts on in its workspace.
 */
function readUsageWatch(v: unknown, ws: WorkspaceService): UsageWatch[] {
  const shape = 'usage must be a list of { account, percent, limit? }, limit weekly, fiveHour or any'
  if (!Array.isArray(v) || !v.length) throw new HttpError(400, shape)
  if (v.length > USAGE_WATCH_MAX) throw new HttpError(400, `at most ${USAGE_WATCH_MAX} accounts in one usage watch`)
  const seen = agentCaller() ? hiveAccounts().filter((a) => accountOnIn(ws.config, a, allAccounts())) : hiveAccounts()
  return v.map((x: { account?: unknown; percent?: unknown; limit?: unknown }) => {
    if (!x || typeof x !== 'object' || typeof x.account !== 'string') throw new HttpError(400, shape)
    const percent = Number(x.percent)
    const limit = x.limit === undefined ? 'any' : x.limit
    if (!Number.isInteger(percent) || percent < 1 || percent > 100) throw new HttpError(400, 'percent must be a whole number from 1 to 100')
    if (limit !== 'weekly' && limit !== 'fiveHour' && limit !== 'any') throw new HttpError(400, shape)
    const byId = seen.find((a) => a.id === x.account)
    const byName = seen.filter((a) => a.name.toLowerCase() === String(x.account).toLowerCase())
    if (!byId && byName.length > 1) throw new HttpError(409, `Several accounts are named "${x.account}": use its id (${byName.map((a) => a.id).join(', ')}).`)
    const a = byId ?? byName[0]
    if (!a) throw new HttpError(404, `No account named "${x.account}": hive_connection list names them.`)
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
  if (!wsPath) throw new HttpError(409, 'The workspace was closed')
  const stillOpen = (): void => {
    if (life.aborted || !ws.path || ws.path.toLowerCase() !== wsPath.toLowerCase()) throw new HttpError(409, 'The workspace was closed')
  }
  stillOpen()
  const me = agentCaller()
  const home = assistantCaller() ? ws.assistantHome : null
  const who = me ? { projectPath: me.projectPath, agentId: me.agentId } : home ? { projectPath: home, agentId: 'assistant' } : null
  if (body?.cancel === true) {
    if (!who) throw new HttpError(400, 'Only an agent or the Assistant has a card watch to cancel.')
    const w = sessions.watchFor(who.projectPath, who.agentId)
    const had = await cancelWatch(ws, who.projectPath, who.agentId)
    return { done: had ? `Cancelled your ${w?.lanes ? 'lane' : w?.agents ? 'agent' : 'card'} watch.` : 'You had no card watch.' }
  }
  // A usage watch (HI-2195): accounts' limits reaching a share, alone or beside the cards or lanes; always one that wakes.
  const usage = body?.usage !== undefined ? readUsageWatch(body.usage, ws) : undefined
  if (usage !== undefined && (body.wake !== true || !who)) throw new HttpError(400, 'A usage watch wakes you (wake: true), for an agent or the Assistant.')
  if (usage && body.lanes === undefined && body.cards === undefined) {
    if (body.agents !== undefined || body.column !== undefined) throw new HttpError(400, 'usage goes alone, or beside cards or lanes')
    const limit = body?.limitMinutes === undefined ? WATCH_DEFAULT_LIMIT_MINUTES : Number(body.limitMinutes)
    if (!Number.isFinite(limit) || limit < 1 || limit > WATCH_MAX_LIMIT_MINUTES) throw new HttpError(400, `limitMinutes must be from 1 to ${WATCH_MAX_LIMIT_MINUTES}`)
    const r = await registerUsageWatch(ws, who!.projectPath, who!.agentId, usage, limit).catch((e: Error) => {
      throw new HttpError(e.message.startsWith('Not a project') ? 400 : 409, e.message)
    })
    const left = r.lanesLeft ? { lanesLeft: r.lanesLeft } : {}
    if ('already' in r) return { usageAlready: r.already, ...(r.replaced ? { replaced: r.replaced } : {}), ...left }
    return { watching: r.watching.label, limitAt: r.watching.limitAt, ...(r.replaced ? { replaced: r.replaced } : {}), ...left }
  }
  // Beside cards or lanes: added to the watch they start (one already answered starts none).
  const withUsage = async (label: string): Promise<string> => (usage ? ((await addUsageToWatch(ws, who!.projectPath, who!.agentId, usage))?.label ?? label) : label)
  // A lane watch (#531): whole lanes; always one that wakes. With cards beside them (#726): `cards` and their `changes`.
  if (body?.lanes !== undefined) {
    if (body.column !== undefined || body.fresh !== undefined) throw new HttpError(400, 'lanes goes without column or fresh: events says what counts on the lanes, changes on the cards beside them')
    const lc = readLaneCondition(body)
    if (typeof lc === 'string') throw new HttpError(400, lc)
    const extra = readLaneCards(body)
    if (typeof extra === 'string') throw new HttpError(400, extra)
    if (body.wake !== true || !who) throw new HttpError(400, 'A lane watch wakes you (wake: true), for an agent or the Assistant: a script waits on cards.')
    // Agents beside the lanes (HI-1987): each { project, agent }; left out, the last lane watch's are kept, [] drops them.
    let laneAgents: WatchedAgent[] | undefined
    if (body.agents !== undefined) {
      if (!Array.isArray(body.agents)) throw new HttpError(400, 'agents must be a list of { project, agent }')
      if (body.agents.length > AGENT_WATCH_MAX_AGENTS) throw new HttpError(400, `at most ${AGENT_WATCH_MAX_AGENTS} agents in one watch`)
      laneAgents = []
      for (const x of body.agents as { project?: unknown; agent?: unknown }[]) {
        if (!x || typeof x !== 'object' || typeof x.project !== 'string') throw new HttpError(400, 'agents must be a list of { project, agent }')
        const p = projectByName(x.project)
        const id = await agentParam(p, x.agent as string | undefined)
        if (!laneAgents.some((a) => resolvePath(a.projectPath).toLowerCase() === resolvePath(p).toLowerCase() && a.agentId === id)) laneAgents.push({ projectPath: p, agentId: id, name: (await agentDefOf(p, id)).name, project: basename(p) })
      }
      stillOpen()
    }
    const limit = body?.limitMinutes === undefined ? WATCH_DEFAULT_LIMIT_MINUTES : Number(body.limitMinutes)
    if (!Number.isFinite(limit) || limit < 1 || limit > WATCH_MAX_LIMIT_MINUTES) throw new HttpError(400, `limitMinutes must be from 1 to ${WATCH_MAX_LIMIT_MINUTES}`)
    // Each card named must be one the caller may see, as for a card watch.
    if (extra.cards?.length) {
      const actor = await taskActor()
      for (const n of extra.cards) await tasks.readTask(n, actor)
      stillOpen()
    }
    const r = await registerLaneWatch(ws, who.projectPath, who.agentId, lc, limit, { ...extra, ...(laneAgents ? { agents: { agents: laneAgents, ignoreBackground: false } } : {}) }).catch((e: Error) => {
      throw e instanceof HttpError ? e : new HttpError(/^(No such lane|Unknown task)/.test(e.message) ? 404 : /^(You can't watch yourself|Not a project)/.test(e.message) ? 400 : 409, e.message)
    })
    return { watching: await withUsage(r.watching.label), limitAt: r.watching.limitAt, events: lc.events, ...(r.replaced ? { replaced: r.replaced } : {}), ...(r.cards ? { cards: r.cards, ...withNames([...r.cards.now, ...(r.cards.replaced ?? []), ...(r.cards.dropped ?? [])]) } : {}), ...(r.agents ? { agents: r.agents } : {}) }
  }
  if (body?.agents !== undefined) throw new HttpError(400, 'agents goes with lanes (a lane watch, HI-1987): to watch agents alone, use hive_wait_for_agents (POST /v1/agents/wait)')
  const cond = readCondition(body ?? {})
  if (typeof cond === 'string') throw new HttpError(400, cond)
  // Each card must be one the caller may see (a project agent: its project's; others are unknown to it), and stays so:
  // the caller's scope goes with the wait, and every later read is checked against it.
  const actor = await taskActor()
  const scope = tasks.scopeOf(actor)
  for (const n of cond.cards) await tasks.readTask(n, actor)
  stillOpen()
  if (body?.wake === true) {
    if (!who) throw new HttpError(400, 'Only an agent or the Assistant can be woken: a script waits without wake (timeoutSeconds).')
    const limit = body?.limitMinutes === undefined ? WATCH_DEFAULT_LIMIT_MINUTES : Number(body.limitMinutes)
    if (!Number.isFinite(limit) || limit < 1 || limit > WATCH_MAX_LIMIT_MINUTES) throw new HttpError(400, `limitMinutes must be from 1 to ${WATCH_MAX_LIMIT_MINUTES}`)
    const r = await registerWatch(ws, who.projectPath, who.agentId, cond, limit)
    const left = r.lanesLeft ? { lanesLeft: r.lanesLeft } : {}
    // HI-2245: an agent's own cards in Review with commits past their submission: its reply says to hand them over first.
    const mine = me ? await unsubmittedOf(ws, me.projectPath, me.agentId, 'already' in r ? [r.already.number] : cond.cards) : []
    const unsubmitted = mine.length ? { unsubmitted: mine } : {}
    if ('already' in r) return { already: r.already, ...unsubmitted, ...left, ...withNames([r.already.number]) }
    return { watching: await withUsage(r.watching.label), limitAt: r.watching.limitAt, ...unsubmitted, ...left, ...(mine.length ? withNames(mine.map((u) => u.card)) : {}) }
  }
  const seconds = body?.timeoutSeconds === undefined ? 300 : Number(body.timeoutSeconds)
  // The longest is Settings → Advanced's (#367), under Codex's timeout for hive's tools.
  const maxSeconds = waitMaxSeconds('cards')
  if (!Number.isFinite(seconds) || seconds < 1) throw new HttpError(400, `timeoutSeconds must be from 1 to ${maxSeconds}`)
  const limitMs = Math.min(maxSeconds, seconds) * 1000
  let base: Map<number, CardMark> | null = null
  let sinceAt = Date.now()
  if (body?.since !== undefined) {
    const d = decodeSince(String(body.since))
    if (!d) throw new HttpError(400, 'since must be the since of an earlier reply')
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
  if (running >= WAITS_PER_CALLER) throw new HttpError(429, `You already have ${running} card waits running: wait for them to end.`)
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
      const onClose = (): void => fail(new HttpError(409, 'The workspace was closed'))
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
      const off = onHiveEvent((e) => {
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

/** What an intent is, in the Assistant's activity line. */
const INTENT_WORDS: Record<CardIntent['kind'], string> = {
  start: 'start',
  putBack: 'put back',
  submit: 'submit',
  declarePaths: 'declare the paths of',
  startReview: 'start the review of',
  verdict: 'give the verdict on',
  reportMerge: 'report the merge of',
  ask: 'ask the user about',
  cannot: 'report a rule blocking',
  request: 'ask the builder of',
  loopStep: 'take a card loop step on',
  focusedSkip: 'decide on the skipped focused tests of',
  removeFromQueue: 'take out of the merge queue',
  retryMerge: 'retry the merge of'
}

/** What an intent did, in the Assistant's activity line. */
const INTENT_DONE: Record<CardIntent['kind'], string> = {
  start: 'started',
  putBack: 'put back',
  submit: 'submitted',
  declarePaths: 'declared its paths',
  startReview: 'started its review',
  verdict: 'gave the verdict',
  reportMerge: 'reported its merge',
  ask: 'asked the user',
  cannot: 'reported a rule blocking it',
  request: 'asked its builder',
  loopStep: 'took a card loop step',
  focusedSkip: 'decided on its skipped focused tests',
  removeFromQueue: 'taken out of the merge queue',
  retryMerge: 'queued again (Retry merge)'
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

async function cardIntent(param: string, intent: CardIntent): Promise<IntentDone> {
  requireWorkspace()
  const ref = intentRef(param)
  const actor = await taskActor()
  if (actor.kind !== 'assistant') {
    const { done, card } = await runCardIntent(ref, actor, intent)
    const copy = await reviewCopyAfter(actor, card, { start: intent.kind === 'startReview', verdict: intent.kind === 'verdict' })
    // A lane's handoff arms its agent's watch (#1639): a builder's submission, a reviewer's failed verdict.
    const self = actor.kind === 'agent' ? actor.self : undefined
    const watch = self ? await armIntentWatch(requireWorkspace(), self.agentId, card, { submit: intent.kind === 'submit', failed: intent.kind === 'verdict' && !intent.pass }) : null
    const out = watch ? { ...done, watch } : done
    // The copy first (#1444): a CLI that shortens a long reply (Codex's code tool) still shows where to review.
    return copy ? { ...out, data: { reviewCopy: copy, ...out.data } } : out
  }
  const was = await tasks.getTask(ref.n).catch(() => null)
  const what = INTENT_WORDS[intent.kind]
  return assistantChange('agents', `${what} ${cardRef(ref.n)}`, { kind: 'update-task', card: ref.n, ...(was?.project ? { project: was.project } : {}) }, async () => {
    const { done, card } = await runCardIntent(ref, actor, intent)
    const moved = done.from && done.to && done.from !== done.to ? `, ${done.from} → ${done.to}` : ''
    return { done: `${cardName(card)} ${clip(card.title, 60)}: ${INTENT_DONE[intent.kind]}${moved}`, act: { column: card.column, agent: await cardAgent(card) }, result: done, ...(INTENT_STAYS[intent.kind] ? { stays: INTENT_STAYS[intent.kind] } : {}) }
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
    if (required) throw new HttpError(400, `${key} is required.`)
    return undefined
  }
  if (typeof v !== 'string') throw new HttpError(400, `${key} is text.`)
  return v.trim()
}

/** A body's list of paths (declare-paths, submit): text each, none empty. */
function pathsField(body: any, required: boolean): string[] | undefined {
  const v = body?.paths
  if (v === undefined || v === null) {
    if (required) throw new HttpError(400, 'paths is required: a list of paths, relative to the project.')
    return undefined
  }
  if (!Array.isArray(v) || v.some((p) => typeof p !== 'string' || !p.trim())) throw new HttpError(400, 'paths is a list of paths, relative to the project.')
  return v.map((p: string) => p.trim())
}

/** A submit's focused tests (G20, HI-1367), when given: ids or { id, needs }, unique, each a valid id. */
function testsField(body: any): FocusedTest[] | undefined {
  if (body?.tests === undefined || body?.tests === null) return undefined
  const t = testsGiven(body.tests)
  if ('bad' in t) throw new HttpError(400, `tests: ${t.bad}. Give the test ids the change needs, each a string or { id, needs } (needs: unit, fake, real, packaged).`) // i18n-ignore: agent-facing
  return t.tests
}

/** A body's submission number (start-review, verdict), when given. */
function submissionField(body: any): number | undefined {
  const v = body?.submission
  if (v === undefined || v === null) return undefined
  if (!Number.isInteger(v) || v < 1) throw new HttpError(400, 'submission is a submission number (1, 2…).')
  return v
}

/** The most steps an ask's Test checklist has, and the longest a step is. */
const CHECKLIST_MAX = 20
const CHECKLIST_STEP_MAX = 500

/** An ask's Test checklist (#1267): the steps the user is asked to try, text each, none empty. */
function checklistField(body: any): { checklist?: string[] } {
  const v = body?.checklist
  if (v === undefined || v === null) return {}
  if (!Array.isArray(v) || !v.length || v.length > CHECKLIST_MAX || v.some((x) => typeof x !== 'string' || !x.trim() || x.length > CHECKLIST_STEP_MAX)) throw new HttpError(400, `checklist is a list of 1 to ${CHECKLIST_MAX} steps, each text of at most ${CHECKLIST_STEP_MAX} characters.`)
  return { checklist: v.map((x: string) => x.trim()) }
}

/** The longest an offered action's reason is (#1630), as an override's. */
const ASK_REASON_MAX = 1000

/** The actions an ask offers the user on its card (#1630): known kinds, each once, with an optional reason. */
function actionsField(body: any): { actions?: AskAction[] } {
  const v = body?.actions
  if (v === undefined || v === null) return {}
  const bad = (): HttpError => new HttpError(400, `actions is a list of 1 to ${ASK_ACTIONS_MAX} actions, each {kind: ${ASK_ACTIONS.join(', ')}; reason?: text of at most ${ASK_REASON_MAX} characters}, each kind once.`)
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
    if (body?.followUp !== undefined && body?.followUp !== null && typeof body.followUp !== 'boolean') throw new HttpError(400, 'followUp is true or false.')
    const tests = testsField(body)
    return { kind: 'submit', summary: textField(body, 'summary', true), revision: textField(body, 'revision'), note: textField(body, 'note'), paths: pathsField(body, false), ...(body?.followUp === true ? { followUp: true } : {}), ...(tests ? { tests } : {}) }
  },
  'declare-paths': (body) => ({ kind: 'declarePaths', paths: pathsField(body, true)! }),
  'start-review': (body) => ({ kind: 'startReview', submission: submissionField(body) }),
  verdict: (body) => {
    if (body?.pass !== true && body?.pass !== false) throw new HttpError(400, 'pass is true or false.')
    const failKind = body?.failKind ?? undefined
    if (failKind !== undefined && failKind !== 'content' && failKind !== 'explanation') throw new HttpError(400, `Unknown failKind "${String(failKind)}": content or explanation.`)
    return { kind: 'verdict', pass: body.pass, comment: textField(body, 'comment', true), submission: submissionField(body), failKind }
  },
  'report-merge': (body) => ({ kind: 'reportMerge', result: textField(body, 'result') }),
  'focused-skip': (body) => {
    if (body?.merge !== true && body?.merge !== false) throw new HttpError(400, 'merge is true or false.')
    return { kind: 'focusedSkip', request: textField(body, 'request', true)!, merge: body.merge, why: textField(body, 'why', true)! }
  },
  ask: (body) => {
    const askKind = body?.kind ?? 'other'
    if (!ASK_KINDS.includes(askKind)) throw new HttpError(400, `Unknown kind "${String(askKind)}": ${ASK_KINDS.join(', ')}.`)
    const revision = textField(body, 'revision')
    if (revision !== undefined && (revision.length > 200 || /\s/.test(revision))) throw new HttpError(400, 'revision is one revision (a commit id), with no spaces.')
    return { kind: 'ask', askKind, text: textField(body, 'text', true), ...(revision ? { revision } : {}), ...checklistField(body), ...actionsField(body) }
  },
  cannot: (body) => ({ kind: 'cannot', rule: textField(body, 'rule', true), why: textField(body, 'why', true) }),
  request: (body) => ({ kind: 'request', text: textField(body, 'text', true) }),
  'loop-step': (body) => {
    const step = body?.step
    if (!LOOP_STEPS.includes(step)) throw new HttpError(400, `Unknown step "${String(step)}": ${LOOP_STEPS.join(', ')}.`)
    // An answer and going ahead name the design or follow-up they are about (its reply's `design`), so a late one never
    // settles another.
    const design = step === 'design' || step === 'followUp' ? undefined : textField(body, 'design', true)
    return { kind: 'loopStep', step, text: textField(body, 'text', true), ...(design ? { design } : {}) }
  }
}
for (const [path, intentOf] of Object.entries(INTENT_ROUTES)) route('POST', `/v1/tasks/:n/${path}`, async ({ params, body }) => cardIntent(params[0], intentOf(body)))

// An agent asks the Hive Assistant on a card (HI-1866): its comment, and the Assistant's inbox. An agent's alone: the
// Assistant has its own tools, and the user acts on the board.
route('POST', '/v1/tasks/:n/ask-assistant', async ({ params, body }) => {
  const ws = requireWorkspace()
  const ref = intentRef(params[0])
  const actor = await taskActor()
  if (actor.kind !== 'agent' || !actor.self) throw new HttpError(403, "Only a project's agents ask the Hive Assistant on a card.")
  const text = textField(body, 'text', true)
  // An agent's plain number is refused, naming the card's key (S48), as for the intents.
  if (ref.plain) throw new tasks.WorkflowRefusedError(refusal('card.plainNumber', { key: (await tasks.readTask(ref.n, actor)).key ?? `#${ref.n}` }, null))
  try {
    const { card, id } = await askAssistant(ws, ref.n, actor, text)
    return { ok: true, card: card.key ?? cardRef(ref.n), delivery: id }
  } catch (e) {
    if (e instanceof AskRefused) throw new HttpError(e.status, e.message)
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
  if (body?.worktree || body?.existingWorktree || body?.branch || body?.base || (body?.location && body.location !== 'project')) throw new HttpError(400, NOT_PINNED)
  // A new agent's connection (HI-2121, as hive_add_agent's: decisions A and D): the one named, else the first usable here.
  if (body?.agent && body?.connection !== undefined) throw new HttpError(400, 'connection is for a new agent: an existing agent runs on its own (hive_update_agent changes it).')
  const conn = !body?.agent && card.project && ws.path ? connectionArg(body, join(ws.path, card.project)) : undefined
  // Decision D (HI-2108): provider, model, effort, mode and context are a connection's now, refused naming those there.
  refuseOldFields(body, getConnection(conn?.connection)?.account ?? firstUsableAccount(ws.path ? ws.config : null)?.id)
  if (conn?.cli && !isProviderEnabled(config.settings, conn.cli)) throw new HttpError(409, `${providerName(conn.cli)} is turned off in Settings → Providers.`)
  const target: TaskStartTarget = body?.agent
    ? { kind: 'agent', agentId: String(body.agent) }
    : { kind: 'new-agent', name: body?.name ? String(body.name) : undefined, ...(conn?.connection ? { connection: conn.connection } : {}) }
  // The agent it is started on, when it exists (a new one is named once added).
  const named = target.kind === 'agent' ? await knownAgent(card.project, target.agentId) : undefined
  return assistantChange('agents', `start ${cardRef(n)} ${target.kind === 'agent' ? `on ${named?.name ?? 'an agent'}` : 'on a new agent'}${card.project ? ` in ${card.project}` : ''}`, { kind: 'start-task', card: n, ...(card.project ? { project: card.project } : {}), ...(named ? { agent: named } : {}) }, async () => {
    const r = await startTask(n, target, { kind: 'assistant' }, typeof body?.note === 'string' ? body.note : undefined)
    return {
      done: `Started ${cardRef(n)} on ${r.added ? 'a new agent, ' : ''}${r.agentName} in ${card.project}: ${clip(card.title, 80)}`,
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
  ...(s.problem ? { problem: s.problem } : {}),
  ...(s.bundled ? { bundled: s.bundled } : {}),
  ...(s.updateAvailable ? { updateAvailable: s.updateAvailable } : {})
})

route('GET', '/v1/skills', async ({ query }) => {
  const project = query.get('project')
  if (project) {
    const p = projectByName(project)
    // A project's own skills are its agents' business (like its sessions).
    ownProjectOnly(p, "Listing a project's skills")
    // What the project's agents are given: not the Hive skills for the Assistant alone (as its Skills tab).
    return (await inWorkspace(workspaceOf(p), () => listSkills(p))).filter((s) => !(s.level === 'hive' && s.audience === 'assistant')).map(skillRow)
  }
  return (await inWorkspace(requireWorkspace(), () => listSkills())).map(skillRow)
})

/** Largest skill file the API returns; skills are instructions, not data. */
const SKILL_FILE_MAX = 512 * 1024

// One of the workspace's Hive skills: its SKILL.md and the files beside it, or (?file=) one of those files.
route('GET', '/v1/skills/:name', async ({ params, query }) => inWorkspace(requireWorkspace(), async () => {
  const name = decodeURIComponent(params[0])
  const skill = validSkillName(name) ? (await hiveSkills()).find((s) => s.name.toLowerCase() === name.toLowerCase()) : undefined
  if (!skill) throw new HttpError(404, `The workspace has no Hive skill "${name}"`)
  const file = query.get('file') ?? 'SKILL.md'
  // The whole path is checked before anything is read: relative, inside the skill's folder as written and as it
  // really is (a link can't lead out), and a file.
  const parts = file.replace(/\\/g, '/').split('/')
  if (!file || /^[a-z]:|^\//i.test(file) || parts.some((x) => x === '' || x === '.' || x === '..')) throw new HttpError(400, `"${file}" isn't a path inside the skill's folder`)
  const abs = join(skill.path, ...parts)
  if (!insideReal(abs, [skill.path])) throw new HttpError(400, `"${file}" isn't a path inside the skill's folder`)
  const info = await stat(abs).catch(() => null)
  if (!info?.isFile()) throw new HttpError(404, `The skill "${skill.name}" has no file "${file}"`)
  const tooBig = new HttpError(413, `"${file}" is larger than ${SKILL_FILE_MAX / 1024} KB`)
  if (info.size > SKILL_FILE_MAX) throw tooBig
  // What is read is capped too: the file may have grown since the stat.
  const read = await readCapped(abs, SKILL_FILE_MAX)
  if (read.more) throw tooBig
  const out = { name: skill.name, audience: skill.audience ?? 'agents', file: parts.join('/'), content: read.data.toString('utf8') }
  if (query.get('file')) return out
  const list = await skillFiles(skill.path)
  return { ...out, files: list.files, ...(list.truncated ? { filesTruncated: true } : {}) }
}))

// This Hive's own API reference (docs/AGENT_API.md as it shipped), for clients that need more than the status.
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
    throw new HttpError(403, `An agent reads its own project's metrics: ?scope=project&project=${basename(agent.projectPath)}`)
  }
  const scope: MetricsQuery['scope'] = query.get('scope') === 'project' ? { kind: 'project', project: asked || (agent ? basename(agent.projectPath) : '') } : { kind: 'workspace' }
  if (scope.kind === 'project' && !scope.project) throw new HttpError(400, 'scope=project needs project')
  const role = query.get('role') ?? undefined
  if (role !== undefined && role !== 'agent' && role !== 'assistant' && role !== 'api') throw new HttpError(400, 'role must be agent, assistant or api')
  return metricsReport(w, { scope, from: query.get('from') ?? undefined, to: query.get('to') ?? undefined, trend: query.get('trend') === '1', role, provider: query.get('provider') || undefined, own: query.get('own') === '1' }).then((r) => metricsForAgents(withPersonaAliases(r)), (e) => {
    throw e instanceof HttpError ? e : new HttpError(400, (e as Error).message)
  })
})


/**
 * The hive MCP bridge's report of its tool calls (the final text each gave the model) and, once per start, its tool
 * list and instructions. From an agent's or the Assistant's own token only, attributed by that token (an agent's
 * project; the Assistant's workspace); checked and bounded: a report that isn't valid is refused, not stored.
 */
route('POST', '/v1/metrics/mcp', async ({ body }) => {
  const agent = agentCaller()
  const own = assistantCaller()
  if (!agent && !own) throw new HttpError(403, "Only the hive MCP bridge reports its calls, with an agent's or the Assistant's token")
  const h = metricsHandle(requireWorkspace())
  const project = agent ? basename(agent.projectPath) : null
  const role = agent ? 'agent' : 'assistant'
  const calls: unknown[] = Array.isArray(body?.calls) ? body.calls : []
  if (calls.length > MCP_REPORT_LIMITS.events) throw new HttpError(400, `At most ${MCP_REPORT_LIMITS.events} calls in one report`)
  let accepted = 0
  for (const c of calls) if (c && typeof c === 'object' && recordMcp(h, project, role, c as Record<string, unknown> as never)) accepted++
  // On the side of the launch its token is for (HI-2049), never the agent's next one; the Assistant's is none.
  const side = agent ? sessions.launchSide(agent.projectPath, agent.agentId, agentCallerRun()) : 'none'
  if (body?.catalog && typeof body.catalog === 'object' && recordCatalog(h, project, role, side, body.catalog)) accepted++
  return { accepted, refused: calls.length + (body?.catalog ? 1 : 0) - accepted }
})

/**
 * The hive MCP bridge says its CLI has connected it (#865): the launch whose token it calls with may be given Hive's
 * lines now (sessions.hiveToolsConnected). An agent's or the Assistant's own token only, for its own launch: a token
 * names one launch, so a bridge left from an earlier one is refused (its token has stopped working).
 */
route('POST', '/v1/launch/connected', async () => {
  const agent = agentCaller()
  if (agent) return { ok: sessions.hiveToolsConnected(agent.projectPath, agent.agentId, agentCallerRun() ?? undefined) }
  const ws = assistantCaller()
  const token = assistantCallerToken()
  if (!ws || !token) throw new HttpError(403, "Only the hive MCP bridge says it has connected, with an agent's or the Assistant's token")
  // The Assistant's token is its running launch's (a new one each start): an earlier launch's no longer matches.
  if (!assistant.isCurrentToken(ws, token)) throw new HttpError(403, "That is an earlier launch's token")
  return { ok: sessions.hiveToolsConnected(assistant.assistantHome(ws), ASSISTANT_AGENT_ID) }
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
  if (!body?.title) throw new HttpError(400, 'title is required')
  const target = await notifyTarget(body.target)
  toast(level, String(body.title).slice(0, 200), body.message ? String(body.message).slice(0, 2000) : undefined, undefined, body.source ? String(body.source) : 'agent', target)
  return { ok: true, ...(target ? { opens: target.kind === 'agent' ? target.name : target.label } : {}) }
})

/**
 * A notice's target (HI-1961): an agent (`agent`, its id or name, in `project`, by default the caller's own) whose pane
 * a click opens, or a card (`card`, its key) whose dialog it opens. At most one; one that isn't there is refused.
 */
async function notifyTarget(raw: unknown): Promise<ToastTarget | undefined> {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'target is { agent, project? } or { card }')
  const t = raw as { agent?: unknown; project?: unknown; card?: unknown }
  const agent = typeof t.agent === 'string' && t.agent ? t.agent : null
  const card = typeof t.card === 'string' || typeof t.card === 'number' ? String(t.card).trim() : ''
  if (agent && card) throw new HttpError(400, 'target is an agent or a card, not both')
  if (card) {
    const ws = requireWorkspace()
    const n = cardOfRef(ws, card, callerScope())
    if (n === null) throw new HttpError(404, `Unknown card ${card}`)
    const c = await tasks.getTask(n, ws)
    // Its workspace too: a card's number is its workspace's alone (HR6 round 1, finding 1).
    return { kind: 'card', number: n, label: cardLabel(c), projectPath: c.project && ws.path ? join(ws.path, c.project) : null, workspacePath: ws.path! }
  }
  if (!agent) throw new HttpError(400, 'target names an agent or a card')
  const own = agentCaller()
  const projectPath = typeof t.project === 'string' && t.project ? projectByName(t.project) : own?.projectPath
  if (!projectPath) throw new HttpError(400, 'Say which project the agent is in: target.project')
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
  if (life.aborted || ws.path?.toLowerCase() !== workspacePath.toLowerCase()) throw new HttpError(409, 'The workspace was closed')
}

async function progressCallerIn(workspacePath: string): Promise<ProgressCaller> {
  const a = agentCaller()
  if (a) {
    const cfg = await workspace.projectConfig(a.projectPath)
    const def = projectAgents(cfg).find((x) => x.id === a.agentId)
    return { source: 'agent', workspacePath, projectPath: a.projectPath, agentId: a.agentId, agentName: def?.name ?? a.agentId, provider: def ? agentProvider(def, config.settings) : null }
  }
  if (assistantCaller()) {
    const live = sessions.liveFor(join(workspacePath, HIVE_DIR, ASSISTANT_DIR), ASSISTANT_AGENT_ID)
    return { source: 'assistant', workspacePath, agentName: `Hive ${ASSISTANT_NAME}`, provider: live?.provider ?? null }
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
    throw e instanceof ProgressError ? new HttpError(e.status, e.message) : e
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
const NOT_READABLE = 'Not a developer console source you can read'

function consoleReader(): ConsoleReader {
  const a = agentCaller()
  if (a) return { kind: 'agent', projectPath: a.projectPath, agentId: a.agentId }
  const own = assistantCaller()
  return own ? { kind: 'assistant', workspace: own } : { kind: 'all' }
}

function consoleAllowed(): void {
  if (config.settings.agentApi.devConsole !== true) throw new HttpError(403, 'Reading the developer console is off: the user can turn it on in Settings → Agent API → Let agents read the developer console')
}

const consoleWorkspaceOf = (projectPath: string): string | null => workspaceFor(projectPath)?.path ?? null

/**
 * The source a console request names: source=hive or source=assistant (the request's workspace), or an agent (agent,
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
    if (which === 'hive') id = hiveSourceId(requireWorkspace().path!)
    else if (which === 'assistant') id = sessionSourceId(requireWorkspace().assistantHome, ASSISTANT_AGENT_ID)
    else if (which) throw new HttpError(400, 'source is hive or assistant; name an agent with agent (and project)')
    else if (!project && !agent) {
      if (!me) throw new HttpError(400, 'Say which source: agent (and project), source=assistant or source=hive')
      id = sessionSourceId(me.projectPath, me.agentId)
    } else {
      const p = project ? projectByName(project) : me?.projectPath
      if (!p) throw new HttpError(400, 'project is required with agent')
      id = sessionSourceId(p, await agentParam(p, agent ?? undefined))
    }
  } catch (e) {
    // An agent learns nothing of what it can't read: an unknown project or agent is refused as one it may not read.
    if (me && !(e instanceof HttpError && e.status === 400)) throw new HttpError(404, NOT_READABLE)
    throw e
  }
  if (!mayRead(consoleReader(), id, consoleWorkspaceOf)) throw new HttpError(404, NOT_READABLE)
  return id
}

/** A source as a reply names it (bounded names; whether an open console is capturing it, and how many events it holds). */
function consoleRow(s: ConsoleSource | undefined, id: string) {
  const kind = s?.kind ?? (id.startsWith('hive:') ? 'hive' : 'session')
  // `select` names it exactly as a read takes it (the agent's id and its project's own name), apart from the display
  // label, which is cut and masked: following a listing always reads the source it lists.
  const select = kind === 'hive' ? { source: 'hive' } : kind === 'assistant' ? { source: 'assistant' } : s?.agentId && s.project ? { agent: s.agentId, project: s.project } : undefined
  return { label: hiveName(s?.label ?? (kind === 'hive' ? 'Hive' : 'an agent'), 80), kind, ...(select ? { select } : {}), ...(s?.provider ? { provider: s.provider } : {}), capturing: devConsole.capturing(id), events: devConsole.count(id) }
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
    if (seqs.length > CONSOLE_DETAIL_MAX) throw new HttpError(400, `At most ${CONSOLE_DETAIL_MAX} events in full at a time`)
    const events = seqs.map((n) => devConsole.event(id, n)).filter((e): e is ConsoleEvent => !!e)
    return { source, events, missing: seqs.filter((n) => !events.some((e) => e.seq === n)) }
  }
  const kinds = (query.get('kinds') ?? '').split(',').map((k) => k.trim()).filter(Boolean)
  const unknown = kinds.filter((k) => !(CONSOLE_KINDS as readonly string[]).includes(k))
  if (unknown.length) throw new HttpError(400, `Unknown event kinds: ${unknown.slice(0, 5).map((k) => k.slice(0, 30)).join(', ')} (kinds are ${CONSOLE_KINDS.join(', ')})`)
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
    throw e instanceof ProgressError ? new HttpError(e.status, e.message) : e
  }
}

// What a run would run for (#1220), checked before its command starts: hive-progress calls it first, so a revision that
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
  // What a run for a card is checked against (#1222), read now: hive-progress starts its command after this reply, and
  // reports its start up to 2 s later. Its start takes it with the link.
  const bracket = await bracketFor(ws, link).catch((e) => (log.warn('could not read what a run is checked against', e), null))
  if (bracket) bracketResolved(id, bracket)
  return { ...publicLink(link, id), ...(iso ? { isolated: { lease: iso.lease, copy: iso.copy } } : {}) }
})

/**
 * An isolated check's copy (#1435): an agent's check for a card of its own project on Git, leased at the card's revision.
 * Refused (400) for anything else, with what to do; 409 with `wait` while no copy is free (hive-progress asks again).
 */
async function isolatedFor(ws: WorkspaceService, caller: ProgressCaller, link: RunLink, ticket?: string): Promise<{ project: string; lease: string; folder: string; copy: string }> {
  if (caller.source !== 'agent') throw new HttpError(400, "--isolated runs an agent's check in a copy of its own: run it in an agent's session")
  if (!link.check) throw new HttpError(400, '--isolated runs a check in a copy of its own: use it with --check <name>')
  if (link.card === null || !link.revision) throw new HttpError(400, "--isolated runs a check at its card's revision: name the card (--card), or work on one in Doing")
  const cfg = await ws.projectConfig(caller.projectPath).catch(() => null)
  // None has no check copies (OP-16): its remedy is running again once the deliverables are quiet.
  if (platformIdOf(caller.projectPath, cfg?.platform) !== 'git') throw new HttpError(400, "This project has no version control, so there are no check copies: run the check again without --isolated once nobody is changing the card's files")
  // Leased and set up apart from this request (a first setup takes minutes): `wait` with a ticket to ask again with.
  const got = await isolatedRequest(ws, caller.projectPath, linkOwner(caller), { card: link.card, revision: link.revision, agent: caller.agentId }, ticket)
  if ('wait' in got) throw new HttpError(409, `waiting for ${got.wait}`, { wait: got.wait, ...(got.ticket ? { ticket: got.ticket } : {}) })
  if ('refused' in got) throw new HttpError(400, got.refused)
  return { project: caller.projectPath, lease: got.lease.id, folder: got.folder, copy: got.copy }
}

// An isolated check's launcher put in its check copy's job before it runs the command (#1435): only by the agent the
// lease is for, while the lease is out.
route('POST', '/v1/progress/isolated', async ({ body }) => {
  const ws = requireWorkspace()
  const a = agentCaller()
  if (!a) throw new HttpError(403, "Only an agent's isolated check puts its launcher in a check copy's job")
  const b = bodyObject(body)
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : NaN)
  const req = { lease: typeof b.lease === 'string' ? b.lease : '', pid: num(b.pid), after: num(b.after), before: num(b.before) }
  if (!req.lease || !Number.isInteger(req.pid) || req.pid <= 0 || Number.isNaN(req.after) || Number.isNaN(req.before)) throw new HttpError(400, 'lease, pid, after and before are required')
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
    throw e instanceof ProgressError ? new HttpError(e.status, e.message) : e
  }
})

route('PATCH', '/v1/progress/:id', async ({ params, body }) =>
  progressCall<{ ok: true; ignored?: true }>({ ok: true, ignored: true }, (caller) => {
    progress.update(caller, decodeURIComponent(params[0]), bodyObject(body))
    return { ok: true }
  })
)

/** How long a finish waits for its run's record as a check, to say how it counted (#1654): hive-progress waits a little longer. */
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
  // How it counted as a check, once recorded (within CHECK_REPLY_MS): hive-progress says why one didn't (#1654).
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
    else if (!m.skip && m.handle) recordApi(m.handle, m.project, { route: m.route, method: req.method ?? '', role: m.role, outcome: outcomeOf(res, m), requestBytes: m.requestBytes, responseBytes: m.responseBytes, ms: metricsClock.mono() - started })
    if (m.authenticated && !m.skip && !m.route.startsWith('/v1/console')) captureApiCall(req, res, url, m, who, metricsClock.mono() - started)
  })
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  // Browsers must not be able to drive the API from a web page.
  if (req.headers.origin) return send(res, 403, { error: 'Cross-origin requests are not allowed' })
  const enabled = config.settings.agentApi.enabled
  if (url.pathname === '/v1/health' && enabled) {
    m.authenticated = true
    m.skip = true
    return send(res, 200, { ok: true, app: 'Hive', version: app.getVersion() })
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
  if (!caller) return send(res, enabled ? 401 : 403, { error: enabled ? 'Missing or invalid bearer token' : 'The Agent API is turned off in Settings → Agent API' })
  m.authenticated = true
  m.role = caller.kind
  who = caller
  // An agent's work is its project's; the Assistant's and scripts' are the workspace's own (not spread over projects).
  if (caller.kind === 'agent') m.project = basename(caller.projectPath)
  return callerStore.run(caller, () => serveApi(req, res, url))
}

async function serveApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const m = apiRequests.get(res)!
  if (url.pathname === '/v1/health') {
    m.skip = true
    return send(res, 200, { ok: true, app: 'Hive', version: app.getVersion() })
  }

  // A viewer changes nothing: whatever the route (a wait that holds a watch, a report), only a GET is served. Refused
  // before its body is read or its route looked up, so no write is ever reached.
  if (viewerCaller() && req.method !== 'GET') return send(res, 403, { error: 'A viewer token is read-only: it can read Hive (GET) and follow its events (GET /v1/events), not change anything' })

  if (req.method === 'GET' && url.pathname === '/v1/events') {
    // Events are about every open workspace: not for an Assistant, which sees only its own (it has hive_wait_for_agents).
    if (assistantCaller()) return send(res, 403, { error: 'The event stream is for Agent API callers. Use hive_wait_for_agents to follow agents.' })
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    res.write(': connected\n\n')
    sseClients.set(res, { agent: agentCaller(), viewer: viewerCaller()?.id ?? null })
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
  if (!r) return send(res, 404, { error: `No route for ${req.method} ${url.pathname}` })
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
        throw new HttpError(400, 'Body must be JSON')
      }
    }
    const params = url.pathname.match(r.pattern)!.slice(1)
    // With several Hive windows, a request is for one workspace: the one it names, or the only one open.
    const ws = requestWorkspace(req, url)
    const gone = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) gone.abort()
    })
    // Its replies name cards by key (#1219: "HI-12 (#40)"), its workspace's.
    const run = (): Promise<unknown> => withCardNames(ws, () => r.handler({ params, query: url.searchParams, body, signal: gone.signal }), callerScope())
    // A project agent's replies say when a card it works on or reviews has a new decision (#357), whatever it called:
    // the hive tools add the line to their reply. (The bridge's own reports about its calls aren't the agent's.) Its
    // cards as they were when the call began count too, so the call that moves a card on (to Review, say) still hears
    // of a decision it hasn't read, unless the call read it.
    const flagged = r.template !== '/v1/metrics/mcp' && r.template !== '/v1/launch/connected'
    const began = Date.now()
    const before = flagged ? await decisionsNew(ws) : null
    const result = ws ? await inWorkspace(ws, run) : await run()
    const notice = flagged ? await withCardNames(ws, () => decisionsNotice(ws, before, began), callerScope()) : null
    send(res, 200, result ?? null, notice ? { 'X-Hive-Notice': encodeURIComponent(notice) } : {})
  } catch (e) {
    const { status, body } = apiErrorReply(e)
    if (status === 500) log.error(`API ${req.method} ${url.pathname}`, e)
    // A wait (resolve's 409 while no check copy is free) is an answer to ask again, not a failure (HI-1831).
    if (e instanceof HttpError && e.extra && 'wait' in e.extra) m.waiting = true
    send(res, status, body)
  }
}

/**
 * The developer console (#636): an Agent API call as it ended, in its workspace's Hive events and in the calling agent's
 * (or Assistant's) own session. Its route and how it went, never its body or the reply: the query's names only.
 */
function captureApiCall(req: IncomingMessage, res: ServerResponse, url: URL, m: ApiRequest, who: Caller | null, ms: number): void {
  const own = who?.kind === 'agent' ? sessionSourceId(who.projectPath, who.agentId) : who?.kind === 'assistant' ? sessionSourceId(join(who.workspace, HIVE_DIR, ASSISTANT_DIR), ASSISTANT_AGENT_ID) : null
  devConsole.capture([m.ws && hiveSourceId(m.ws), own], () => {
    const name = `${req.method ?? ''} ${m.route}`
    const outcome = outcomeOf(res, m)
    const by = who?.kind === 'agent' ? `agent ${who.agentId}` : who?.kind ?? 'unknown'
    return {
      kind: 'api',
      name,
      raw: { method: req.method, route: m.route, params: [...new Set(url.searchParams.keys())].slice(0, 20), role: m.role, project: m.project, requestBytes: m.requestBytes },
      made: { status: res.statusCode, outcome, ms: Math.round(ms), responseBytes: m.responseBytes },
      // The query's parameter names are kept (identifiers only, never their values).
      safe: { raw: { method: true, route: true, params: true, role: true, project: true }, made: { outcome: true } },
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

/** The Agent API's answer to an error: its status, and its English whatever language Hive shows (#845). */
export function apiErrorReply(e: unknown): { status: number; body: Record<string, unknown> } {
  return { status: errorStatus(e), body: { error: englishError(e), ...(e instanceof HttpError ? e.extra : undefined), ...(e instanceof tasks.WorkflowRefusedError ? refusalBody(e.refusal) : undefined) } }
}

/** A workflow refusal as the Agent API gives it (SPEC §16.8.3): its rule, three English sentences and who can override. */
function refusalBody(r: Refusal): Record<string, unknown> {
  return { refused: true, rule: r.rule, message: r.message, next: r.next, ...(r.change ? { change: r.change } : {}), override: r.override }
}

/**
 * Hive's own text as data beside an English field (#845, `WindowTextField` in types.ts) is the window's: agents read
 * the English. Replies are built field by field (sessions' status, skills, MCP servers, events); where a whole object
 * goes out, these leave its companions behind, and only them: the rest of the object, whatever it holds, as it is.
 */
/** A card's history entry or comment: without its id (replies stay lean) or its text as data. */
export const entryForAgents = <T extends { id?: string; whatText?: unknown; hiveText?: unknown }>({ id: _id, whatText: _what, hiveText: _hive, ...rest }: T): Omit<T, 'id' | 'whatText' | 'hiveText'> => rest
/** A metrics report: its lists of what wasn't measured or filtered in English only. */
/**
 * /v1/metrics in 0.9.3 only (#1084; deprecated, gone in the next release): each guidance series also under its names from before 0.9.3, when the
 * Assistant's mode was its persona (`personaBytes`, `personaChars`).
 */
export function withPersonaAliases(r: MetricsReport): MetricsReport {
  const part = (p: MetricsPart): MetricsPart => ({ ...p, guidance: p.guidance.map((g) => ({ ...g, personaBytes: g.modeBytes, personaChars: g.modeChars }) as GuidanceSeries) })
  return { ...r, projects: Object.fromEntries(Object.entries(r.projects).map(([k, p]) => [k, part(p)])), ...(r.workspace ? { workspace: part(r.workspace) } : {}) }
}

export function metricsForAgents<R extends { notMeasuredText?: unknown; providersNoteText?: unknown; filters?: { notFilteredText?: unknown } }>(r: R): Omit<R, 'notMeasuredText' | 'providersNoteText'> {
  const { notMeasuredText: _m, providersNoteText: _p, ...rest } = r
  if (!rest.filters) return rest
  const { notFilteredText: _f, ...filters } = rest.filters
  return { ...rest, filters }
}
/** An agent just added: its reuse note in English only. */
export function addedForAgents<A extends { reuse?: { notReusedText?: unknown } }>(a: A): A {
  if (!a.reuse) return a
  const { notReusedText: _n, ...reuse } = a.reuse
  return { ...a, reuse }
}

/** What a HiveError's kind answers with (#845). */
const KIND_STATUS = { invalid: 400, forbidden: 403, notFound: 404, conflict: 409 } as const

/**
 * The status the Agent API answers an error with. The session and workspace services don't know about HTTP: a
 * HiveError's kind says it, else its English message does (statusFor).
 */
function errorStatus(e: unknown): number {
  if (e instanceof HiveError && e.kind) return KIND_STATUS[e.kind]
  return e instanceof HttpError ? e.status : e instanceof tasks.TaskPermissionError ? 403 : e instanceof tasks.TaskConflictError ? 409 : statusFor(e as Error)
}

function statusFor(e: Error): number {
  const m = String(e?.message ?? '')
  if (/Invalid session id|URI malformed|Unknown provider|Project names cannot|pinned to worktrees/i.test(m)) return 400
  if (/already running|already open|already being opened|is starting|Stop it first|Stop the|archived|No session is running|ran in .* Resume it|is required to run|is turned off|no agents yet|No workspace|busy|no handover|changed while the cards|workspace was closed|card watches|not a conversation/i.test(m)) return 409
  if (/several agents: choose/i.test(m)) return 400
  if (/Not a project|Unknown (project|agent|task)|no longer exists/i.test(m)) return 404
  if (/is archived|is done\.|has no project|needs a title|is too long|Unknown column|labels must|up to \d+ labels|^(blockedBy|links):|Choose a project|comment is empty|Unknown position|before or position|can't go before|, not in (On Hold|Todo|Doing|Review|Passed|Done)|A failed review leaves|There is no card #|^cards:|other project first/i.test(m)) return 400
  return 500
}

function broadcast(event: HiveEvent): void {
  if (!sseClients.size || !(API_EVENTS as readonly string[]).includes(event.type)) return
  // What each client gets (apiEvents.ts): every event for the workspace token and viewers, a project agent its project's.
  const lines = new Map<AgentIdentity | null, string | null>()
  const lineFor = (agent: AgentIdentity | null): string | null => {
    if (!lines.has(agent)) {
      const payload = apiEventFor(event, agent)
      lines.set(agent, payload ? `event: ${event.type}\ndata: ${replyText(payload)}\n\n` : null)
    }
    return lines.get(agent)!
  }
  for (const [c, { agent }] of sseClients) {
    const line = lineFor(agent)
    if (line === null) continue
    // A client that stopped reading would make Hive hold every event for it: it is disconnected instead.
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
    // Runs with the Agent API off too, for the Hive Assistant's token alone (see handleApi).
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
    apiError = (e as NodeJS.ErrnoException).code === 'EADDRINUSE' ? `Port ${port} is already in use` : (e as Error).message
    log.warn(`Agent API failed to start: ${apiError}${tries > 1 ? ` (after ${tries} tries)` : ''}`)
    apiServer = null
  } finally {
    if (apiListening === listening) apiListening = null
  }
  // Another app finds a running Hive's API by the discovery file (#620): there while the Agent API listens.
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

onHiveEvent(broadcast)
// A project agent's watch refused, under the watches' lock, while Hive is giving it a card in a slot (HI-2197).
onWatchPlacing(watchWhilePlaced)
