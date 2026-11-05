import { app } from 'electron'
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from 'original-fs'
import { rm, writeFile } from 'original-fs/promises'
import { randomUUID } from 'crypto'
import { basename, join } from 'path'
import { ASSISTANT_AGENT_ID } from '../shared/assistant'
import { RESTART_READY_SECONDS, RESUME_AFTER_UPDATE } from '../shared/advanced'
import { fmt, msg, tr } from '../shared/i18n'
import { agentMsg, inDialectOf, say } from '../shared/agentText'
import { agentKey, atStart, checkRequest, isFinal, mergeSnapshot, parseRecord, recordOpen, REQUEST_FILE, REQUEST_MAX_BYTES, restartingLine, resumeNote, STALL_HOLD_MS, ackFile, takenFile, type RestartEntry, type RestartReason, type RestartRecord, type RestartState } from '../shared/restartResume'
import type { LaneInfo, LiveSessionState, TaskCard, ToastAction } from '../shared/types'
import type { RunningAgent } from '../shared/unexpectedClose'
import { advanced } from './advanced'
import { assistantHome } from './assistantControl'
import { createDelivery, leaveDelivery, roundOf } from './deliveries'
import { onHiveEvent, toast } from './events'
import { dropOfferActions, resolveOffer } from './notify'
import { OUTCOME } from './outcomes'
import { placeKey, samePlace } from './fsutil'
import { listLanes } from './lanes'
import { createLogger, userText } from './logger'
import { sessions } from './sessions'
import { allTasks } from './tasks'
import { onGateSettled } from './openGate'
import { inWorkspace, openWorkspaces, workspaceOf, type WorkspaceService } from './workspace'
import { pausedFor } from './teamPause'
import { dataFolder } from './hiveFolder'

/**
 * Restarts announced and resumed (HI-1707, shared/restartResume.ts). As Hive closes for an update, an install or a
 * restart, the agents that were working, watching or in a running lane are recorded and told; at the next start they
 * resume in their conversations one at a time, each after the last is ready (Darren's decision), with a note of where
 * they were. An ordinary quit records them too, and the next start offers to resume them. The record (restart.json in
 * the profile) keeps each agent's state until it is final, so nothing is lost to an interrupted start; this module is
 * the one owner of these resumes (lastRun.ts leaves it the agents it lists).
 */
const log = createLogger('restart')
const HIVE = { kind: 'hive', name: 'Combwork' } as const // i18n-ignore: the product's name, as a delivery's sender
const RECORD_FILE = 'restart.json'

const T = {
  assistant: agentMsg({
    id: 'notice.restart.assistant',
    text: "Combwork restarted{quit, select, yes { after a quit} other { for an update}}{versions}. Resumed: {hasResumed, select, yes {{resumed}} other {none}}.{hasNot, select, yes { Not resumed: {not}.} other {}} Each resumed agent was told where it was; check their lanes carry on.",
    note: "HI-1707: the Assistant's notice after Hive resumed agents at a start. quit: yes after a quit (else an update, an install or a restart); versions: ' (1.0.0 → 1.0.1)' or nothing; resumed: those resumed, each 'name (project)', ', ' between; not: those not resumed, each 'name (project): state, why' (codes), '; ' between."
  })
}

let recordFileForTests: string | null = null
const recordFile = (): string => recordFileForTests ?? join(app.getPath('userData'), RECORD_FILE)

let record: RestartRecord | null = null
/** One record write at a time, in order. */
let writes: Promise<void> = Promise.resolve()
/** This run's queue (agent keys, in order), whether it is being worked, and when each was queued (the stall hold). */
const queue: string[] = []
const queuedAt = new Map<string, number>()
let pumping = false
let stopping = false
/**
 * Bumped as Hive starts closing (stopRestartRecovery, recordClosing): an attempt that began before it starts nothing and
 * changes nothing after it, so the closing snapshot (which put the attempt's entry back to pending) stands.
 */
let generation = 0
/** A launch the queue stopped that hasn't ended: nothing more is admitted while it runs (its runId). */
let stuckRun: string | null = null
/** What this run's resumes came to, for the one report once the queue is empty. */
const done: { resumed: RestartEntry[]; failed: RestartEntry[]; held: RestartEntry[]; skipped: RestartEntry[] } = { resumed: [], failed: [], held: [], skipped: [] }
/** Tests: the readiness wait and the stop's bound, shortened. */
let readyMsForTests: number | null = null
let stopMsForTests: number | null = null
export const setTimingsForTests = (o: { readyMs?: number | null; stopMs?: number | null; recordFile?: string | null }): void => {
  if (o.readyMs !== undefined) readyMsForTests = o.readyMs
  if (o.stopMs !== undefined) stopMsForTests = o.stopMs
  if (o.recordFile !== undefined) recordFileForTests = o.recordFile
}

/** Reads the record at start (once, before the unexpected-close notice decides what it resumes): open entries only. */
export function loadRestartRecord(file = recordFile()): RestartRecord | null {
  record = null
  if (!existsSync(file)) return null
  try {
    record = parseRecord(readFileSync(file, 'utf8'))
    if (!record) log.warn('The restart record could not be read: left as it is')
  } catch (e) {
    log.warn('Reading the restart record', e)
  }
  if (record) record = atStart(record, Date.now())
  loadedAt = Date.now()
  return record
}

/** When this start read the record: the stall hold of entries not queued yet counts from then. */
let loadedAt: number | null = null

/** The record as it is now (tests, diagnostics). */
export const restartRecord = (): RestartRecord | null => record

/** How the record's entries resume: the latest close's reason (a quit offers them; with no record, a quit's). */
const policy = (): RestartReason => record?.reason ?? 'quit'

/** Writes the record as it is now (removed once nothing in it is open), after any write under way. */
function save(): Promise<void> {
  const snapshot = record && recordOpen(record) ? `${JSON.stringify(record, null, 2)}\n` : null
  writes = writes.then(async () => {
    const file = recordFile()
    try {
      if (!snapshot) {
        await rm(file, { force: true })
        return
      }
      await writeFile(`${file}.tmp`, snapshot)
      renameSync(`${file}.tmp`, file)
    } catch (e) {
      log.warn('Writing the restart record', e)
    }
  })
  return writes
}

/** Waits for the record's writes so far (quitting, tests). */
export const restartRecordSaved = (): Promise<void> => writes

function setState(e: RestartEntry, state: RestartState, why?: string): void {
  e.state = state
  e.changedAt = new Date().toISOString()
  if (why) e.why = why
  else delete e.why
  for (const l of entryListeners) l(e.projectPath, e.agentId)
}

/** Told each change of an entry's state (HI-1746: a card's placement waiting for this run's resume of its builder). */
const entryListeners = new Set<(projectPath: string, agentId: string) => void>()
export function onResumeEntry(listener: (projectPath: string, agentId: string) => void): () => void {
  entryListeners.add(listener)
  return () => entryListeners.delete(listener)
}

const entryOf = (key: string): RestartEntry | undefined => record?.entries.find((e) => agentKey(e) === key)

/**
 * Whether this run owns an agent's resume (an open entry of the record): the unexpected-close notice leaves it to this
 * module, so the same conversation is never started by both.
 */
export const ownsResume = (projectPath: string, agentId: string): boolean => {
  const e = entryOf(agentKey({ projectPath, agentId }))
  return !!e && !isFinal(e.state)
}

/**
 * Whether a lane's "isn't running" stall is held for an agent: it is queued or starting in this run's recovery, or
 * pending to resume by itself, for at most STALL_HOLD_MS. Cleared by any outcome; an offer the user hasn't accepted
 * holds nothing.
 */
export function isResuming(projectPath: string, agentId: string): boolean {
  const key = agentKey({ projectPath, agentId })
  const e = entryOf(key)
  if (!e) return false
  const waiting = e.state === 'queued' || e.state === 'starting' || (e.state === 'pending' && auto(openWorkspaceOf(e)))
  const at = queuedAt.get(key) ?? loadedAt
  return waiting && at !== null && Date.now() - at < STALL_HOLD_MS
}

// ---------------------------------------------------------------------------
// As Hive closes: the snapshot, and the agents told.
// ---------------------------------------------------------------------------

/** How an agent being stopped counts: working, waiting, with background tasks, or watching (a card loop). */
const BUSY = new Set(['working', 'waiting', 'background', 'watching'])

/** The card an agent is on: its lane's current card, else the card it works on or reviews in Doing or Review. */
function cardFor(cards: readonly TaskCard[], project: string, agentId: string, laneCard: number | null): { label: string; round?: number } | undefined {
  const c = laneCard !== null ? cards.find((x) => x.number === laneCard) : cards.find((x) => x.project === project && (x.column === 'doing' || x.column === 'review') && (x.agent === agentId || x.review?.agent === agentId))
  if (!c) return undefined
  return { label: c.key ?? `#${c.number}`, round: roundOf(c) }
}

/**
 * Every running agent with a conversation (the Assistant's own session is the Assistant's), from the live states alone:
 * nothing read or awaited, so the conversations are recorded whatever a read would cost. Narrowed and given their
 * cards and lanes by `enrich`.
 */
export function baseEntries(): RestartEntry[] {
  const at = new Date().toISOString()
  const out: RestartEntry[] = []
  for (const s of sessions.liveStates()) {
    let ws: WorkspaceService
    try {
      ws = workspaceOf(s.projectPath)
    } catch {
      continue
    }
    if (!ws.path || ws.isAssistantHome(s.projectPath) || !s.sessionId) continue
    out.push({ workspace: ws.path, projectPath: s.projectPath, project: basename(s.projectPath), agentId: s.agentId, agentName: s.agentName ?? s.agentId, provider: s.provider, sessionId: s.sessionId, ...(s.sessionName ? { sessionName: s.sessionName } : {}), status: s.status, from: app.getVersion(), at, state: 'pending', changedAt: at })
  }
  return out
}

/**
 * The base entries narrowed to those that were working, watching or in a running lane, each with its card, round and
 * lane (each workspace's lanes and board read once).
 */
export async function enrich(base: readonly RestartEntry[]): Promise<RestartEntry[]> {
  const lanes = new Map<string, Promise<LaneInfo[]>>()
  const boards = new Map<string, Promise<TaskCard[]>>()
  const once = <T>(m: Map<string, Promise<T>>, key: string, read: () => Promise<T>, empty: T): Promise<T> => {
    if (!m.has(key)) m.set(key, read().catch(() => empty))
    return m.get(key)!
  }
  const out: RestartEntry[] = []
  for (const e of base) {
    const ws = workspaceOf(e.projectPath)
    const key = e.workspace.toLowerCase()
    const running = (await once(lanes, key, () => inWorkspace(ws, () => listLanes(ws)), [] as LaneInfo[])).filter((l) => (l.state === 'active' || l.state === 'paused') && l.project.toLowerCase() === e.project.toLowerCase())
    const lane = running.find((l) => l.builder.id === e.agentId) ?? running.find((l) => l.reviewer?.id === e.agentId)
    if (!BUSY.has(e.status) && !lane) continue
    const card = cardFor(await once(boards, key, () => allTasks(ws, { archived: false }), [] as TaskCard[]), e.project, e.agentId, lane?.current ?? null)
    out.push({ ...e, ...(card ? { card } : {}), ...(lane ? { lane: { id: lane.id, name: lane.name, role: lane.builder.id === e.agentId ? 'builder' : 'reviewer' } } : {}) })
  }
  return out
}

/**
 * Hive is closing (quitNow): its agents recorded, before they are stopped. Every running conversation is written at
 * once; then, within `snapshotMs`, narrowed to those working, watching or in a lane, with their cards and lanes. One
 * that takes longer keeps every conversation (an idle agent resumed is a lesser harm than a working one lost). For an
 * update, an install or a restart they are told too, best effort, within `tellMs` (a line in each one's inbox: an idle
 * one is shown it at once, a working one finds it when it is resumed).
 */
export async function recordClosing(reason: RestartReason, o: { snapshotMs?: number; tellMs?: number } = {}): Promise<number> {
  stopping = true
  generation++
  const bounded = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> => Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms).unref())])
  // Who: an entry leaves only once its agent is ready (resumed). One not yet resumed, queued, starting or offered at
  // this close, is pending again, as it was (its conversation, card, round and lane): one being resumed is never
  // replaced by its live launch, which is still starting and in no lane, so narrowing would drop it. How: this close's
  // reason, for every entry (the next start resumes them by itself after an install, an update or a restart, and offers
  // them after a quit), so none keeps an older close's.
  const inFlight = new Set<string>()
  for (const e of record?.entries ?? [])
    if (e.state === 'queued' || e.state === 'starting' || e.state === 'offered') {
      if (e.state !== 'offered') inFlight.add(agentKey(e))
      setState(e, 'pending')
    }
  const base = baseEntries().filter((e) => !inFlight.has(agentKey(e)))
  record = mergeSnapshot(record, base, reason)
  await save()
  const enriched = await bounded(enrich(base).catch((e) => (log.warn('Reading the cards and lanes of the agents as Hive closes', e), null)), o.snapshotMs ?? 2000, null)
  let snapshot = base
  if (enriched) {
    const narrowed = new Set(base.map(agentKey))
    record = mergeSnapshot({ version: 1, reason, entries: (record?.entries ?? []).filter((e) => !narrowed.has(agentKey(e))) }, enriched, reason)
    snapshot = enriched
    await save()
  } else log.warn(`Reading the cards and lanes of the agents took over ${o.snapshotMs ?? 2000} ms as Hive closed: every running conversation is kept to resume`)
  if (snapshot.length) log.info(`Recorded ${snapshot.length} agent(s) as Hive closes (${reason}): ${snapshot.map((e) => `${userText(e.agentName)} in ${userText(e.project)}`).join(', ')}`) // i18n-ignore: a line of hive.log
  if (reason !== 'quit' && snapshot.length) {
    const tell = Promise.allSettled(snapshot.map((e) => inWorkspace(workspaceOf(e.projectPath), () => createDelivery(e.projectPath, { agentId: e.agentId, agentName: e.agentName, kind: 'control', from: HIVE, body: inDialectOf({ projectPath: e.projectPath, agentId: e.agentId }, restartingLine) }))))
    await bounded(tell, o.tellMs ?? 1500, [])
  }
  return snapshot.length
}

/**
 * A run an installer ended without asking it to close (an older installer, or one whose wait ran out): its running
 * marker lists its agents, and a newer version starts now. They are an install's, added to the record (those it has
 * open already kept as they are), with what the marker knew: no card or lane, so their note says only why.
 */
export function adoptInstalledRun(agents: readonly RunningAgent[], from: string, at: string): void {
  const entries: RestartEntry[] = agents
    .filter((a) => !!a.sessionId && !ownsResume(a.projectPath, a.agentId))
    .map((a) => ({ workspace: a.workspace, projectPath: a.projectPath, project: a.project, agentId: a.agentId, agentName: a.agentName, provider: a.provider, sessionId: a.sessionId!, ...(a.sessionName ? { sessionName: a.sessionName } : {}), status: 'unknown', from, at, state: 'pending', changedAt: new Date().toISOString() })) // i18n-ignore: the record's values, not text
  if (!entries.length) return
  record = mergeSnapshot(record, entries, 'install')
  void save()
  log.info(`The last run (Hive ${from}) was ended for an install without being asked to close: ${entries.length} agent(s) recorded to resume`)
}

// ---------------------------------------------------------------------------
// At the next start: auto-resume, or offer, as each workspace is ready.
// ---------------------------------------------------------------------------

/** A workspace's own Advanced values (Settings → Advanced, This workspace), when it is open. */
const workspaceValues = (ws: WorkspaceService | undefined): Record<string, unknown> | null => ws?.config?.advanced ?? null

/**
 * Whether an entry resumes on its own: Hive last closed for an update, an install or a restart (the record's policy),
 * with Resume agents after an update on for the entry's workspace (its own value, else Hive's).
 */
const auto = (ws: WorkspaceService | undefined): boolean => policy() !== 'quit' && advanced.get<boolean>(RESUME_AFTER_UPDATE, workspaceValues(ws)) !== false

/**
 * Once Hive's window is up: entries already offered (or held) are offered again in one notice, and the queue started.
 * Each pending entry is decided once its workspace is ready (pump): queued to resume, or offered.
 */
export async function startRestartRecovery(): Promise<void> {
  if (!record || recoveryStarted) return
  recoveryStarted = true
  stopping = false
  const offer: RestartEntry[] = []
  for (const e of record.entries) {
    if (e.state === 'held') setState(e, 'offered')
    if (e.state === 'offered') offer.push(e)
  }
  // Told before the write is awaited, as pump does (HI-2356): an offer the queue told already is replaced at once.
  if (offer.length) tellOffer()
  await save()
  // A team resuming (HI-2081): what waited for it is decided now.
  onHiveEvent((ev) => {
    if (ev.type === 'team-pause-changed' && !ev.pause) pump()
  })
  pump()
}

/** Once a start: the window's load can come more than once (a reload). */
let recoveryStarted = false

/** The offer's buttons' commands (the renderer's commands.ts). */
const RESUME_COMMAND = 'session.resumeRestart'
const DISMISS_COMMAND = 'session.dismissRestart'

function enqueue(e: RestartEntry): void {
  const key = agentKey(e)
  setState(e, 'queued')
  if (!queue.includes(key)) queue.push(key)
  queuedAt.set(key, Date.now())
}

/**
 * The notice offering to resume the agents (an ordinary quit, or the switch off): Resume or Don't Resume (the notice's ×
 * only closes it). One offer at a time (HI-2356): it lists every entry offered now, and a notice still open with its
 * buttons is resolved as replaced, so no notice's buttons act on agents it didn't name (they act on every entry offered).
 */
function tellOffer(): void {
  const entries = record?.entries.filter((e) => e.state === 'offered') ?? []
  if (!entries.length) return
  if (openOffer) resolveOffer(openOffer, tr(OUTCOME.offerReplaced))
  const n = entries.length
  const names = fmt.list(entries.map((e) => `${e.agentName} (${e.project})`))
  const quit = policy() === 'quit'
  const title = tr(msg({ id: 'main.restart.offerTitle', defaultMessage: '{n, plural, one {Resume the agent that was working?} other {Resume the # agents that were working?}}', description: "A notice at start: Hive was quit (or restarted for an update with resuming turned off) while agents worked. {n} is how many; Resume starts them again in their conversations." }), { n })
  const body = quit
    ? tr(msg({ id: 'main.restart.offerQuit', defaultMessage: 'Combwork was quit while they were working or in a card loop: {names}. Resume starts each again in its conversation, one at a time.', description: 'The notice offering to resume agents after an ordinary quit. {names} lists them, each with its project.' }), { names })
    : tr(msg({ id: 'main.restart.offerUpdate', defaultMessage: 'Combwork restarted for an update while they were working or in a card loop: {names}. Resume starts each again in its conversation, one at a time.', description: 'The notice offering to resume agents after an update, with Settings → Advanced → Resume agents after an update turned off. {names} lists them, each with its project.' }), { names })
  const actions: ToastAction[] = [
    { label: tr(msg({ id: 'main.restart.resume', defaultMessage: 'Resume', description: 'A button in the notice offering to resume the agents that were working when Hive closed.' })), command: RESUME_COMMAND },
    { label: tr(msg({ id: 'main.restart.dismiss', defaultMessage: "Don't Resume", description: "A button in the notice offering to resume the agents that were working when Hive closed: resumes none, and the offer is not made again (the notice's × only closes it)." })), command: DISMISS_COMMAND }
  ]
  log.info(`Offered to resume ${n} agent(s): ${entries.map((e) => userText(e.agentName)).join(', ')}`)
  // Its offer (HI-2320): Resume's report, or Don't Resume, is what it says once taken.
  openOffer = `restart:${randomUUID()}`
  toast('info', title, body, actions, undefined, undefined, { offer: openOffer, timeoutMs: 120_000 })
}

/** The offer to resume shown now with its buttons (HI-2320), until Resume, Don't Resume or a newer offer. */
let openOffer: string | null = null
/** Offers whose Resume was taken (their buttons gone), each waiting for the report to say how it went. */
const takenOffers: string[] = []

/** The offer's Resume: its entries queued, and its notice's buttons gone until its report. How many. */
export async function resumeOffered(): Promise<number> {
  const offered = record?.entries.filter((e) => e.state === 'offered') ?? []
  for (const e of offered) enqueue(e)
  if (openOffer) {
    dropOfferActions(openOffer, [RESUME_COMMAND, DISMISS_COMMAND], tr(OUTCOME.resuming))
    takenOffers.push(openOffer)
    openOffer = null
  }
  await save()
  pump()
  return offered.length
}

/** The offer's Don't Resume: its entries dismissed, not offered again. How many. */
export async function dismissOffered(): Promise<number> {
  const offered = record?.entries.filter((e) => e.state === 'offered') ?? []
  for (const e of offered) setState(e, 'dismissed')
  await save()
  if (openOffer) resolveOffer(openOffer, tr(OUTCOME.notResumed))
  openOffer = null
  return offered.length
}

/** Hive is quitting: no more starts from the queue, and an attempt under way changes nothing (it stays pending). */
export function stopRestartRecovery(): void {
  stopping = true
  generation++
}

// ---------------------------------------------------------------------------
// The queue: one at a time, each after the last is ready.
// ---------------------------------------------------------------------------

/** Each workspace's merge-slot recovery as it opens (ipc.ts' onOpened), by its place, and those settled. */
const recoveries = new Map<string, Promise<unknown>>()
const recovered = new Set<string>()

// A workspace's open commands done, or let go (HI-1954): what waited for them is admitted now.
onGateSettled(() => pump())

/**
 * A workspace opening (ipc.ts' onOpened): its merge slots' recovery, which a resume waits for, as the unexpected-close
 * notice does. Its entries are admitted once it has settled and the workspace's first read is done.
 */
export function workspaceRecovering(path: string, recovery: Promise<unknown>): void {
  const key = placeKey(path)
  recovered.delete(key)
  const run: Promise<unknown> = recovery
    .catch(() => undefined)
    .finally(() => {
      if (recoveries.get(key) !== run) return
      recovered.add(key)
      pump()
    })
  recoveries.set(key, run)
}

/** The workspace an entry belongs to, when it is open in this run. */
const openWorkspaceOf = (e: RestartEntry): WorkspaceService | undefined => openWorkspaces().find((w) => !!w.path && samePlace(w.path, e.workspace))

/**
 * The workspace an entry belongs to once it is ready for a resume: open, read (its info: its projects and agents), and
 * its merge slots recovered. A path alone isn't ready: a window sets it before its workspace is read.
 */
const readyWorkspaceOf = (e: RestartEntry): WorkspaceService | undefined => {
  const ws = openWorkspaceOf(e)
  // Not while its open commands hold its agents back (HI-1954): the gate settling pumps again.
  return ws?.path && ws.info() && recovered.has(placeKey(ws.path)) && !ws.openGate?.held ? ws : undefined
}

/** Whether a launch is still live (by its runId). */
const runLive = (runId: string): boolean => sessions.liveStates().some((s) => s.runId === runId)

/**
 * Decides the pending entries whose workspaces are ready (queued to resume, or offered in one notice), then works the
 * queue: the first entry whose workspace is ready, one at a time, until none can go now. Nothing is admitted while a
 * launch it stopped still runs.
 */
function pump(): void {
  if (stopping) return
  // Asked while it works (a workspace ready, a launch ended): it goes round again once it is done, never lost.
  if (pumping) {
    pumpAgain = true
    return
  }
  pumping = true
  pumpAgain = false
  const gen = generation
  void (async () => {
    try {
      for (;;) {
        if (stopping || gen !== generation) return
        const offer: RestartEntry[] = []
        for (const e of record?.entries ?? []) {
          if (e.state !== 'pending') continue
          const ws = readyWorkspaceOf(e)
          if (!ws) continue
          // Its team paused (HI-2081: a crash or a plain quit while it was, which no update's restart lifted): pending, and
          // neither resumed nor offered until the team resumes (which pumps again).
          if (pausedFor(e.projectPath)) continue
          if (auto(ws)) enqueue(e)
          else {
            setState(e, 'offered')
            offer.push(e)
          }
        }
        // Told in the same step as they became offered, before any await (HI-2356, HR1's round 1): an older notice's
        // buttons, which act on every offered entry, never see one it didn't name.
        if (offer.length) {
          tellOffer()
          await save()
        }
        if (stuckRun && runLive(stuckRun)) return
        stuckRun = null
        const key = queue.find((k) => {
          const e = entryOf(k)
          return !!e && e.state === 'queued' && !!readyWorkspaceOf(e)
        })
        if (!key) break
        queue.splice(queue.indexOf(key), 1)
        const e = entryOf(key)!
        const outcome = await resumeOne(e, gen).catch((err) => {
          if (gen !== generation) return 'cancelled' as const
          setState(e, 'failed', err instanceof Error ? err.message : String(err))
          done.failed.push(e)
          return 'done' as const
        })
        if (outcome === 'cancelled' || gen !== generation) return
        queuedAt.delete(key)
        await save()
      }
      // Nothing left this run can start: the report, once every queued entry has an outcome.
      if (!queue.some((k) => entryOf(k)?.state === 'queued')) report()
    } finally {
      pumping = false
      queuePasses++
      if (pumpAgain && gen === generation) pump()
    }
  })()
}
let pumpAgain = false
/** Tests: the queue's passes finished, and whether one is under way (a barrier: what a pass decided is final). */
let queuePasses = 0
export const queueForTests = (): { passes: number; pumping: boolean } => ({ passes: queuePasses, pumping })

// A workspace read (a window restoring it, or one opened later), or a launch ending, may let entries go.
let following = false
function followWorkspaces(): void {
  if (following) return
  following = true
  onHiveEvent((ev) => {
    if (ev.type === 'workspace-changed' || (ev.type === 'session-exit' && stuckRun)) pump()
  })
}

/** The statuses of an agent that has taken its first prompt (a resume's note). */
const TOOK_NOTE = new Set(['working', 'finished', 'waiting', 'background'])

/** How long a resumed agent has to be ready (Settings → Advanced, its workspace's own value or Hive's). */
const readyMs = (ws: WorkspaceService): number => readyMsForTests ?? Math.max(10, Number(advanced.get<number>(RESTART_READY_SECONDS, workspaceValues(ws))) || 90) * 1000

/** Waits for a condition, polled, up to `ms`. */
async function until(fn: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  for (;;) {
    if (fn()) return true
    if (Date.now() >= end) return false
    await new Promise((r) => setTimeout(r, 250))
  }
}

/**
 * One agent: checked again just before it starts (its workspace ready, the agent still there and not running, its
 * conversation still its last, no slot hold), after every await too; started in its conversation with its note, and
 * waited for until it is ready. Not ready in time: its launch stopped, and confirmed gone, before the next one starts.
 * `gen`: the queue's generation; Hive closing meanwhile cancels it ('cancelled': nothing changed), a workspace closing
 * puts it back to pending.
 */
/** A resume refused as it spawns because its team is paused now (HI-2081): pending again, not failed. */
class TeamPausedNow extends Error {}

async function resumeOne(e: RestartEntry, gen: number): Promise<'done' | 'cancelled'> {
  const cancelled = (): boolean => gen !== generation || stopping
  // Its workspace closed (not Hive): back to pending, for when it opens again.
  const closed = (): 'done' => {
    setState(e, 'pending')
    return 'done'
  }
  const skip = (why: string): 'done' => {
    setState(e, 'skipped', why)
    done.skipped.push(e)
    log.info(`Not resuming ${userText(e.agentName)} in ${userText(e.project)}: ${why}`)
    return 'done'
  }
  /** Why it can't start now, from what is so now: null when it may. */
  const check = (ws: WorkspaceService): string | null => {
    const agent = ws.info()?.projects.find((p) => samePlace(p.path, e.projectPath))?.agents.find((a) => a.id === e.agentId)
    if (!agent) return 'removed'
    // A start of it under way (a card's placement resuming it, HI-1746) counts too: its own start would be refused.
    if (sessions.liveFor(e.projectPath, e.agentId) || sessions.pendingStart(e.projectPath, e.agentId)) return 'running'
    if (agent.lastSessionId && agent.lastSessionId !== e.sessionId) return 'movedOn'
    return null
  }
  let ws = readyWorkspaceOf(e)
  if (!ws) return closed()
  // Its team paused since it was queued (HI-2081): pending again, resumed once the team resumes.
  if (pausedFor(e.projectPath)) return closed()
  const first = check(ws)
  if (first) return skip(first)
  const hold = await inWorkspace(ws, () => sessions.resumeHoldFor(e.projectPath, e.agentId, e.sessionId)).catch(() => null)
  if (cancelled()) return 'cancelled'
  if (hold) {
    setState(e, 'held', hold.is)
    done.held.push(e)
    log.info(`Left ${userText(e.agentName)} in ${userText(e.project)} to resume by hand (${hold.is})`)
    return 'done'
  }
  setState(e, 'starting')
  await save()
  if (cancelled()) return 'cancelled'
  // Checked again just before the start, nothing awaited between: what changed while the hold and the save were awaited.
  ws = readyWorkspaceOf(e)
  if (!ws) return closed()
  // Its team paused meanwhile (round 1, finding 6): pending again; the start's own `allowed` asks once more as it spawns.
  if (pausedFor(e.projectPath)) return closed()
  const again = check(ws)
  if (again) return skip(again)
  const ms = readyMs(ws)
  // Ready once it has taken its note (its first prompt): seen working, or past a turn, in any status change of this
  // launch. Not `ready` (a resumed conversation's transcript is there before its CLI is, and Hive's fallback reads that
  // as ready), nor `watching` (a watch the conversation had shows as it starts). Everything after the start is about
  // this launch only (its runId): a session the user started meanwhile is never counted, waited for or stopped as it.
  let runId: string | null = null
  let took = false
  const off = onHiveEvent((ev) => {
    if (ev.type === 'session-status' && runId !== null && ev.state.runId === runId && TOOK_NOTE.has(ev.state.status)) took = true
  })
  const mine = (): LiveSessionState | null => {
    const s = sessions.liveFor(e.projectPath, e.agentId)
    return s && s.runId === runId ? s : null
  }
  let ready = false
  // Its team paused since it was checked (HI-2081, round 1 finding 6): asked again as the launch spawns, after its awaits;
  // refused, the entry is pending again, resumed once the team resumes.
  const allowed = (): void => {
    if (pausedFor(e.projectPath)) throw new TeamPausedNow()
  }
  try {
    try {
      runId = (await inWorkspace(ws, () => sessions.start(e.projectPath, { agentId: e.agentId, resumeId: e.sessionId, auto: true, allowed, ...(e.sessionName ? { name: e.sessionName } : {}), prompt: inDialectOf({ projectPath: e.projectPath, agentId: e.agentId }, () => resumeNote(e, app.getVersion(), policy())) }))).runId
    } catch (err) {
      if (err instanceof TeamPausedNow || (err instanceof Error && err.cause instanceof TeamPausedNow)) return closed()
      throw err
    }
    // Its launch ending meanwhile (stopped by the user, or its CLI exited), Hive closing, or its workspace closing end
    // the wait too.
    ready = await until(() => took || TOOK_NOTE.has(mine()?.status ?? 'stopped') || !mine() || cancelled() || !openWorkspaceOf(e), ms)
    ready &&= took || TOOK_NOTE.has(mine()?.status ?? 'stopped')
  } finally {
    off()
  }
  // Hive closing: its sessions stop with it, and the closing snapshot has this agent; nothing here changes the record.
  if (cancelled()) return 'cancelled'
  if (ready) {
    setState(e, 'resumed')
    done.resumed.push(e)
    log.info(`Resumed ${userText(e.agentName)} in ${userText(e.project)} after Combwork restarted (${policy()})`)
    return 'done'
  }
  if (!openWorkspaceOf(e)) return closed()
  // Its launch ended before it took its note: stopped (by the user, or its CLI exited), not resumed again later.
  if (!mine()) {
    setState(e, 'failed', 'stopped')
    done.failed.push(e)
    log.info(`${userText(e.agentName)} in ${userText(e.project)} was stopped while it was resuming`)
    return 'done'
  }
  // Not ready: this launch stopped (by its runId: never another), ended if it doesn't stop, and confirmed gone before
  // the next one starts. One that outlives it all is reported, and nothing more is admitted until it has ended.
  const own = runId
  await sessions.stopWhereAndWait((s) => (s as LiveSessionState).runId === own, stopMsForTests ?? 10_000)
  if (cancelled()) return 'cancelled'
  if (runLive(own)) {
    stuckRun = own
    setState(e, 'failed', 'notStopped')
    done.failed.push(e)
    log.warn(`${userText(e.agentName)} in ${userText(e.project)} wasn't ready within ${Math.round(ms / 1000)} s of resuming and hasn't stopped: no other agent resumes until it ends`)
    return 'done'
  }
  setState(e, 'failed', 'notReady')
  done.failed.push(e)
  log.warn(`${userText(e.agentName)} in ${userText(e.project)} wasn't ready within ${Math.round(ms / 1000)} s of resuming: stopped`)
  return 'done'
}

/** Why an entry wasn't resumed, as the notice says it. */
function whyText(e: RestartEntry): string {
  switch (e.why) {
    case 'removed':
      return tr(msg({ id: 'main.restart.why.removed', defaultMessage: 'it was removed', description: 'Why an agent was not resumed after Hive restarted: the agent has been removed from its project.' }))
    case 'running':
      return tr(msg({ id: 'main.restart.why.running', defaultMessage: 'it is running already', description: 'Why an agent was not resumed after Hive restarted: it is running already.' }))
    case 'movedOn':
      return tr(msg({ id: 'main.restart.why.movedOn', defaultMessage: 'it has a newer conversation', description: 'Why an agent was not resumed after Hive restarted: it was started in another conversation since.' }))
    case 'notReady':
      return tr(msg({ id: 'main.restart.why.notReady', defaultMessage: "it didn't get ready in time, so it was stopped", description: 'Why an agent was not resumed after Hive restarted: its CLI did not become ready within the time allowed (Settings → Advanced), so Hive stopped it.' }))
    case 'notStopped':
      return tr(msg({ id: 'main.restart.why.notStopped', defaultMessage: "it didn't get ready in time and hasn't stopped yet; the others resume once it has", description: 'Why an agent was not resumed after Hive restarted: its CLI did not become ready in time, and it did not end when Hive stopped it; Hive starts no other agent until it has ended.' }))
    case 'stopped':
      return tr(msg({ id: 'main.restart.why.stopped', defaultMessage: 'it was stopped while it started', description: 'Why an agent was not resumed after Hive restarted: its launch ended (the user stopped it, or its CLI exited) before it was ready.' }))
    case 'expired':
      return tr(msg({ id: 'main.restart.why.expired', defaultMessage: 'it waited more than a day', description: 'Why an agent was not resumed after Hive restarted: the restart was over a day ago.' }))
    default:
      return e.state === 'held' ? tr(msg({ id: 'main.restart.why.held', defaultMessage: 'its working folder is held for other work (resume it by hand)', description: "Why an agent was not resumed after Hive restarted: the slot (working folder) its conversation ran in is free or holds other work, so only the user's own Resume may take it." })) : (e.why ?? '')
  }
}

/** The one notice of what this run's queue did, and each workspace's Assistant told; then the counts start again. */
function report(): void {
  const { resumed, failed, held, skipped } = done
  if (!resumed.length && !failed.length && !held.length && !skipped.length) return
  const update = policy() !== 'quit'
  const lines: string[] = []
  if (resumed.length) lines.push(tr(msg({ id: 'main.restart.resumedLine', defaultMessage: 'Resumed: {names}.', description: 'A line of the notice after Hive resumed agents when it started again. {names} lists them, each with its project.' }), { names: fmt.list(resumed.map((e) => `${e.agentName} (${e.project})`)) }))
  for (const e of [...failed, ...held, ...skipped]) lines.push(tr(msg({ id: 'main.restart.notResumedLine', defaultMessage: 'Not resumed: {agent} ({project}): {why}.', description: 'A line of the notice after Hive resumed agents when it started again: one it did not resume, and why.' }), { agent: e.agentName, project: e.project, why: whyText(e) }))
  const title = update
    ? tr(msg({ id: 'main.restart.reportUpdate', defaultMessage: '{n, plural, one {Resumed one agent after the update} other {Resumed # agents after the update}}', description: "A notice's title: Hive restarted for an update and resumed the agents that were working. {n} is how many resumed." }), { n: resumed.length })
    : tr(msg({ id: 'main.restart.reportResume', defaultMessage: '{n, plural, one {Resumed one agent} other {Resumed # agents}}', description: "A notice's title: the agents that were working when Hive was quit were resumed, as the user asked. {n} is how many." }), { n: resumed.length })
  // The offers whose Resume was taken: each notice says how it went, in place of its buttons (HI-2320); else a notice of
  // its own. An offer still open (its buttons not used) stays open.
  const text = `${title}\n${lines.join('\n')}`
  const said = takenOffers.splice(0).filter((o) => resolveOffer(o, text)).length
  if (!said) toast(failed.length ? 'warning' : 'success', title, lines.join('\n'), undefined, undefined, undefined, { timeoutMs: 60_000 })
  void tellAssistants([...resumed], [...failed, ...held, ...skipped])
  done.resumed = []
  done.failed = []
  done.held = []
  done.skipped = []
}

/** Each workspace's Assistant told what was resumed (agent-facing, English), for its next look at the lanes. */
async function tellAssistants(resumed: readonly RestartEntry[], not: readonly RestartEntry[]): Promise<void> {
  const byWs = new Map<string, { resumed: RestartEntry[]; not: RestartEntry[] }>()
  for (const [list, which] of [[resumed, 'resumed'], [not, 'not']] as const)
    for (const e of list) {
      const k = e.workspace.toLowerCase()
      if (!byWs.has(k)) byWs.set(k, { resumed: [], not: [] })
      byWs.get(k)![which].push(e)
    }
  for (const [ws, r] of byWs) {
    const home = assistantHome(ws)
    if (!existsSync(join(dataFolder(home, 'assistant'), 'project.json'))) continue
    const first = r.resumed[0] ?? r.not[0]
    const versions = first.from && first.from !== app.getVersion() ? ` (${first.from} → ${app.getVersion()})` : ''
    const resumedList = r.resumed.map((e) => `${e.agentName} (${e.project})`).join(', ')
    const body = inDialectOf({ projectPath: home, agentId: ASSISTANT_AGENT_ID }, () => say(T.assistant, { quit: policy() === 'quit' ? 'yes' : 'no', versions, hasResumed: resumedList ? 'yes' : 'no', resumed: resumedList, hasNot: r.not.length ? 'yes' : 'no', not: r.not.map((e) => `${e.agentName} (${e.project}): ${e.state}${e.why ? `, ${e.why}` : ''}`).join('; ') }))
    await leaveDelivery(home, { agentId: ASSISTANT_AGENT_ID, kind: 'control', from: HIVE, body }).catch((e) => log.warn('telling the Assistant what was resumed after the restart', e))
  }
}

// ---------------------------------------------------------------------------
// The installer's request to close for an install (installer.nsh).
// ---------------------------------------------------------------------------

/** Nonces handled in this run: a request seen again is a replay. */
const seen = new Set<string>()
let watcher: FSWatcher | null = null
let checking = false
let checkAgain = false

/**
 * Watches Hive's profile for the installer's request (and checks once now: one left from an earlier process is removed,
 * never acted on). A request for this process and copy, fresh and whole, is taken (renamed), acknowledged, and
 * `onRequest` called, once.
 */
export function watchRestartRequests(onRequest: () => void, dir = app.getPath('userData')): void {
  const check = (): void => {
    if (checking) {
      checkAgain = true
      return
    }
    checking = true
    try {
      handleRequest(dir, onRequest)
    } finally {
      checking = false
      if (checkAgain) {
        checkAgain = false
        check()
      }
    }
  }
  sweepRequests(dir)
  check()
  try {
    watcher = watch(dir, (_ev, name) => {
      if (name === REQUEST_FILE) check()
    })
    watcher.on('error', (e) => log.warn('watching for an installer request', e))
  } catch (e) {
    log.warn('watching for an installer request', e)
  }
}

export function stopWatchingRestartRequests(): void {
  watcher?.close()
  watcher = null
}

/** This process's start, as the installer reads it from Windows (its uptime back from now). */
const processStart = (): number => Date.now() - process.uptime() * 1000

function handleRequest(dir: string, onRequest: () => void): void {
  const file = join(dir, REQUEST_FILE)
  let text: string
  try {
    if (!existsSync(file)) return
    if (statSync(file).size > REQUEST_MAX_BYTES) text = 'x'.repeat(REQUEST_MAX_BYTES + 1)
    else text = readFileSync(file, 'utf8')
  } catch {
    return
  }
  const r = checkRequest(text, { pid: process.pid, startedAt: processStart(), exe: app.getPath('exe'), now: Date.now(), seen }, samePlace)
  if (!r.ok) {
    if (r.nonce) seen.add(r.nonce.toLowerCase())
    log.info(`Removed an installer's request to close: ${r.why}`)
    try {
      rmSync(file, { force: true })
    } catch {
      // Gone already.
    }
    return
  }
  const nonce = r.request.nonce.toLowerCase()
  seen.add(nonce)
  try {
    renameSync(file, join(dir, takenFile(nonce)))
    const ack = join(dir, ackFile(nonce))
    writeFileSyncAtomic(ack, `${JSON.stringify({ v: 1, nonce, pid: process.pid, at: new Date().toISOString() })}\n`)
  } catch (e) {
    log.warn("Taking the installer's request to close", e)
    return
  }
  log.info(`The installer asked Hive to close for an install (${userText(r.request.exe)}): closing`)
  onRequest()
}

function writeFileSyncAtomic(file: string, text: string): void {
  writeFileSync(`${file}.tmp`, text)
  renameSync(`${file}.tmp`, file)
}

/** What earlier requests left (taken requests, acknowledgements): removed at start, once no installer waits on them. */
function sweepRequests(dir: string): void {
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const n of names) if (/^restart-request\.[0-9a-f-]{36}\.taken$|^restart-ack-[0-9a-f-]{36}\.json(\.tmp)?$/i.test(n)) rmSync(join(dir, n), { force: true })
}

/** Once at start: the queue follows workspaces opening and stuck launches ending. */
export function initRestartRecovery(): void {
  followWorkspaces()
}
