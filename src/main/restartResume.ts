import { app } from 'electron'
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from 'original-fs'
import { rm, writeFile } from 'original-fs/promises'
import { randomUUID } from 'crypto'
import { basename, join } from 'path'
import { ASSISTANT_AGENT_ID } from '../shared/assistant'
import { RESTART_READY_SECONDS, RESUME_AFTER_UPDATE } from '../shared/advanced'
import { fmt, msg, tr } from '../shared/i18n'
import { agentKey, atStart, checkRequest, isFinal, mergeSnapshot, parseRecord, recordOpen, REQUEST_FILE, REQUEST_MAX_BYTES, RESTARTING_LINE, resumeNote, STALL_HOLD_MS, ackFile, takenFile, type RestartEntry, type RestartReason, type RestartRecord, type RestartState } from '../shared/restartResume'
import type { TaskCard, ToastAction } from '../shared/types'
import type { RunningAgent } from '../shared/unexpectedClose'
import { advanced } from './advanced'
import { assistantHome } from './assistantControl'
import { createDelivery, leaveDelivery, roundOf } from './deliveries'
import { emit, onHiveEvent } from './events'
import { samePlace } from './fsutil'
import { laneOf } from './lanes'
import { createLogger, userText } from './logger'
import { sessions } from './sessions'
import { allTasks } from './tasks'
import { inWorkspace, openWorkspaces, workspaceOf, type WorkspaceService } from './workspace'

/**
 * Restarts announced and resumed (HI-1707, shared/restartResume.ts). As Hive closes for an update, an install or a
 * restart, the agents that were working, watching or in a running lane are recorded and told; at the next start they
 * resume in their conversations one at a time, each after the last is ready (Darren's decision), with a note of where
 * they were. An ordinary quit records them too, and the next start offers to resume them. The record (restart.json in
 * the profile) keeps each agent's state until it is final, so nothing is lost to an interrupted start; this module is
 * the one owner of these resumes (lastRun.ts leaves it the agents it lists).
 */
const log = createLogger('restart')
const HIVE = { kind: 'hive', name: 'Hive' } as const // i18n-ignore: the product's name, as a delivery's sender
const RECORD_FILE = 'restart.json'

const recordFile = (): string => join(app.getPath('userData'), RECORD_FILE)

let record: RestartRecord | null = null
/** One record write at a time, in order. */
let writes: Promise<void> = Promise.resolve()
/** This run's queue (agent keys, in order), whether it is being worked, and when each was queued (the stall hold). */
const queue: string[] = []
const queuedAt = new Map<string, number>()
let pumping = false
let stopping = false
/** What this run's resumes came to, for the one report once the queue is empty. */
const done: { resumed: RestartEntry[]; failed: RestartEntry[]; held: RestartEntry[]; skipped: RestartEntry[] } = { resumed: [], failed: [], held: [], skipped: [] }
/** Starts, set by tests to shorten the readiness wait. */
let readyMsForTests: number | null = null
export const setReadyMsForTests = (ms: number | null): void => {
  readyMsForTests = ms
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
 * Whether a lane's "isn't running" stall is held for an agent: it is queued or starting in this run's recovery, queued
 * less than STALL_HOLD_MS ago. Cleared by any outcome.
 */
export function isResuming(projectPath: string, agentId: string): boolean {
  const key = agentKey({ projectPath, agentId })
  const e = entryOf(key)
  if (!e) return false
  // Pending and resuming by itself (the queue starts once the window is up): held from when the record was read.
  const waiting = e.state === 'queued' || e.state === 'starting' || (e.state === 'pending' && auto(e))
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

/** The agents to record as Hive closes, each with its card, round and lane (each workspace's board read once). */
export async function snapshotAgents(reason: RestartReason): Promise<RestartEntry[]> {
  const at = new Date().toISOString()
  const boards = new Map<string, Promise<TaskCard[]>>()
  const board = (ws: WorkspaceService): Promise<TaskCard[]> => {
    const key = (ws.path ?? '').toLowerCase()
    if (!boards.has(key)) boards.set(key, allTasks(ws, { archived: false }).catch(() => []))
    return boards.get(key)!
  }
  const out: RestartEntry[] = []
  for (const s of sessions.liveStates()) {
    let ws: WorkspaceService
    try {
      ws = workspaceOf(s.projectPath)
    } catch {
      continue
    }
    // The Assistant's own session is the Assistant's (as the running marker has it), and one with no conversation has nothing to resume.
    if (!ws.path || ws.isAssistantHome(s.projectPath) || !s.sessionId) continue
    const project = basename(s.projectPath)
    const lane = await inWorkspace(ws, () => laneOf(ws, project, s.agentId)).catch(() => null)
    if (!BUSY.has(s.status) && !lane) continue
    const card = cardFor(await board(ws), project, s.agentId, lane?.current ?? null)
    out.push({
      workspace: ws.path,
      projectPath: s.projectPath,
      project,
      agentId: s.agentId,
      agentName: s.agentName ?? s.agentId,
      provider: s.provider,
      sessionId: s.sessionId,
      ...(s.sessionName ? { sessionName: s.sessionName } : {}),
      status: s.status,
      ...(card ? { card } : {}),
      ...(lane ? { lane: { id: lane.id, name: lane.name, role: lane.builder.id === s.agentId ? 'builder' : 'reviewer' } } : {}),
      reason,
      from: app.getVersion(),
      at,
      state: 'pending',
      changedAt: at
    })
  }
  return out
}

/**
 * Hive is closing (quitNow): its agents recorded, before they are stopped. For an update, an install or a restart they
 * are told too, best effort, within `tellMs` (a line in each one's inbox: an idle one is shown it at once, a working
 * one finds it when it is resumed). The snapshot is bounded by `snapshotMs`: one that takes longer records nothing new.
 */
export async function recordClosing(reason: RestartReason, o: { snapshotMs?: number; tellMs?: number } = {}): Promise<number> {
  stopping = true
  const bounded = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> => Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms).unref())])
  const snapshot = await bounded(snapshotAgents(reason).catch((e) => (log.warn('Recording the agents as Hive closes', e), [] as RestartEntry[])), o.snapshotMs ?? 2000, [])
  // This run's queue, unfinished: its entries go back to pending (the next start checks them again).
  for (const e of record?.entries ?? []) if (e.state === 'queued' || e.state === 'starting') setState(e, 'pending')
  record = mergeSnapshot(record, snapshot)
  await save()
  if (snapshot.length) log.info(`Recorded ${snapshot.length} agent(s) as Hive closes (${reason}): ${snapshot.map((e) => `${userText(e.agentName)} in ${userText(e.project)}`).join(', ')}`) // i18n-ignore: a line of hive.log
  if (reason !== 'quit' && snapshot.length) {
    const tell = Promise.allSettled(snapshot.map((e) => inWorkspace(workspaceOf(e.projectPath), () => createDelivery(e.projectPath, { agentId: e.agentId, agentName: e.agentName, kind: 'control', from: HIVE, body: RESTARTING_LINE }))))
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
    .map((a) => ({ workspace: a.workspace, projectPath: a.projectPath, project: a.project, agentId: a.agentId, agentName: a.agentName, provider: a.provider, sessionId: a.sessionId!, ...(a.sessionName ? { sessionName: a.sessionName } : {}), status: 'unknown', reason: 'install', from, at, state: 'pending', changedAt: new Date().toISOString() })) // i18n-ignore: the record's values, not text
  if (!entries.length) return
  record = mergeSnapshot(record, entries)
  void save()
  log.info(`The last run (Hive ${from}) was ended for an install without being asked to close: ${entries.length} agent(s) recorded to resume`)
}

// ---------------------------------------------------------------------------
// At the next start: auto-resume, or offer.
// ---------------------------------------------------------------------------

/** Whether an entry resumes on its own: closed for an update, an install or a restart, with the switch on. */
const auto = (e: RestartEntry): boolean => e.reason !== 'quit' && advanced.get<boolean>(RESUME_AFTER_UPDATE) !== false

/**
 * Once Hive's window is up: each pending entry queued (auto) or offered, the offer told in one notice, and the queue
 * started. Workspaces still opening are waited for by the queue (an entry is started only once its workspace is open).
 */
export async function startRestartRecovery(): Promise<void> {
  if (!record || recoveryStarted) return
  recoveryStarted = true
  stopping = false
  const offer: RestartEntry[] = []
  for (const e of record.entries) {
    if (e.state === 'pending') {
      if (auto(e)) enqueue(e)
      else {
        setState(e, 'offered')
        offer.push(e)
      }
    } else if (e.state === 'offered' || e.state === 'held') {
      if (e.state === 'held') setState(e, 'offered')
      offer.push(e)
    }
  }
  await save()
  if (offer.length) tellOffer(offer)
  pump()
}

/** Once a start: the window's load can come more than once (a reload). */
let recoveryStarted = false

function enqueue(e: RestartEntry): void {
  const key = agentKey(e)
  setState(e, 'queued')
  if (!queue.includes(key)) queue.push(key)
  queuedAt.set(key, Date.now())
}

/** The notice offering to resume the agents (an ordinary quit, or the switch off): Resume or Don't Resume (the notice's × only closes it). */
function tellOffer(entries: readonly RestartEntry[]): void {
  const n = entries.length
  const names = fmt.list(entries.map((e) => `${e.agentName} (${e.project})`))
  const quit = entries.every((e) => e.reason === 'quit')
  const title = tr(msg({ id: 'main.restart.offerTitle', defaultMessage: '{n, plural, one {Resume the agent that was working?} other {Resume the # agents that were working?}}', description: "A notice at start: Hive was quit (or restarted for an update with resuming turned off) while agents worked. {n} is how many; Resume starts them again in their conversations." }), { n })
  const body = quit
    ? tr(msg({ id: 'main.restart.offerQuit', defaultMessage: 'Hive was quit while they were working or in a card loop: {names}. Resume starts each again in its conversation, one at a time.', description: 'The notice offering to resume agents after an ordinary quit. {names} lists them, each with its project.' }), { names })
    : tr(msg({ id: 'main.restart.offerUpdate', defaultMessage: 'Hive restarted for an update while they were working or in a card loop: {names}. Resume starts each again in its conversation, one at a time.', description: 'The notice offering to resume agents after an update, with Settings → Advanced → Resume agents after an update turned off. {names} lists them, each with its project.' }), { names })
  const actions: ToastAction[] = [
    { label: tr(msg({ id: 'main.restart.resume', defaultMessage: 'Resume', description: 'A button in the notice offering to resume the agents that were working when Hive closed.' })), command: 'session.resumeRestart' },
    { label: tr(msg({ id: 'main.restart.dismiss', defaultMessage: "Don't Resume", description: "A button in the notice offering to resume the agents that were working when Hive closed: resumes none, and the offer is not made again (the notice's × only closes it)." })), command: 'session.dismissRestart' }
  ]
  log.info(`Offered to resume ${n} agent(s): ${entries.map((e) => userText(e.agentName)).join(', ')}`)
  emit({ type: 'toast', toast: { id: randomUUID(), level: 'info', title, message: body, actions, timestamp: new Date().toISOString(), timeoutMs: 120_000 } })
}

/** The offer's Resume: its entries queued. How many. */
export async function resumeOffered(): Promise<number> {
  const offered = record?.entries.filter((e) => e.state === 'offered') ?? []
  for (const e of offered) enqueue(e)
  await save()
  pump()
  return offered.length
}

/** The offer's Don't Resume: its entries dismissed, not offered again. How many. */
export async function dismissOffered(): Promise<number> {
  const offered = record?.entries.filter((e) => e.state === 'offered') ?? []
  for (const e of offered) setState(e, 'dismissed')
  await save()
  return offered.length
}

/** Hive is quitting: no more starts from the queue (what is left stays pending in the record). */
export function stopRestartRecovery(): void {
  stopping = true
}

// ---------------------------------------------------------------------------
// The queue: one at a time, each after the last is ready.
// ---------------------------------------------------------------------------

/** The workspace an entry belongs to, when it is open in this run. */
const openWorkspaceOf = (e: RestartEntry): WorkspaceService | undefined => openWorkspaces().find((w) => !!w.path && samePlace(w.path, e.workspace))

/** Works the queue: the first entry whose workspace is open, one at a time, until none is left that can go now. */
function pump(): void {
  if (pumping || stopping) return
  pumping = true
  void (async () => {
    try {
      for (;;) {
        if (stopping) return
        const key = queue.find((k) => {
          const e = entryOf(k)
          return !!e && e.state === 'queued' && !!openWorkspaceOf(e)
        })
        if (!key) break
        queue.splice(queue.indexOf(key), 1)
        const e = entryOf(key)!
        await resumeOne(e).catch((err) => {
          setState(e, 'failed', err instanceof Error ? err.message : String(err))
          done.failed.push(e)
        })
        queuedAt.delete(key)
        await save()
      }
      // Nothing left this run can start: the report, once every queued entry has an outcome.
      if (!queue.some((k) => entryOf(k)?.state === 'queued')) report()
    } finally {
      pumping = false
    }
  })()
}

// A workspace opening (a window restoring it, or one opened later) may let queued entries go.
let following = false
function followWorkspaces(): void {
  if (following) return
  following = true
  onHiveEvent((ev) => {
    if (ev.type === 'workspace-changed' && queue.length) pump()
  })
}

/** The statuses of an agent that has taken its first prompt (a resume's note). */
const TOOK_NOTE = new Set(['working', 'finished', 'waiting', 'background'])

/** How long a resumed agent has to be ready (Settings → Advanced). */
const readyMs = (): number => readyMsForTests ?? Math.max(10, Number(advanced.get<number>(RESTART_READY_SECONDS)) || 90) * 1000

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
 * One agent: checked again just before it starts (its workspace open, the agent still there and not running, its
 * conversation still its last, no slot hold), started in its conversation with its note, and waited for until it is
 * ready. Not ready in time: failed, and its launch stopped (and gone) before the next one starts.
 */
async function resumeOne(e: RestartEntry): Promise<void> {
  const ws = openWorkspaceOf(e)
  if (!ws) {
    setState(e, 'pending')
    return
  }
  const projectInfo = ws.info()?.projects.find((p) => samePlace(p.path, e.projectPath))
  const agent = projectInfo?.agents.find((a) => a.id === e.agentId)
  const skip = (why: string): void => {
    setState(e, 'skipped', why)
    done.skipped.push(e)
    log.info(`Not resuming ${userText(e.agentName)} in ${userText(e.project)}: ${why}`)
  }
  if (!agent) return skip('removed')
  if (sessions.liveFor(e.projectPath, e.agentId)) return skip('running')
  if (agent.lastSessionId && agent.lastSessionId !== e.sessionId) return skip('movedOn')
  const hold = await inWorkspace(ws, () => sessions.resumeHoldFor(e.projectPath, e.agentId, e.sessionId)).catch(() => null)
  if (hold) {
    setState(e, 'held', hold.is)
    done.held.push(e)
    log.info(`Left ${userText(e.agentName)} in ${userText(e.project)} to resume by hand (${hold.is})`)
    return
  }
  setState(e, 'starting')
  await save()
  const ms = readyMs()
  // Ready once it has taken its note (its first prompt): seen working, or past a turn, in any status change of this
  // launch. Not `ready` (a resumed conversation's transcript is there before its CLI is, and Hive's fallback reads that
  // as ready), nor `watching` (a watch the conversation had shows as it starts).
  let took = false
  const off = onHiveEvent((ev) => {
    if (ev.type === 'session-status' && ev.state.agentId === e.agentId && samePlace(ev.state.projectPath, e.projectPath) && TOOK_NOTE.has(ev.state.status)) took = true
  })
  let ready = false
  try {
    await inWorkspace(ws, () => sessions.start(e.projectPath, { agentId: e.agentId, resumeId: e.sessionId, auto: true, ...(e.sessionName ? { name: e.sessionName } : {}), prompt: resumeNote(e, app.getVersion()) }))
    // Its launch ending meanwhile (stopped by the user, or its CLI exited) ends the wait too.
    ready = await until(() => took || TOOK_NOTE.has(sessions.liveFor(e.projectPath, e.agentId)?.status ?? 'stopped') || !sessions.liveFor(e.projectPath, e.agentId), ms)
    ready &&= took || TOOK_NOTE.has(sessions.liveFor(e.projectPath, e.agentId)?.status ?? 'stopped')
  } finally {
    off()
  }
  if (ready) {
    setState(e, 'resumed')
    done.resumed.push(e)
    log.info(`Resumed ${userText(e.agentName)} in ${userText(e.project)} after Hive restarted (${e.reason})`)
    return
  }
  // Its launch ended before it took its note: stopped (by the user, or its CLI exited), not resumed again later.
  if (!sessions.liveFor(e.projectPath, e.agentId)) {
    setState(e, 'failed', 'stopped')
    done.failed.push(e)
    log.info(`${userText(e.agentName)} in ${userText(e.project)} was stopped while it was resuming`)
    return
  }
  // Not ready: stopped, and gone, before the next one starts (never two starting at once).
  sessions.stop(e.projectPath, e.agentId)
  await until(() => !sessions.liveFor(e.projectPath, e.agentId), 10_000)
  setState(e, 'failed', 'notReady')
  done.failed.push(e)
  log.warn(`${userText(e.agentName)} in ${userText(e.project)} wasn't ready within ${Math.round(ms / 1000)} s of resuming: stopped`)
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
  const update = [...resumed, ...failed, ...held, ...skipped].some((e) => e.reason !== 'quit')
  const lines: string[] = []
  if (resumed.length) lines.push(tr(msg({ id: 'main.restart.resumedLine', defaultMessage: 'Resumed: {names}.', description: 'A line of the notice after Hive resumed agents when it started again. {names} lists them, each with its project.' }), { names: fmt.list(resumed.map((e) => `${e.agentName} (${e.project})`)) }))
  for (const e of [...failed, ...held, ...skipped]) lines.push(tr(msg({ id: 'main.restart.notResumedLine', defaultMessage: 'Not resumed: {agent} ({project}): {why}.', description: 'A line of the notice after Hive resumed agents when it started again: one it did not resume, and why.' }), { agent: e.agentName, project: e.project, why: whyText(e) }))
  const title = update
    ? tr(msg({ id: 'main.restart.reportUpdate', defaultMessage: '{n, plural, one {Resumed one agent after the update} other {Resumed # agents after the update}}', description: "A notice's title: Hive restarted for an update and resumed the agents that were working. {n} is how many resumed." }), { n: resumed.length })
    : tr(msg({ id: 'main.restart.reportResume', defaultMessage: '{n, plural, one {Resumed one agent} other {Resumed # agents}}', description: "A notice's title: the agents that were working when Hive was quit were resumed, as the user asked. {n} is how many." }), { n: resumed.length })
  emit({ type: 'toast', toast: { id: randomUUID(), level: failed.length ? 'warning' : 'success', title, message: lines.join('\n'), timestamp: new Date().toISOString(), timeoutMs: 60_000 } })
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
    if (!existsSync(join(home, '.hive', 'project.json'))) continue
    const first = r.resumed[0] ?? r.not[0]
    const versions = first.from && first.from !== app.getVersion() ? ` (${first.from} → ${app.getVersion()})` : ''
    const body = `Hive restarted${first.reason === 'quit' ? ' after a quit' : ' for an update'}${versions}. Resumed: ${r.resumed.map((e) => `${e.agentName} (${e.project})`).join(', ') || 'none'}.${r.not.length ? ` Not resumed: ${r.not.map((e) => `${e.agentName} (${e.project}): ${e.state}${e.why ? `, ${e.why}` : ''}`).join('; ')}.` : ''} Each resumed agent was told where it was; check their lanes carry on.` // i18n-ignore: the Assistant's inbox (agent-facing, English)
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
let again = false

/**
 * Watches Hive's profile for the installer's request (and checks once now: one left from an earlier process is removed,
 * never acted on). A request for this process and copy, fresh and whole, is taken (renamed), acknowledged, and
 * `onRequest` called, once.
 */
export function watchRestartRequests(onRequest: () => void, dir = app.getPath('userData')): void {
  const check = (): void => {
    if (checking) {
      again = true
      return
    }
    checking = true
    try {
      handleRequest(dir, onRequest)
    } finally {
      checking = false
      if (again) {
        again = false
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

/** Once at start: the queue follows workspaces opening. */
export function initRestartRecovery(): void {
  followWorkspaces()
}
