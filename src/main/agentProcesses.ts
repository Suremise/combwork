import { join } from 'path'
import { readFileSync } from 'original-fs'
import { app } from 'electron'
import { emit, onHiveEvent, toast } from './events'
import { resolveOffer } from './notify'
import { readJson, writeJsonAtomic } from './fsutil'
import { createLogger, userText } from './logger'
import { JobHost, MAX_LISTED, type HostFailure, type JobList } from './processSupervisor'
import { brokersOnly, mayBeBroker } from './systemBrokers'
import { hiveError } from './hiveError'
import { processLabel, progressRunTitle, type AgentLeftovers, type AgentProcess } from '../shared/agentProcesses'
import type { ActivityProcess } from '../shared/activity'
import type { HiveEvent } from '../shared/types'
import { maskText } from '../shared/redact'
import { englishText, shownText, withValues, type TextPart } from '../shared/advanced'
import { msg, tr } from '../shared/i18n'
import { MAX_MARKER_LAUNCHES, MAX_MARKER_PROCESSES, type LaunchProcesses } from '../shared/unexpectedClose'

/**
 * The processes each agent's launch starts, and the ones it leaves running when it stops (#507).
 *
 * Its CLI's process (the terminal's root) goes into a Windows job object of its own as it starts, and everything it
 * starts from then on joins that job by itself, however it was started: detached, hidden, through a shell that exited
 * since. Ending a terminal ends only what is attached to its console, so a preview server or a `tail -f` the agent
 * started in the background outlives it, holding its folder and ports. When the CLI exits, what is left in its job is
 * what it left running: listed for the user to end or keep, or ended (Settings → Agents). Only the job's processes
 * are ever ended, so nothing Hive didn't start is touched: a process started before the CLI joined its job, or that
 * broke away from it, is simply not tracked.
 *
 * Job objects need Win32 calls, which Node lacks: one hidden PowerShell per Hive holds the jobs (C# through Add-Type,
 * no files), answering one line per request. Without it (PowerShell blocked) nothing is tracked, and agents stop as
 * before. Its jobs don't end processes when it closes: quitting Hive leaves running what the user chose to keep.
 *
 * What is listed is also kept in Hive's profile (leftovers.json, #614), each process by its id and start time: a quit
 * that doesn't ask (no window shown, or to install an update) or a crash leaves it there, and the next start lists again
 * those still running as the same processes (restoreLeftovers), to end by that identity (their jobs are gone by then).
 */

const log = createLogger('processes')


/** How long after the CLI exits its job is looked at: the terminal's own console processes end as it closes. */
const SETTLE_MS = 2000
/**
 * How long the helper gets to say it is ready (Add-Type compiles its C#, which antivirus may scan), and then to answer
 * each request. Test copies (unpackaged) can shorten it: HIVE_TEST_TRACKER_WAIT_MS.
 */
const WAIT_MS = 60_000
const waitMs = (): number => (!app.isPackaged && Number(process.env.HIVE_TEST_TRACKER_WAIT_MS) > 0 ? Number(process.env.HIVE_TEST_TRACKER_WAIT_MS) : WAIT_MS)
/** How often the leftovers are looked at again while there are any (they end by themselves too). */
const POLL_MS = 10_000
/** Launches whose leftovers are kept per agent (an agent restarted and stopped over and over), and in all. */
const MAX_JOBS_PER_AGENT = 5
const MAX_JOBS = 100

/** The process supervisor's C# (processSupervisor.ts), for the unit tests, which drive it with stale process identities. */
export { HOST_SOURCE } from './processSupervisor'

/** Why the host couldn't start, as agents' notice says it. */
function failureText(f: HostFailure): TextPart {
  switch (f.kind) {
    case 'test':
      return 'PowerShell refused to run its helper (HIVE_TEST_PROCESS_TRACKER)' // i18n-ignore: test copies only
    case 'noPowerShell':
      return withValues(TRACKER.noPowerShell, { error: f.error })
    case 'slowHelper':
      return withValues(TRACKER.slowHelper, { seconds: f.seconds })
    case 'refused':
      return TRACKER.refused
    case 'helperFailed':
      return withValues(TRACKER.helperFailed, { why: f.why })
  }
}

/** Hive's process supervisor (shared with the merge queue's runners, #1360): agents' launches' jobs. */
const host = new JobHost({
  waitMs,
  // Test copies (unpackaged): HIVE_TEST_PROCESS_TRACKER=fail, silent or mute.
  testMode: () => (app.isPackaged ? '' : (process.env.HIVE_TEST_PROCESS_TRACKER ?? '')),
  log,
  onJoined: () => processJoined(),
  onLost: (why) => jobsLost(why),
  onFailed: (f) => {
    problem = failureText(f)
  },
  testRequests: !app.isPackaged
})

/** The process supervisor Hive's agents use, which the merge queue's runners share (#1360). */
export function processSupervisor(): JobHost {
  return host
}

/** Told when a process joins a launch's job (the host's "new"): the running marker (lastRun.ts) is written again. */
const joinedListeners = new Set<() => void>()

function processJoined(): void {
  for (const fn of joinedListeners) {
    try {
      fn()
    } catch (e) {
      log.warn('a listener for processes joining a launch failed', e)
    }
  }
}

/**
 * Calls fn when a process joins a running launch's job, or is taken into it (#1134: one the agent started after its
 * turn's status was written, slow to start or started by a process it left). The host tells it once per launch until
 * that launch's processes are listed again (runningProcesses) or it starts, so it comes at most once per launch and
 * listing however many processes start. Returns a function that stops it.
 */
export function onLaunchProcessJoined(fn: () => void): () => void {
  joinedListeners.add(fn)
  return () => joinedListeners.delete(fn)
}

/** A launch whose processes are tracked: its job is named by its run id. */
interface Launch {
  runId: string
  projectPath: string
  agentId: string
  agentName: string
  /** Its terminal's process (the gate), once tracked: it and what it started first are the agent's CLI (#1254). */
  gate?: number
  /** That process is a launch gate (launchGate.ts), which starts only the command and waits for it. */
  gated?: boolean
}

/** Launches whose CLI is still running (or exited and being looked at). */
const running = new Map<string, Launch>()
/**
 * The running marker's memory of each tracked launch (HI-2263): its processes as runningProcesses last listed them. A
 * listing that fails (the tracker going as it lists) gives these instead of none.
 */
const lastListed = new Map<string, LaunchProcesses>()
/**
 * Launches still running when the tracker was lost (jobsLost): no longer tracked, but their processes as last listed stay
 * in the running marker until each launch ends (launchEnded), so a Hive that then closes unexpectedly still lists them
 * at the next start (HI-2263). That start keeps only those still running by pid and start time (stillRunningOf).
 */
const untrackedRunning = new Map<string, LaunchProcesses>()
/** Launches whose CLI has exited, settling (findLeftovers): still in `running` for a moment, but never kept as running. */
const endingRuns = new Set<string>()
/**
 * What stopped launches left running, per launch, newest last. `restored`: kept from before Hive restarted (#614), with
 * no job: its processes are known by their ids and start times only.
 */
const left = new Map<string, Launch & { processes: AgentProcess[]; more: number; since: string; restored?: boolean }>()
let poll: ReturnType<typeof setInterval> | null = null

/**
 * How a launch's processes came to an end, as its job showed it (#1434: a slot's writer is released only on `ended`):
 * `ended`, its job seen empty (at its CLI's exit, or its leftovers since, or ended by Hive); `kept`, its leftovers kept
 * running by the user and no longer followed; `unknown`, it wasn't tracked, its job couldn't be listed, or the tracker
 * lost it. A run with none yet is still going (or has leftovers being followed). Bounded: the oldest are forgotten.
 */
export type RunOutcome = 'ended' | 'kept' | 'unknown'
const outcomes = new Map<string, RunOutcome>()
const outcomeListeners = new Set<(runId: string, outcome: RunOutcome) => void>()
const MAX_OUTCOMES = 500
function settleRun(runId: string, outcome: RunOutcome): void {
  if (outcomes.has(runId)) return
  outcomes.set(runId, outcome)
  while (outcomes.size > MAX_OUTCOMES) outcomes.delete(outcomes.keys().next().value!)
  // Its binding is settled once it is known to have taken no slot's writer (HI-2303): no receipt is ever read for it.
  if (!writerRuns.has(runId)) dropBinding(runId)
  for (const f of outcomeListeners) {
    try {
      f(runId, outcome)
    } catch (e) {
      log.warn('after a launch settled', e)
    }
  }
}
/** A launch's outcome, once known (RunOutcome). */
export const runOutcome = (runId: string): RunOutcome | null => outcomes.get(runId) ?? null
/** Told each launch's outcome as it becomes known. */
export function onRunOutcome(fn: (runId: string, outcome: RunOutcome) => void): () => void {
  outcomeListeners.add(fn)
  return () => outcomeListeners.delete(fn)
}
/**
 * Ended launches whose leftovers Hive was asked to end (#1434): a kill is only asked, so their jobs are kept and looked
 * at again at each poll until seen empty (`ended`), or, after CONFIRM_POLLS polls still not, given up (`unknown`).
 */
const confirming = new Map<string, number>()
const CONFIRM_POLLS = 30
/** Whether a job's listing shows it empty: no process described and none beyond those (its whole membership). */
const emptyJob = (list: { processes: readonly unknown[]; more: number } | null): boolean => !!list && !list.processes.length && !list.more
/** For tests: an outcome as the tracker would give it. */
export const settleRunForTests = (runId: string, outcome: RunOutcome): void => settleRun(runId, outcome)

const agentKey = (projectPath: string, agentId: string): string => `${projectPath.toLowerCase()}\n${agentId}`

/** Why a launch doesn't start: stopped while it was being tracked (the launch gate prints it in English, launchGate.ts). */
export const STOPPED_BEFORE_START = 'it was stopped before it started' // i18n-ignore: the launch gate's reason, printed in the terminal by its script in English (CLI-facing)

/**
 * Whether a launch's processes are tracked, and if not, why: in English (`reason`, for the log and the launch gate) and as
 * text for the notice (`text`, when it isn't the English). Stopped meanwhile, it doesn't start (STOPPED_BEFORE_START).
 */
export type TrackResult = { tracked: true } | { tracked: false; reason: string; text?: TextPart }

/**
 * Puts a launch's terminal process (its gate, launchGate.ts) in the launch's job, so everything it starts is tracked.
 * Resolves once it is, or with why not. `cancelled` aborted meanwhile (the terminal exited): the job is let go, so
 * nothing is assigned to it after.
 */
export async function trackLaunch(launch: Launch, pid: number, cancelled?: AbortSignal): Promise<TrackResult> {
  // log: TrackResult.reason is the log's (and the launch gate's, for a launch stopped before it started); the notice says its text (sessions.ts untracked)
  if (process.platform !== 'win32') return { tracked: false, reason: englishText(TRACKER.windowsOnly), text: TRACKER.windowsOnly }
  // A lost helper's revocation is written before any launch is given to the one that replaces it (HI-2055), however
  // late the loss: before this launch, while its helper is made ready, or while its job is made (HR2's round 1).
  const unrevoked = (): TrackResult => {
    log.warn(`could not track the processes of ${userText(launch.agentName)}: a lost helper's revocation couldn't be kept`)
    problem = TRACKER.noStart
    // log: as above, the log's reason; the notice says its text
    return { tracked: false, reason: englishText(TRACKER.noStart), text: TRACKER.noStart }
  }
  if (!(await revocationsWritten())) return unrevoked()
  let seen = losses
  const keeper = await keeperHelper()
  if (losses !== seen) {
    if (!(await revocationsWritten())) return unrevoked()
    seen = losses
  }
  running.set(launch.runId, { ...launch, gate: pid })
  const instance = host.instance
  const r = await host.request('add', launch.runId, pid)
  if (r === 'ok' && losses !== seen && !(await revocationsWritten())) {
    // Its job went to a helper started after a loss whose revocation isn't kept: let go, untracked.
    running.delete(launch.runId)
    void host.request('forget', launch.runId)
    return unrevoked()
  }
  if (r === 'ok' && !cancelled?.aborted) {
    if (host.usable) problem = null
    // Bound only to the very helper configured as its keeper, which made its job, no loss between (HI-2055).
    // Kept by need, never by volume (HI-2303): it goes once settled (dropBinding), however many launches come after.
    if (keeper && keeper.instance === instance && host.instance === instance && losses === seen && !(outcomes.has(launch.runId) && !writerRuns.has(launch.runId))) {
      runHelpers.delete(launch.runId)
      runHelpers.set(launch.runId, keeper.helper)
      bindingsBound()
      persist()
    }
    return { tracked: true }
  }
  if (r === 'ok') {
    running.delete(launch.runId)
    void host.request('forget', launch.runId)
    return { tracked: false, reason: STOPPED_BEFORE_START }
  }
  const text: TextPart = r === null ? (host.usable ? TRACKER.noAnswer : (problem ?? TRACKER.noStart)) : String(r)
  // log: the warning below
  const reason = englishText(text)
  log.warn(`could not track the processes of ${userText(launch.agentName)}: ${reason}`)
  problem = text
  return { tracked: false, reason, text }
}

/**
 * This Hive's identity as its slot writers name it, "pid:started" (HI-2055: agentFolders gives it), for the keeper's
 * receipts: a receipt frees only a writer of the Hive that started its helper.
 */
let hiveIdentity: (() => Promise<string>) | null = null
export function setHiveIdentity(fn: (() => Promise<string>) | null): void {
  hiveIdentity = fn
}

/** Where the keepers write their runs' states (HI-2055): Hive's profile. */
export const keeperDir = (): string => join(app.getPath('userData'), 'keeper')

/** The keeper configured on the helper running now (its instance), and that helper's identity. */
let keeperOf: { instance: number; helper: string } | null = null

/**
 * The helper running now, configured as a keeper (HI-2055): its instance and identity, or null when it can't be (no
 * helper, no identity of this Hive yet, an answer that isn't one). A launch then goes on tracked, with no binding: its
 * writer is never freed by a receipt.
 */
async function keeperHelper(): Promise<{ instance: number; helper: string } | null> {
  if (!(await host.ensure())) return null
  const instance = host.instance
  if (instance === null) return null
  if (keeperOf?.instance === instance) return keeperOf
  const who = await hiveIdentity?.().catch(() => null)
  if (!who || !/^\d+:\d+$/.test(who)) return null
  const r = await host.request('keeper', who, Buffer.from(keeperDir(), 'utf8').toString('base64url'))
  if (typeof r !== 'string' || !HELPER_ID.test(r) || host.instance !== instance) return null
  keeperOf = { instance, helper: r }
  return keeperOf
}

/** How many helpers were lost in this run (HI-2055): a launch made across one waits for its revocation to be kept. */
let losses = 0

/** A lost helper's revocation being kept (HI-2055): false while it couldn't be written (tried again at the next launch). */
let revocation: Promise<boolean> = Promise.resolve(true)

/**
 * Revokes the helper that was lost (HI-2055): kept before any launch goes to its replacement, so a receipt it writes
 * later (it may still run: ended without our seeing it exit) frees nothing. Known at once in this Hive (the clear's guard
 * reads it), durable once written.
 */
function revokeHelper(helper: string): void {
  dropRevoked(helper)
  // Read first (the bindings kept from before this start are its too), then dropped again over them, then written.
  revocation = readRecords().then(() => {
    dropRevoked(helper)
    return persistChecked()
  })
}

/**
 * A revoked helper's bindings go with its revocation (HR2's round 1): authority is the binding, and the list of revoked
 * helpers is bounded, so a helper falling off that list must have nothing left to free.
 */
function dropRevoked(helper: string): void {
  if (!revokedHelpers.includes(helper)) revokedHelpers = [...revokedHelpers, helper].slice(-MAX_REVOKED)
  for (const [run, h] of [...runHelpers]) if (h === helper) runHelpers.delete(run)
}

/** Whether every revocation is kept: one that failed is written again now. */
async function revocationsWritten(): Promise<boolean> {
  if (await revocation) return true
  revocation = persistChecked()
  return revocation
}

/** Whether a receipt's helper is still the one a run is bound to, unrevoked (HI-2055). Synchronous: a clear's guard. */
export function keeperStillBound(run: string, helper: string): boolean {
  return runHelpers.get(run) === helper && !revokedHelpers.includes(helper)
}

/** A keeper's state of a run, as the next Hive reads it (HI-2055). */
/** `more` (HI-2309, HR1's round 3): members its total counts beyond those it describes (none listed may be all of them). */
export type KeeperState = { state: 'ended'; helper: string } | { state: 'live'; helper: string; members: AgentProcess[]; more: number }

const KEEPER_FILE = /^keeper-([A-Za-z0-9_-]{1,64})\.json$/
const MAX_KEEPER_BYTES = 64 * 1024

/**
 * A run's state as its keeper wrote it, taken only when whole and its own (HI-2055): the file named after the run, at
 * most MAX_KEEPER_BYTES, version 1, the run, its Hive (`hive`, the writer's "pid:started"), a helper this profile bound
 * that run to and hasn't revoked, `observed: complete`, and a state: "ended" with no member and total 0, or "live" with
 * its members by id, start time and name. Anything else, null: its writer stays held.
 */
export async function keeperState(run: string, hive: string): Promise<KeeperState | null> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(run)) return null
  await readRecords()
  const file = join(keeperDir(), `keeper-${run}.json`)
  let s: Record<string, unknown>
  try {
    const { readFile, stat } = await import('original-fs/promises')
    if ((await stat(file)).size > MAX_KEEPER_BYTES) return null
    s = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
  if (!s || typeof s !== 'object' || s.v !== 1 || s.run !== run || s.hive !== hive || s.observed !== 'complete') return null
  const helper = s.helper
  if (typeof helper !== 'string' || !HELPER_ID.test(helper) || !keeperStillBound(run, helper)) return null
  const total = s.total
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0 || !Array.isArray(s.members) || s.members.length > MAX_LISTED) return null
  if (s.state === 'ended') return total === 0 && s.members.length === 0 ? { state: 'ended', helper } : null
  if (s.state !== 'live') return null
  const members: AgentProcess[] = []
  for (const m of s.members as unknown[]) {
    const e = m as { pid?: unknown; created?: unknown; name?: unknown }
    if (typeof e?.pid !== 'number' || !Number.isSafeInteger(e.pid) || e.pid <= 0 || typeof e.created !== 'string' || !/^\d{1,20}$/.test(e.created) || e.created === '0' || typeof e.name !== 'string' || e.name.length > 260) return null
    members.push({ pid: e.pid, name: e.name, label: processLabel(e.name, ''), created: e.created })
  }
  if (total < members.length) return null
  // A console window's host ends with the process it serves: counted (the job isn't empty), never listed (listJob's way).
  return { state: 'live', helper, members: members.filter((p) => !/^(conhost|openconsole)(\.exe)?$/i.test(p.name)), more: total - members.length }
}

/** How long asking a gone Hive's keeper for its run now may take (HI-2313): a bound for one that doesn't answer. */
const KEEPER_ASK_MS = 5000

/** The pipe a keeper answers on while it keeps (HI-2313), named after its identity ("pid:created"). */
export const keeperPipe = (helper: string): string => `\\\\.\\pipe\\hive-keeper-${helper.replace(':', '-')}`

/** A keeper's answer of a run's job now (HI-2313): its members described (console hosts left out, counted), `more` beyond. */
export type KeeperObservation = { helper: string; members: AgentProcess[]; more: number }

/**
 * A gone Hive's run as its keeper observes it now (HI-2313): asked of the helper its run is bound to (unrevoked), over its
 * pipe, which it serves while it keeps; the keeper sweeps for the asking, never answering from a state written before.
 * Null unless the answer is whole and its own: one line, version 1, this run, that helper, the writer's Hive (`hive`,
 * "pid:started"), `now` and `observed: complete`, every member by id, start time and name, its total at least those
 * described. Anything else (no binding, no pipe, no answer within KEEPER_ASK_MS, unsure, a job it doesn't hold): null,
 * and its writer stays held. It ends nothing; what it says is decided by the one rule (nothingHolds).
 */
export async function keeperObservation(run: string, hive: string): Promise<KeeperObservation | null> {
  if (process.platform !== 'win32' || !/^[A-Za-z0-9_-]{1,64}$/.test(run)) return null
  await readRecords()
  const helper = runHelpers.get(run)
  if (!helper || !HELPER_ID.test(helper) || !keeperStillBound(run, helper)) return null
  const line = await askKeeper(keeperPipe(helper), `observe ${run}\n`) // i18n-ignore: the keeper's request, a protocol word
  return line === null ? null : parseObservation(line, run, helper, hive)
}

/** One line asked of a keeper's pipe, and its answer's one line; null when none came whole within KEEPER_ASK_MS. */
async function askKeeper(pipe: string, ask: string): Promise<string | null> {
  const { connect } = await import('net')
  return new Promise((resolve) => {
    let got = ''
    let done = false
    const finish = (line: string | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.destroy()
      resolve(line)
    }
    const timer = setTimeout(() => finish(null), KEEPER_ASK_MS)
    const socket = connect({ path: pipe })
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(ask))
    socket.on('data', (d: string) => {
      got += d
      const nl = got.indexOf('\n')
      if (nl >= 0) finish(got.slice(0, nl))
      else if (got.length > MAX_KEEPER_BYTES) finish(null)
    })
    socket.on('error', () => finish(null))
    socket.on('close', () => finish(null))
  })
}

/** A keeper's answer (HI-2313) taken only whole and its own (keeperObservation); exported for the unit tests. */
export function parseObservation(line: string, run: string, helper: string, hive: string): KeeperObservation | null {
  let s: Record<string, unknown>
  try {
    s = JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }
  if (!s || typeof s !== 'object' || Array.isArray(s) || s.v !== 1 || s.run !== run || s.helper !== helper || s.hive !== hive || s.state !== 'now' || s.observed !== 'complete') return null
  const total = s.total
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0 || !Array.isArray(s.members) || s.members.length > MAX_LISTED || total < s.members.length) return null
  const members: AgentProcess[] = []
  for (const m of s.members as unknown[]) {
    const e = m as { pid?: unknown; created?: unknown; name?: unknown }
    if (!e || typeof e !== 'object' || typeof e.pid !== 'number' || !Number.isSafeInteger(e.pid) || e.pid <= 0 || typeof e.created !== 'string' || !/^\d{1,20}$/.test(e.created) || e.created === '0' || typeof e.name !== 'string' || e.name.length > 260) return null
    members.push({ pid: e.pid, name: e.name, label: processLabel(e.name, ''), created: e.created })
  }
  // A console window's host ends with the process it serves: counted, not listed (keeperState's way).
  return { helper, members: members.filter((p) => !/^(conhost|openconsole)(\.exe)?$/i.test(p.name)), more: total - members.length }
}

/** A run's writer settled (HI-2055): its keeper's state and its binding go. */
export function forgetKeeperRun(run: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(run)) return
  void import('original-fs/promises').then(({ unlink }) => unlink(join(keeperDir(), `keeper-${run}.json`))).catch(() => undefined)
  dropBinding(run)
}

/** Keepers' states older than this are let go at the start (HI-2055): their writers stay held (Release Slot…). */
const KEEPER_STALE_MS = 7 * 24 * 60 * 60 * 1000

/** Removes keepers' states left long ago (HI-2055), at most 500 looked at, all through the async file system. */
export async function pruneKeeperStates(now = Date.now()): Promise<void> {
  const { readdir, stat, unlink } = await import('original-fs/promises')
  const names = (await readdir(keeperDir()).catch(() => [] as string[])).filter((n) => KEEPER_FILE.test(n) || (n.startsWith('keeper-') && n.endsWith('.tmp'))).slice(0, 500)
  for (const n of names) {
    const f = join(keeperDir(), n)
    const s = await stat(f).catch(() => null)
    if (s && now - s.mtimeMs > KEEPER_STALE_MS) await unlink(f).catch(() => undefined)
  }
  await settleOrphanBindings()
}

/**
 * An earlier Hive's bindings that nothing can ever be read for (HI-2303): their helper has gone and wrote no state. Only
 * that helper writes a run's state, before it exits, so its absence once the helper is gone is final; a helper still
 * running (keeping), one whose state can't be told, or a state there (even a "live" one) keeps the binding. This lets
 * go what a slot removed while held, or a binding kept before bindings were kept by need, would otherwise keep forever.
 */
async function settleOrphanBindings(): Promise<void> {
  await readRecords()
  const helpers = [...new Set(runHelpers.values())]
  if (!helpers.length || !(await trackingReady())) return
  const procs = helpers.map((h) => {
    const [pid, created] = h.split(':')
    return { pid: Number(pid), name: '', label: '', created }
  })
  const alive = await stillRunning(procs)
  if (!alive) return
  const helpersAlive = new Set(alive.processes.map(identity))
  const { stat } = await import('original-fs/promises')
  let dropped = 0
  for (const [run, h] of [...runHelpers]) {
    if (helpersAlive.has(h)) continue
    // This Hive's own helper is running: only an earlier one's bindings get here.
    if (host.instance !== null && keeperOf?.helper === h) continue
    // A state there, or one that can't be told absent: kept. Settled or rebound meanwhile: left as it is now.
    if (await stat(join(keeperDir(), `keeper-${run}.json`)).then(() => true, (e: NodeJS.ErrnoException) => e?.code !== 'ENOENT')) continue
    if (runHelpers.get(run) !== h) continue
    runHelpers.delete(run)
    dropped++
  }
  if (!dropped) return
  log.info(`Let go of ${dropped} keeper binding(s) whose helper has gone and left no state`)
  persist()
}

/**
 * The launch's CLI has exited: what is still running in its job a moment later is what it left. Resolves with it once
 * known (none: the job is forgotten).
 */
export function launchEnded(runId: string): Promise<AgentLeftovers | null> {
  const p = findLeftovers(runId)
  settling.add(p)
  void p.finally(() => settling.delete(p))
  return p
}

/** Launches being looked at as their CLIs exit (launchEnded). */
const settling = new Set<Promise<unknown>>()

/**
 * The memory running agents take now (#562): each running launch's processes (its CLI and all it started), measured by
 * the job host. Null when it can't be told (no agent running, not Windows, the tracker not working).
 */
export async function agentsMemory(): Promise<{ agents: number; bytes: number } | null> {
  const ids = [...running.keys()]
  if (process.platform !== 'win32' || !ids.length || !host.usable) return null
  const r = await host.request('memory', ids.join(','))
  if (!Array.isArray(r)) return null
  const each = r.filter((n): n is number => typeof n === 'number' && n > 0)
  return each.length ? { agents: each.length, bytes: each.reduce((a, b) => a + b, 0) } : null
}

/**
 * What running agents' launches have started, now (#987): each launch's job, its CLI and all it started, each process by
 * id and start time (one without can't be told from a later process with its id, so it is left out), within the
 * marker's bounds. For the running marker (lastRun.ts), so that after Hive is ended without quitting, the next start
 * knows them. A launch whose job can't be listed (the tracker going meanwhile), or that was running when the tracker was
 * lost, gives its processes as last listed (HI-2263). Empty when no launch is tracked; never starts the host.
 */
export async function runningProcesses(): Promise<LaunchProcesses[]> {
  if (process.platform !== 'win32') return []
  const out: LaunchProcesses[] = []
  if (running.size && host.pid) {
    for (const l of [...running.values()].slice(-MAX_MARKER_LAUNCHES)) {
      const list = await listJob(l.runId)
      if (!list) {
        // Not listed now: as last listed (jobsLost may have moved it meanwhile).
        const kept = lastListed.get(l.runId) ?? untrackedRunning.get(l.runId)
        if (kept) out.push(kept)
        continue
      }
      const processes = list.processes.filter((p) => p.created).slice(0, MAX_MARKER_PROCESSES)
      const entry = { projectPath: l.projectPath, agentId: l.agentId, agentName: l.agentName, runId: l.runId, processes }
      // Only while it is still tracked: a launch ended (or lost) while it was listed isn't remembered again.
      if (running.has(l.runId)) {
        if (processes.length) lastListed.set(l.runId, entry)
        else lastListed.delete(l.runId)
      }
      if (processes.length) out.push(entry)
    }
  }
  // Forgotten once their launches are no longer tracked (ended, or lost: then kept below).
  for (const runId of lastListed.keys()) if (!running.has(runId)) lastListed.delete(runId)
  const listed = new Set(out.map((l) => l.runId))
  for (const l of untrackedRunning.values()) if (!listed.has(l.runId)) out.push(l)
  return out.slice(-MAX_MARKER_LAUNCHES)
}

/**
 * Whether a process is one of an agent's own (#1435): in the job of one of its running launches, started between the two
 * clock readings (Unix ms) its starter took around it. Its pid and window alone prove nothing: a process of another
 * agent's, or of nobody's, isn't in that job.
 */
export async function inAgentLaunch(projectPath: string, agentId: string, pid: number, after: number, before: number): Promise<boolean> {
  if (process.platform !== 'win32' || !host.pid) return false
  for (const l of running.values()) {
    if (agentKey(l.projectPath, l.agentId) !== agentKey(projectPath, agentId)) continue
    const p = (await listJob(l.runId))?.processes.find((x) => x.pid === pid && x.created)
    if (!p?.created) continue
    const started = Number((BigInt(p.created) - 116444736000000000n) / 10000n)
    if (started >= after - 50 && started <= before + 50) return true
  }
  return false
}

/** A running launch's processes now, for the Activity tab (#1254): its agent, run and job's processes (at most MAX_LISTED). */
export interface LaunchNow {
  agentId: string
  runId: string
  /** The agent's CLI and its terminal: listed, never ended from here (Stop does). */
  cli: number[]
  processes: ActivityProcess[]
  more: number
}

/**
 * What a project's running agents' launches run now (#1254): each launch's job, as Stop's tracking has it. Empty when
 * none is tracked; never starts the host.
 */
export async function projectLaunches(projectPath: string): Promise<LaunchNow[]> {
  if (process.platform !== 'win32' || !host.pid) return []
  const out: LaunchNow[] = []
  for (const l of running.values()) {
    if (l.projectPath.toLowerCase() !== projectPath.toLowerCase()) continue
    const list = await listJob(l.runId, true)
    if (!list) continue
    out.push({ agentId: l.agentId, runId: l.runId, cli: cliOf(l, list.processes), processes: list.processes, more: list.more })
  }
  return out
}

/** The launches running now, each tracked in its job (HI-2111: what their commands left running is looked for). */
export function runningLaunches(): { runId: string; projectPath: string; agentId: string; agentName: string }[] {
  return [...running.values()].map((l) => ({ runId: l.runId, projectPath: l.projectPath, agentId: l.agentId, agentName: l.agentName }))
}

/**
 * Each of these running launches' processes with its parent's state and CPU time (HI-2111, the host's "lineage"), by
 * run id. Null when the host can't say; never starts the host.
 */
export async function launchLineage(runIds: readonly string[]): Promise<Record<string, unknown> | null> {
  if (process.platform !== 'win32' || !runIds.length || !host.pid) return null
  const r = await host.request('lineage', runIds.join(','))
  return r && typeof r === 'object' && !Array.isArray(r) ? (r as Record<string, unknown>) : null
}

/** A running launch's processes now, with their command lines, masked (HI-2111: what a notice names); null when unknown. */
export async function launchProcessesNow(runId: string): Promise<ActivityProcess[] | null> {
  if (process.platform !== 'win32' || !running.has(runId) || !host.pid) return null
  return (await listJob(runId, true))?.processes ?? null
}

/** A launch's own CLI among its processes: its gate and what the gate started. */
function cliOf(l: Launch, processes: readonly AgentProcess[]): number[] {
  return l.gate ? [l.gate, ...processes.filter((p) => p.parent === l.gate).map((p) => p.pid)] : []
}

/**
 * Ends one of an agent's own processes (#1254, the Activity tab): only while it is in that agent's running launch's
 * job as the process the user saw (its id and start time), never its CLI (Stop ends that), never by name. `notOwn`:
 * none of its running launches has it now (ended already, or another's); `cli`: the agent's CLI.
 */
export async function endAgentProcess(projectPath: string, agentId: string, pid: number, created: string): Promise<'ended' | 'notOwn' | 'cli' | 'failed'> {
  if (process.platform !== 'win32' || !host.pid) return 'notOwn'
  for (const l of running.values()) {
    if (agentKey(l.projectPath, l.agentId) !== agentKey(projectPath, agentId)) continue
    const processes = (await listJob(l.runId))?.processes ?? []
    const p = processes.find((x) => x.pid === pid && x.created === created)
    if (!p) continue
    if (cliOf(l, processes).includes(pid)) return 'cli'
    const ended = await endProcessesExactly([p])
    log.info(`ended ${userText(p.label)} (pid ${pid}) of ${userText(l.agentName)} from the Activity tab${ended ? '' : ': it still runs'}`)
    return ended ? 'ended' : 'failed'
  }
  return 'notOwn'
}

/** Once every launch that has exited has been looked at (Hive quitting asks about all their leftovers at once). */
export async function leftoversSettled(): Promise<void> {
  while (settling.size) await Promise.allSettled([...settling])
}

async function findLeftovers(runId: string): Promise<AgentLeftovers | null> {
  // Ended: what it had started is no longer the running marker's, kept since the tracker was lost (HI-2263); and a loss
  // from now on, while it settles, keeps nothing of it (jobsLost skips an ended launch).
  endingRuns.add(runId)
  untrackedRunning.delete(runId)
  const launch = running.get(runId)
  if (!launch) {
    endingRuns.delete(runId)
    settleRun(runId, 'unknown')
    return null
  }
  try {
    await new Promise((r) => setTimeout(r, SETTLE_MS))
  } finally {
    // HR1's round 1: a loss during the wait may have kept it all the same; never past its end.
    untrackedRunning.delete(runId)
    endingRuns.delete(runId)
  }
  running.delete(runId)
  looking.set(runId, launch)
  try {
    return await lookAt(runId, launch)
  } finally {
    looking.delete(runId)
  }
}

/** A launch being looked at as its CLI exits, its job listed: Hive quitting meanwhile keeps its record (HI-1886). */
const looking = new Map<string, Launch>()

async function lookAt(runId: string, launch: Launch): Promise<AgentLeftovers | null> {
  let list = await listJob(runId)
  // The gate waits for its CLI, so a CLI still running once the gate has exited lost its terminal (HI-1819): started as
  // the terminal was killed (Hive quitting just after a launch), after its console had ended what was attached to it.
  // It has no console and can't be used: ended, never listed as a leftover to keep.
  const orphans = launch.gated && launch.gate ? orphanedCli(list?.processes ?? [], launch.gate) : []
  if (orphans.length) {
    const ended = await endProcessesExactly(orphans)
    log.info(`ended ${userText(launch.agentName)}'s CLI, which outlived its terminal: ${userText(orphans.map((p) => p.label).join('; '))}${ended ? '' : ' (it still runs)'}`)
    list = await listJob(runId)
  }
  // Empty only when its whole membership is: members not described (more) are still members, left as leftovers.
  if (!list || (await nothingHolds(list.processes, list.more, launch.agentName))) {
    void host.request('forget', runId)
    settleRun(runId, list ? 'ended' : 'unknown')
    return null
  }
  left.set(runId, { ...launch, processes: list.processes, more: list.more, since: new Date().toISOString() })
  log.info(`${userText(launch.agentName)} left ${list.processes.length + list.more} process(es) running: ${userText(list.processes.map((p) => p.label).join('; '))}${list.adopted ? ` (${list.adopted} adopted after leaving the job, #543)` : ''}`)
  bound(launch)
  // Kept once within the bounds, so the file never holds a launch just forgotten.
  persist()
  startPolling()
  const now = leftoversOf(launch.projectPath, launch.agentId)
  emit({ type: 'agent-leftovers', leftovers: now })
  return now
}

/** A command interpreter a CLI or setup command is started through (toSpawnable, shellCommand): its children are its foreground command. */
const WRAPPER = /^cmd\.exe$/i

/**
 * The CLI a gate started, as a lost terminal leaves it (HI-1819): the gate's child, and through a command interpreter
 * wrapping it (a .cmd launcher, a setup command) the command it runs, as far down as wrappers go. What the CLI itself
 * started stays out: its background processes are leftovers like any other. Each process is taken only with its start
 * time, and a child only if it started after its parent, so a parent's id Windows gave a later process names nothing.
 */
export function orphanedCli(processes: readonly AgentProcess[], gate: number): AgentProcess[] {
  const out: AgentProcess[] = []
  const queue = processes.filter((p) => p.parent === gate && p.created)
  for (let p = queue.shift(); p; p = queue.shift()) {
    out.push(p)
    if (!WRAPPER.test(p.name)) continue
    const parent = p
    queue.push(...processes.filter((c) => c.parent === parent.pid && c.created && BigInt(c.created) >= BigInt(parent.created!) && !out.includes(c)))
  }
  return out
}

async function listJob(runId: string, withCommands = false): Promise<{ processes: ActivityProcess[]; more: number; adopted: number } | null> {
  const r = (await host.request('list', runId)) as JobList | string | null
  if (!r || typeof r !== 'object' || !Array.isArray(r.processes)) return null
  const processes = r.processes
    // A console window's host belongs to a process of the job and ends with it: not one to list.
    .filter((p) => !/^(conhost|openconsole)\.exe$/i.test(p.name))
    .map((p) => {
      // Masked before it is shortened (#1254): a secret on a command line (a token argument) is never shown or kept.
      const cmd = p.cmd ? maskText(p.cmd) : p.cmd
      const run = progressRunTitle(cmd ?? '')
      return { pid: p.pid, name: p.name, label: processLabel(p.name, cmd), ...(p.created && p.created !== '0' ? { created: p.created } : {}), ...(p.parent ? { parent: p.parent } : {}), ...(run ? { run } : {}), ...(withCommands && cmd ? { command: cmd } : {}) }
    })
    .sort((a, b) => a.pid - b.pid)
    .slice(0, MAX_LISTED)
  const hosts = r.processes.length - r.processes.filter((p) => !/^(conhost|openconsole)\.exe$/i.test(p.name)).length
  return { processes, more: Math.max(0, r.total - hosts - processes.length), adopted: Number(r.adopted) || 0 }
}

/**
 * The one rule for whether what a run still has running holds its slot (HI-2304, HI-2309: Darren's decision, one rule in
 * one place, whichever path found the processes): nothing does, and neither do Windows' own brokers while none of what
 * they serve runs (systemBrokers.ts). True when `processes` (all of them, `more` none beyond) is empty, or each still
 * runs as the same process (id and start time) with a known broker's executable, none of their active processes
 * running on the machine. Each executable is asked of the helper by identity, never taken from a name or a command
 * line. Fails closed: a process without a start time, one gone meanwhile (the caller's next look decides), a path
 * not read, anything else, or the helper not answering. Ends nothing. `who`: for the log, when brokers are set aside
 * (null: not logged, for a look that doesn't settle anything).
 */
export async function nothingHolds(processes: readonly AgentProcess[], more: number, who: string | null): Promise<boolean> {
  if (more > 0) return false
  if (!processes.length) return true
  if (processes.some((p) => !p.created)) return false
  // Named as no broker is (most leftovers): nothing to ask. The name only rules out; the path decides.
  const test = testBrokers()
  if (!processes.every((p) => mayBeBroker(p.name) || test?.has(p.pid))) return false
  const paths = await pathsOf(processes)
  if (!paths) return false
  const found = processes.map((p) => ({ ...p, path: paths.get(identity(p)) }))
  if (found.some((p) => p.path === undefined)) return false
  const brokers = await brokersOnly(found, 0, runningNamed).catch(() => null)
  if (!brokers) return false
  if (who !== null) log.info(`${userText(who)}'s run left only ${[...new Set(brokers.map((b) => b.broker.what))].join(', ')} running (${userText(brokers.map((b) => b.process.label).join('; '))}), with none of what it serves running: not its work, so it holds nothing (the process is left running)`)
  return true
}

/** The executables of processes still running as the same processes (HI-2309, the helper's "paths"): identity → path, "" unread. */
async function pathsOf(processes: readonly AgentProcess[]): Promise<Map<string, string> | null> {
  const r = await host.request('paths', identities([...processes]))
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null
  const out = new Map<string, string>()
  const test = testBrokers()
  for (const [id, path] of Object.entries(r as Record<string, unknown>)) {
    if (typeof path !== 'string') return null
    out.set(id, test?.has(Number(id.split(':')[0])) ? TEST_BROKER_PATH() : path)
  }
  return out
}

/** Which of the executable names (lower case) run on the machine now, or null when it can't be told (HI-2304). */
async function runningNamed(names: readonly string[]): Promise<readonly string[] | null> {
  const r = await host.request('running', names.join(','))
  const now = Array.isArray(r) && r.every((x) => typeof x === 'string') ? (r as string[]) : null
  // A test copy's own names stand in only for a real answer (HR1's round 1): the request itself is always made.
  const test = now && testBrokers() ? testLines(process.env.HIVE_TEST_SYSTEM_BROKER_ACTIVE).map((l) => l.toLowerCase()) : null
  return test !== null ? names.filter((n) => test.includes(n)) : now
}

/**
 * Test copies (unpackaged): HIVE_TEST_SYSTEM_BROKER is a file of process ids, one per line, each taken as Windows
 * Sandbox's broker (no test can put one in WindowsApps), its path asked of the helper all the same; and
 * HIVE_TEST_SYSTEM_BROKER_ACTIVE a file of the executable names running now, one per line (while it is missing, none).
 */
function testBrokers(): Set<number> | null {
  if (app.isPackaged || !process.env.HIVE_TEST_SYSTEM_BROKER) return null
  return new Set(testLines(process.env.HIVE_TEST_SYSTEM_BROKER).map(Number).filter((n) => n > 0))
}
const testLines = (file: string | undefined): string[] => {
  try {
    return readFileSync(file ?? '', 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  } catch {
    return []
  }
}
const TEST_BROKER_PATH = (): string => join(process.env.ProgramW6432 || process.env.ProgramFiles || 'C:\\Program Files', 'WindowsApps', 'MicrosoftWindows.WindowsSandbox_0.0.0.0_x64__test', 'WindowsSandboxServer.exe')

/** Keeps the newest launches' leftovers within the bounds, forgetting (not ending) the oldest. */
function bound(launch: Launch): void {
  const mine = [...left.values()].filter((l) => agentKey(l.projectPath, l.agentId) === agentKey(launch.projectPath, launch.agentId))
  const over = [...mine.slice(0, Math.max(0, mine.length - MAX_JOBS_PER_AGENT)), ...[...left.values()].slice(0, Math.max(0, left.size - MAX_JOBS))]
  for (const l of over) {
    left.delete(l.runId)
    if (!l.restored) void host.request('forget', l.runId)
    settleRun(l.runId, 'unknown')
  }
}

function startPolling(): void {
  if (poll) return
  poll = setInterval(() => void refresh(), POLL_MS)
  poll.unref?.()
}

/** Looks at every launch's leftovers again: those that have ended by themselves go from the list. */
async function refresh(): Promise<void> {
  const changed = new Set<string>()
  for (const l of [...left.values()]) {
    const list = l.restored ? await stillRunning(l.processes) : await listJob(l.runId)
    if (!left.has(l.runId)) continue
    // Nothing left that holds its slot (HI-2309's one rule: none, or only idle brokers), restored from before too.
    if (list && (await nothingHolds(list.processes, list.more, l.agentName)) && left.has(l.runId)) {
      left.delete(l.runId)
      if (!l.restored) void host.request('forget', l.runId)
      if (!l.restored) settleRun(l.runId, 'ended')
      changed.add(agentKey(l.projectPath, l.agentId))
    } else if (list && (list.processes.length !== l.processes.length || list.more !== l.more || list.processes.some((p, i) => p.pid !== l.processes[i]?.pid))) {
      left.set(l.runId, { ...l, processes: list.processes, more: list.more })
      changed.add(agentKey(l.projectPath, l.agentId))
    }
  }
  for (const k of changed) {
    const [projectPath, agentId] = k.split('\n')
    const first = [...left.values()].find((l) => agentKey(l.projectPath, l.agentId) === k)
    emit({ type: 'agent-leftovers', leftovers: first ? leftoversOf(first.projectPath, first.agentId) : { projectPath, agentId, agentName: '', processes: [], more: 0, since: '' } })
  }
  if (changed.size) persist()
  // Jobs Hive asked to end: ended only once seen empty; still not after CONFIRM_POLLS looks, not known to have ended.
  for (const [runId, polls] of [...confirming]) {
    const list = await listJob(runId)
    if (!confirming.has(runId)) continue
    if (emptyJob(list) || polls + 1 >= CONFIRM_POLLS) {
      confirming.delete(runId)
      void host.request('forget', runId)
      settleRun(runId, emptyJob(list) ? 'ended' : 'unknown')
    } else confirming.set(runId, polls + 1)
  }
  if (!left.size && !confirming.size && poll) {
    clearInterval(poll)
    poll = null
  }
}

/** What an agent's stopped launches left running (empty processes when nothing). */
export function leftoversOf(projectPath: string, agentId: string): AgentLeftovers {
  const mine = [...left.values()].filter((l) => agentKey(l.projectPath, l.agentId) === agentKey(projectPath, agentId))
  const last = mine.at(-1)
  return {
    projectPath: last?.projectPath ?? projectPath,
    agentId,
    agentName: last?.agentName ?? '',
    processes: mine.flatMap((l) => l.processes),
    more: mine.reduce((n, l) => n + l.more, 0),
    since: mine[0]?.since ?? ''
  }
}

/** Every agent with leftovers, optionally only those whose project `which` accepts. */
export function allLeftovers(which: (projectPath: string) => boolean = () => true): AgentLeftovers[] {
  const keys = new Map<string, Launch>()
  for (const l of left.values()) if (which(l.projectPath)) keys.set(agentKey(l.projectPath, l.agentId), l)
  return [...keys.values()].map((l) => leftoversOf(l.projectPath, l.agentId))
}

/** What one launch (`run`) left running, as listed (Release Slot… on its held writer, #1506); null when nothing is listed. */
export function leftoversOfRun(run: string): { processes: AgentProcess[]; more: number; restored: boolean } | null {
  const l = left.get(run)
  return l ? { processes: l.processes, more: l.more, restored: !!l.restored } : null
}

/**
 * Ends what an agent's stopped launches left running (their jobs, so only processes they started), or keeps it
 * running and stops listing it; `run`: only that launch's (#1506). Resolves with how many processes were ended or kept. A launch whose processes
 * couldn't be ended stays listed (to try again, or keep), and the call then fails, saying so.
 */
export async function settleLeftovers(projectPath: string, agentId: string, how: 'end' | 'keep', run?: string): Promise<number> {
  const k = agentKey(projectPath, agentId)
  // A run's kept from before this start is listed as `restored:<run>` (#614).
  const mine = [...left.values()].filter((l) => agentKey(l.projectPath, l.agentId) === k && (run === undefined || l.runId === run || l.runId === `restored:${run}`))
  if (!mine.length) return 0
  let done = 0
  let failed = 0
  for (const l of mine) {
    if (how === 'end' && (killFailsForTests() || !(l.restored ? await endExactly(l.processes) : (await host.request('kill', l.runId)) === true))) {
      failed += l.processes.length + l.more
      continue
    }
    left.delete(l.runId)
    if (how === 'end' && !l.restored) {
      // Asked to end, not yet seen ended: its job is kept and looked at until it is empty (confirming).
      confirming.set(l.runId, 0)
      startPolling()
    } else {
      if (!l.restored) void host.request('forget', l.runId)
      if (!l.restored) settleRun(l.runId, how === 'end' ? 'ended' : 'kept')
    }
    done += l.processes.length + l.more
  }
  persist()
  const name = mine[0].agentName
  if (done) log.info(`${how === 'end' ? 'ended' : 'kept'} ${done} process(es) ${userText(name)} left running`)
  emit({ type: 'agent-leftovers', leftovers: leftoversOf(mine[0].projectPath, agentId) })
  if (failed) {
    log.warn(`could not end ${failed} process(es) ${userText(name)} left running`)
    throw hiveError(msg({ id: 'session.leftovers.notEnded', defaultMessage: "{n, plural, one {# process is still running: Windows didn't let Combwork end it. It stays listed in the ⋯ menu on the agent's pane, to try again or keep.} other {# processes are still running: Windows didn't let Combwork end them. They stay listed in the ⋯ menu on the agent's pane, to try again or keep.}}", description: "Ending the processes an agent left running failed. {n} is how many are still running; the ⋯ menu on the agent's pane lists them with End and Keep." }), { n: failed })
  }
  return done
}

/**
 * A notice's End Them / Keep Running (HI-2320, Darren: "End Them must confirm the exact processes (PID and start
 * time), never just the PID"): the launches it lists, each with its processes by id and start time, as shown.
 */
interface ShownLaunch {
  run: string
  ids: string[]
  more: number
}
/**
 * A notice's offer: each launch as it showed it, and the processes themselves (pid and start time), frozen as shown
 * (HR2's round 2): End Them ends exactly these, never what the kept list says after an await.
 */
const offersShown = new Map<string, { projectPath: string; agentId: string; agentName?: string; runs: (ShownLaunch & { frozen: readonly AgentProcess[] })[] }>()

const shownOf = (l: { runId: string; processes: AgentProcess[]; more: number }): ShownLaunch => ({ run: l.runId, ids: l.processes.map((p) => `${p.pid}:${p.created ?? ''}`).sort(), more: l.more })

/** Whether a launch still lists exactly what the notice showed: the same processes (id and start time) and as many more. */
function stillAsShown(r: ShownLaunch): boolean {
  const l = left.get(r.run)
  if (!l) return false
  const now = shownOf(l)
  return now.more === r.more && now.ids.length === r.ids.length && now.ids.every((x, i) => x === r.ids[i])
}

const LO = {
  ended: msg({ id: 'main.leftovers.offerEnded', defaultMessage: '{n, plural, one {Ended # process} other {Ended # processes}}', description: "What the notice of processes an agent left running says once End Them ended them (HI-2320), in place of its buttons. {n} is how many." }),
  kept: msg({ id: 'main.leftovers.offerKept', defaultMessage: 'Kept running', description: "What the notice of processes an agent left running says once Keep Running was chosen (HI-2320), in place of its buttons." }),
  endedSome: msg({ id: 'main.leftovers.offerEndedSome', defaultMessage: "{n, plural, one {Ended the # process listed} other {Ended the # processes listed}}; {more, plural, one {# started since still runs: see the ⋯ menu on the agent's pane} other {# started since still run: see the ⋯ menu on the agent's pane}}", description: "What the notice of processes an agent left running says after End Them ended exactly the ones it listed while others started since still run (HI-2320), in place of its buttons. {n} and {more} are how many. The ⋯ menu on the agent's pane lists them with End and Keep." }),
  incomplete: msg({ id: 'main.leftovers.offerIncomplete', defaultMessage: "Combwork couldn't list them all, so it can't end exactly these: see the ⋯ menu on the agent's pane", description: "What the notice of processes an agent left running says when End Them is pressed but the notice couldn't list every process (more than it shows, or one without a start time), so Hive won't end them from it (HI-2320). The ⋯ menu on the agent's pane lists them with End and Keep." }),
  unchecked: msg({ id: 'main.leftovers.offerUnchecked', defaultMessage: "Combwork couldn't check what runs now, so it ended nothing. Try again.", description: "An error after End Them or Keep Running on the notice of processes an agent left running: Hive couldn't read what the agent's processes are now, so it did nothing (HI-2320)." }),
  notEnded: msg({ id: 'main.leftovers.offerNotEnded', defaultMessage: "{n, plural, one {Windows didn't let Combwork end the process listed. Try again.} other {Windows didn't let Combwork end all # processes listed. Try again.}}", description: "An error after End Them on the notice of processes an agent left running: some of the processes it listed still run (HI-2320). {n} is how many it listed." }),
  gone: msg({ id: 'main.leftovers.offerGone', defaultMessage: 'They have ended', description: "What the notice of processes an agent left running says once they ended by themselves, or were ended or kept elsewhere (HI-2320), in place of its buttons." }),
  changed: msg({ id: 'main.leftovers.offerChanged', defaultMessage: "They changed since this notice: see them in the ⋯ menu on the agent's pane", description: "What the notice of processes an agent left running says once what runs is no longer exactly what it listed (HI-2320): its End Them would end processes it didn't show, so its buttons go. The ⋯ menu on the agent's pane lists them with End and Keep." })
}

/**
 * The offer of a notice about what an agent left running (HI-2320): its key names the launches it lists, and what each
 * listed then is kept, so End Them acts only on exactly those processes (settleOffer) and a newer launch's notice is
 * another offer.
 */
export function leftoversOffer(projectPath: string, agentId: string): string {
  const k = agentKey(projectPath, agentId)
  const mine = [...left.values()].filter((l) => agentKey(l.projectPath, l.agentId) === k)
  const offer = `leftovers:${k}#${mine.map((l) => l.runId).join(',')}`
  offersShown.set(offer, { projectPath, agentId, agentName: mine[0]?.agentName, runs: mine.map((l) => ({ ...shownOf(l), frozen: Object.freeze(l.processes.map((p) => Object.freeze({ ...p }))) })) })
  watchLeftoverOffers()
  return offer
}

/** Offers whose End Them or Keep Running runs now: their own outcome says what happened, not the reconciler (HR2's round 1). */
const offersSettling = new Set<string>()

/** A launch's processes as they are now (the job's, or a restored launch's still running by id and start time): null if Hive can't tell. */
async function listedNow(l: { runId: string; processes: AgentProcess[]; restored?: boolean }): Promise<{ processes: AgentProcess[]; more: number } | null> {
  return l.restored ? await stillRunning(l.processes) : await listJob(l.runId)
}

/**
 * End Them or Keep Running, from a notice (HI-2320, Darren: "End Them must confirm the exact processes (PID and start
 * time), never just the PID"; HR2's round 1). Checked first against what runs now, read again from the job (never the
 * list kept since the last look): each launch the notice listed must still have exactly the processes it showed, by id
 * and start time, and none beyond them. End Them then ends exactly those processes (each only while it is still that
 * process), never the whole job, so a process started since the notice is never touched; what the launch has left
 * after that stays listed (the agent's ⋯ menu). A notice that couldn't list them all (some beyond the list, one without
 * a start time) can't be checked, and says so. Gone, it says they ended; changed, it says so and ends nothing. A failure
 * to end keeps the offer and its buttons (to try again) and throws.
 */
export async function settleOffer(offer: string, how: 'end' | 'keep'): Promise<void> {
  const o = offersShown.get(offer)
  const done = (text: string): void => {
    offersShown.delete(offer)
    resolveOffer(offer, text)
  }
  if (!o || o.runs.every((r) => !left.has(r.run))) return done(tr(LO.gone))
  if (offersSettling.has(offer)) return
  offersSettling.add(offer)
  try {
    if (how === 'end' && o.runs.some((r) => r.more > 0 || r.ids.some((id) => id.endsWith(':')))) return done(tr(LO.incomplete))
    // What runs now, from the job itself.
    for (const r of o.runs) {
      const l = left.get(r.run)
      if (!l) return done(tr(LO.changed))
      const now = await listedNow(l)
      if (!now) throw hiveError(LO.unchecked, undefined, { kind: 'conflict' })
      const seen = shownOf({ runId: r.run, processes: now.processes, more: now.more })
      if (seen.more !== r.more || seen.ids.join(',') !== r.ids.join(',')) return done(tr(LO.changed))
    }
    if (how === 'keep') {
      for (const r of o.runs) await settleLeftovers(o.projectPath, o.agentId, 'keep', r.run)
      return done(tr(LO.kept))
    }
    // What the notice showed and the user authorised, frozen when it was made: never widened from the kept list, which a
    // poll may have changed during the awaits above (HR2's round 2).
    const shown = o.runs.flatMap((r) => r.frozen)
    if (!(await endProcessesExactly(shown))) throw hiveError(LO.notEnded, { n: shown.length }, { kind: 'conflict' })
    // Each launch looked at again: one now empty is settled as ended; one with something started since stays listed.
    let left_ = 0
    for (const r of o.runs) {
      const l = left.get(r.run)
      if (!l) continue
      const now = await listedNow(l)
      if (now && !now.processes.length && !now.more) {
        left.delete(r.run)
        if (!l.restored) {
          void host.request('forget', r.run)
          settleRun(r.run, 'ended')
        }
      } else if (now) {
        left.set(r.run, { ...l, processes: now.processes, more: now.more })
        left_ += now.processes.length + now.more
      }
    }
    persist()
    emit({ type: 'agent-leftovers', leftovers: leftoversOf(o.projectPath, o.agentId) })
    log.info(`ended exactly the ${shown.length} process(es) a notice listed for ${userText(o.agentName ?? o.agentId)}${left_ ? `; ${left_} started since still run` : ''}`)
    return done(left_ ? tr(LO.endedSome, { n: shown.length, more: left_ }) : tr(LO.ended, { n: shown.length }))
  } finally {
    offersSettling.delete(offer)
  }
}

/** For tests (HI-2320's offers): what a launch left running, put as the poll would have listed it, and all of it cleared. */
export const leftoverOffersForTests = {
  put: (l: { runId: string; projectPath: string; agentId: string; agentName: string; processes: AgentProcess[]; more: number; restored?: boolean }): void => void left.set(l.runId, { ...l, since: new Date().toISOString() } as never),
  drop: (run: string): void => void left.delete(run),
  clear: (): void => {
    left.clear()
    offersShown.clear()
  }
}

let watchingOffers = false

/**
 * As an agent's leftovers change (ended, kept, ended by themselves, or another process listed), a notice's offer that
 * no longer shows exactly what runs loses its buttons (HI-2320). Watched from the first offer on.
 */
function watchLeftoverOffers(): void {
  if (watchingOffers) return
  watchingOffers = true
  onHiveEvent(reconcileLeftoverOffers)
}

function reconcileLeftoverOffers(e: HiveEvent): void {
  if (e.type !== 'agent-leftovers' || !offersShown.size) return
  const k = agentKey(e.leftovers.projectPath, e.leftovers.agentId)
  for (const [offer, o] of offersShown) {
    // Its own End Them or Keep Running is under way: that says what happened.
    if (agentKey(o.projectPath, o.agentId) !== k || offersSettling.has(offer)) continue
    if (o.runs.every((r) => !left.has(r.run))) {
      offersShown.delete(offer)
      resolveOffer(offer, tr(LO.gone))
    } else if (!o.runs.every(stillAsShown)) {
      offersShown.delete(offer)
      resolveOffer(offer, tr(LO.changed))
    }
  }
}

/** Ends or keeps every agent's leftovers (Hive quitting): those that can't be ended keep running. */
export async function settleAllLeftovers(how: 'end' | 'keep'): Promise<number> {
  let n = 0
  for (const l of allLeftovers()) n += await settleLeftovers(l.projectPath, l.agentId, how).catch(() => 0)
  return n
}

/** Test copies (unpackaged): HIVE_TEST_JOB_KILL_FAILS=1 makes ending a launch's processes fail, as Windows refusing would. */
const killFailsForTests = (): boolean => !app.isPackaged && process.env.HIVE_TEST_JOB_KILL_FAILS === '1'

/** Why launches can't be tracked (the host couldn't start), or why the latest one wasn't; null while all is well. */
let problem: TextPart | null = null

/** Why agents' processes aren't tracked, as the notice says it (Diagnostics has the English). */
const TRACKER = {
  noPowerShell: msg({ id: 'session.tracker.noPowerShell', defaultMessage: "PowerShell couldn't be started ({error})", description: "Why Hive can't track the processes agents start (a notice's first sentence, without its full stop). {error} is Windows' error, as it came." }),
  slowHelper: msg({ id: 'session.tracker.slowHelper', defaultMessage: "The PowerShell helper of Combwork's process tracker didn't start within {seconds, plural, one {# second} other {# seconds}}", description: "Why Hive can't track the processes agents start (a notice's first sentence, without its full stop). {seconds} is how many seconds Hive waited." }),
  refused: msg({ id: 'session.tracker.refused', defaultMessage: 'PowerShell refused to run its helper (Constrained Language Mode or a policy)', description: "Why Hive can't track the processes agents start (a notice's first sentence, without its full stop). Constrained Language Mode is PowerShell's term." }),
  helperFailed: msg({ id: 'session.tracker.helperFailed', defaultMessage: "The PowerShell helper of Combwork's process tracker didn't start ({why})", description: "Why Hive can't track the processes agents start (a notice's first sentence, without its full stop). {why} is a technical detail, as it came (\"exit 1\")." }),
  windowsOnly: msg({ id: 'session.tracker.windowsOnly', defaultMessage: 'Tracking processes needs Windows', description: "Why Hive can't track the processes agents start (a notice's first sentence, without its full stop)." }),
  noAnswer: msg({ id: 'session.tracker.noAnswer', defaultMessage: "Combwork's process tracker didn't answer", description: "Why Hive couldn't track the processes an agent starts (a notice's first sentence, without its full stop)." }),
  noStart: msg({ id: 'session.tracker.noStart', defaultMessage: "Combwork's process tracker couldn't start", description: "Why Hive can't track the processes agents start (a notice's first sentence, without its full stop)." }),
  stopped: msg({ id: 'session.tracker.stopped', defaultMessage: "Combwork's process tracker stopped ({why})", description: "Why Hive no longer tracks the processes agents start (a notice's first sentence, without its full stop). {why} is a technical detail, as it came (\"exit 1\")." })
}

/**
 * Whether launches can be tracked now: on Windows, with the job host running (started here if it isn't). A launch
 * waits for this, so it knows whether to go through its gate (launchGate.ts) or start directly, untracked.
 */
export async function trackingReady(): Promise<boolean> {
  return process.platform === 'win32' && (await host.ensure())
}

/**
 * Starts the job host in the background (#1155: Hive reopening a workspace, or one opening with agents), so the first launch after Hive
 * starts doesn't wait the half second its PowerShell takes to get going; launches still start it themselves if it
 * isn't running (trackingReady). Says nothing: a host that can't start is said by the launch that finds it so.
 */
export function warmProcessTracking(): void {
  if (process.platform === 'win32') void host.ensure()
}

/** Why agents' processes aren't being tracked, for Diagnostics (in English); null when they are. */
export function trackingProblem(): string | null {
  // window: Help → Diagnostics, in English
  return process.platform !== 'win32' || problem === null ? null : englishText(problem)
}

/** The same as text, for the notice (noteUntracked). */
// agent-text: TRACKER, failureText
export function trackingProblemText(): TextPart | null {
  return process.platform !== 'win32' ? null : problem
}

/** Hive is quitting: the host closes, and its jobs with it, ending nothing. Resolves once its helper has exited (tests wait for it). */
export function closeProcessTracking(): Promise<void> {
  if (poll) clearInterval(poll)
  poll = null
  return host.close()
}

/**
 * The host ended unexpectedly: its jobs closed, so their processes can't be told apart any more. Said at once (the
 * once-a-run notice) and kept for Diagnostics, even once a new host tracks later launches: running agents' processes
 * are no longer tracked (and keep running; nothing is ended). What was listed as left running stays listed, and kept,
 * by identity (#614): each process whose start time is known is still told from a later one with its id, so the next
 * host (started by the next request) lists and ends exactly it, as after a restart; the rest can't be, and go.
 */
function jobsLost(why: string): void {
  losses++
  // No receipt of the lost helper's frees anything from now on (HI-2055): revoked before its replacement is given a launch.
  if (keeperOf) {
    revokeHelper(keeperOf.helper)
    keeperOf = null
  }
  // It held nothing (started early, #1155, or every launch long settled): nothing is lost, and the next request starts
  // a new one.
  if (!running.size && !confirming.size && ![...left.values()].some((l) => !l.restored)) {
    log.warn(`the process job host ended (${why}) holding no launch`)
    return
  }
  const launches = running.size
  for (const runId of running.keys()) {
    settleRun(runId, 'unknown')
    // Still running, untracked from now on: what it had started stays in the running marker until it ends (HI-2263).
    const kept = lastListed.get(runId)
    if (kept && !endingRuns.has(runId)) untrackedRunning.set(runId, kept)
  }
  running.clear()
  lastListed.clear()
  // Jobs asked to end and not yet seen empty: no longer to be seen at all.
  for (const runId of confirming.keys()) settleRun(runId, 'unknown')
  confirming.clear()
  let listed = 0
  const agents = new Map<string, { projectPath: string; agentId: string }>()
  for (const l of [...left.values()]) {
    if (l.restored) continue
    const known = l.processes.filter((p) => p.created)
    listed += l.processes.length - known.length + l.more
    agents.set(agentKey(l.projectPath, l.agentId), { projectPath: l.projectPath, agentId: l.agentId })
    // No longer its job: what it left can't be told complete any more.
    settleRun(l.runId, 'unknown')
    if (known.length) left.set(l.runId, { ...l, processes: known, more: 0, restored: true })
    else left.delete(l.runId)
  }
  persist()
  for (const a of agents.values()) emit({ type: 'agent-leftovers', leftovers: leftoversOf(a.projectPath, a.agentId) })
  // i18n-ignore: Copy Diagnostics' report, in English (the design keeps diagnostics content English)
  lost = `the process tracker stopped at ${new Date().toISOString()} (${why}): ${launches} running launch(es) and ${listed} listed process(es) were no longer tracked`
  noteUntracked(withValues(TRACKER.stopped, { why }), listed ? withValues(LOST_LISTED, { listed, launches }) : withValues(LOST, { launches }))
}

/** What the tracker stopping leaves untracked: what running agents start, until they restart; and what was listed. */
const LOST = msg({ id: 'session.tracker.lost', defaultMessage: "{launches, plural, =0 {What agents start isn't tracked until they restart.} one {What the running agent starts isn't tracked until it restarts.} other {What the # running agents start isn't tracked until they restart.}}", description: "The notice after Hive's process tracker stopped: what is no longer tracked. {launches} is how many agents were running." })
const LOST_LISTED = msg({ id: 'session.tracker.lostListed', defaultMessage: "{listed, plural, one {# process listed as left running is no longer tracked (it is still running).} other {# processes listed as left running are no longer tracked (they are still running).}} {launches, plural, =0 {Nor is what agents start until they restart.} one {Nor is what the running agent starts until it restarts.} other {Nor is what the # running agents start until they restart.}}", description: "The notice after Hive's process tracker stopped: what is no longer tracked. {listed} is how many processes agents left running were listed in their panes; {launches} how many agents were running." })

/** Diagnostics: the tracker stopped earlier in this run, losing what it held; null if it never did. */
let lost: string | null = null

/** The once-a-run notice that agents' processes aren't (all) tracked has been shown. */
let told = false

/**
 * Agents' processes can't be tracked, or some no longer are (#507): said once a Hive run, in a notification, and in
 * Diagnostics (trackingProblem, trackingLost). Agents start and run all the same (decision B).
 */
export function noteUntracked(reason: TextPart | null, detail?: TextPart): void {
  if (told) return
  told = true
  log.warn(`agents' processes aren't tracked: ${userText(reason === null ? 'unknown' : englishText(reason))}`)
  toast(
    'warning',
    tr(msg({ id: 'session.tracker.title', defaultMessage: "Combwork can't keep track of agents' processes", description: "A notice's title: Hive can't track the processes agents start, so those they leave running aren't listed." })),
    tr(msg({ id: 'session.tracker.body', defaultMessage: '{reason}. {detail} Help → Copy Diagnostics says why.', description: "The notice that Hive can't track agents' processes. {reason} says why (a clause, without its full stop); {detail} is one or two sentences on what that means. Help → Copy Diagnostics is a menu command." }), {
      reason: shownText(reason ?? msg({ id: 'session.tracker.unavailable', defaultMessage: "Its process tracker isn't available", description: "Why Hive can't track the processes agents start, when it doesn't know why (a notice's first sentence, without its full stop)." })),
      detail: shownText(detail ?? msg({ id: 'session.tracker.detail', defaultMessage: "Agents start as usual, but processes they leave running when they stop aren't listed or offered to end.", description: "The notice that Hive can't track agents' processes: what that means." }))
    })
  )
}

/** Diagnostics: what the tracker lost earlier in this run when it stopped, or null. */
export function trackingLost(): string | null {
  return lost
}

/** Where what agents left running is kept for the next start (#614): Hive's profile. */
const savedFile = (): string => join(app.getPath('userData'), 'leftovers.json')

/** A stopped launch's leftovers as kept (#614): its own record, so the bounds hold across restarts. */
interface SavedLaunch {
  runId: string
  projectPath: string
  agentId: string
  agentName: string
  since: string
  processes: AgentProcess[]
}

interface SavedLeftovers {
  version: 1
  launches: SavedLaunch[]
  /**
   * Runs whose processes Hive saw end, their jobs seen empty (HI-1886): what a slot's writer of that run, its Hive gone,
   * is settled by at a later start (`endedEarlier`). Only a job seen empty proves it: a list of processes taken earlier
   * says nothing of those they started since.
   */
  ended?: string[]
  /**
   * Each tracked run's helper (HI-2055), "pid:created", as it was given its job: the only one whose keeper's "ended" frees
   * that run's slot writer after this Hive has gone.
   */
  helpers?: Record<string, string>
  /** Helpers lost while this Hive ran (HI-2055): no receipt of theirs frees anything. */
  revoked?: string[]
}

/** The latest write of the kept list (writes go one after another, the newest last). */
let saving: Promise<void> = Promise.resolve()
/** Whether the kept list on disk may hold something (written with processes, or read with some at the start). */
let keptAny = false

/** Runs seen ended (HI-1886) are kept until a writer of theirs is settled, at most this many. */
const MAX_RUN_RECORDS = 100
/** Those read at this start (kept forward until settled) and this run's own, read once before any write. */
let endedRuns: string[] = []
/**
 * Runs' helpers (HI-2055), read at the start and this run's own, kept by need (HI-2303): each until it is settled, never
 * dropped for the number of others (by age, a busy day's 100 launches pushed out one still holding a slot's writer, so
 * its keeper's "ended" freed nothing). Settled: its writer released or cleared (`runWriterReleased`, `forgetKeeperRun`),
 * its run known to have taken none (`settleRun`), its helper revoked, or gone with no state left (`settleOrphanBindings`).
 * What stays is bounded by the running launches and the held slots; past MAX_BINDINGS it is logged, never cut.
 */
let runHelpers = new Map<string, string>()
const MAX_BINDINGS = 100
/** Whether past MAX_BINDINGS was logged (once each time it is crossed). */
let bindingsOver = false
function bindingsBound(): void {
  if (runHelpers.size <= MAX_BINDINGS) {
    bindingsOver = false
    return
  }
  if (bindingsOver) return
  bindingsOver = true
  log.warn(`${runHelpers.size} keeper bindings are kept, past ${MAX_BINDINGS}: none is dropped while it may still free a slot's writer`)
}
/** A run's binding is settled (HI-2303): it goes, and the kept list is written without it. */
function dropBinding(run: string): void {
  if (runHelpers.delete(run)) {
    bindingsBound()
    persist()
  }
  // One read back at the start may arrive after: dropped from it too.
  void readRecords().then(() => {
    if (!runHelpers.delete(run)) return
    bindingsBound()
    persist()
  })
}
/** Lost helpers (HI-2055), at most MAX_REVOKED. */
let revokedHelpers: string[] = []
const MAX_REVOKED = 50
/** A helper's identity as the keeper gives it: "pid:created". */
const HELPER_ID = /^\d{1,10}:\d{1,20}$/
let recordsRead: Promise<void> | null = null
function readRecords(): Promise<void> {
  recordsRead ??= readJson<Partial<SavedLeftovers> | null>(savedFile(), null).then(
    (saved) => {
      const ended = Array.isArray(saved?.ended) ? saved.ended.filter((r): r is string => typeof r === 'string' && r.length <= 100) : []
      endedRuns = [...new Set([...ended, ...endedRuns])].slice(-MAX_RUN_RECORDS)
      const revoked = Array.isArray(saved?.revoked) ? saved.revoked.filter((h): h is string => typeof h === 'string' && HELPER_ID.test(h)) : []
      // Every revocation, kept or this run's, before the bounds: no binding to a revoked helper is taken back.
      const allRevoked = new Set([...revoked, ...revokedHelpers])
      revokedHelpers = [...allRevoked].slice(-MAX_REVOKED)
      const helpers = saved?.helpers && typeof saved.helpers === 'object' ? Object.entries(saved.helpers).filter(([r, h]) => r.length <= 100 && typeof h === 'string' && HELPER_ID.test(h) && !allRevoked.has(h)) : []
      // All of them (HI-2303): each was kept because it was still needed.
      runHelpers = new Map([...helpers, ...runHelpers].filter(([, h]) => !allRevoked.has(h)))
      bindingsBound()
      if (endedRuns.length || runHelpers.size || revokedHelpers.length) keptAny = true
    },
    () => undefined
  )
  return recordsRead
}

/**
 * Keeps what is listed now for the next start (#614): each launch apart, as listed (so within the bounds: bound runs
 * first), each process by id and start time (one whose start time couldn't be read can't be told from a later process
 * with its id, so it isn't kept). The runs seen ended (HI-1886) go with it, read first so none is lost.
 */
function persist(): void {
  void persistChecked()
}

/** persist(), resolving with whether its write succeeded (or had nothing to write): a revocation waits on it (HI-2055). */
function persistChecked(): Promise<boolean> {
  const launches: SavedLaunch[] = []
  for (const l of left.values()) {
    const processes = l.processes.filter((p) => p.created)
    if (processes.length) launches.push({ runId: l.runId, projectPath: l.projectPath, agentId: l.agentId, agentName: l.agentName, since: l.since, processes })
  }
  const done = saving
    .then(() => readRecords())
    .then(async () => {
      const any = launches.length > 0 || endedRuns.length > 0 || runHelpers.size > 0 || revokedHelpers.length > 0
      // A Hive whose agents never left anything writes no file.
      if (!any && !keptAny) return true
      keptAny = any
      const data: SavedLeftovers = {
        version: 1,
        launches,
        ...(endedRuns.length ? { ended: endedRuns } : {}),
        ...(runHelpers.size ? { helpers: Object.fromEntries(runHelpers) } : {}),
        ...(revokedHelpers.length ? { revoked: revokedHelpers } : {})
      }
      await (testHooks.write ?? writeJsonAtomic)(savedFile(), data)
      return true
    })
    .catch((e) => {
      log.warn('could not keep the list of processes agents left running', e)
      return false
    })
  saving = done.then(() => undefined)
  return done
}

/** Test seams (HI-2055): the kept list's write, to make it fail. */
export const testHooks: { write: ((path: string, data: unknown) => Promise<void>) | null } = { write: null }

/**
 * A run whose processes Hive saw end but whose slot writer couldn't be released (HI-1886: its workspace closed first):
 * kept, so a later start settles that writer once this Hive has gone.
 */
/**
 * Runs that took a slot's writer in this Hive and haven't had its release written (HI-2299): only these are kept as
 * ended at a quit. Every ended run kept instead (130 in a day) went past MAX_RUN_RECORDS, and the oldest dropped were
 * those a later start needed: a closed workspace's unwritten releases (`keepRunEnded`), kept first.
 */
const writerRuns = new Set<string>()

/** A run took a slot's writer (HI-2299). */
export function runTookWriter(run: string): void {
  writerRuns.add(run)
}

/** A run's slot writer was released, its release written (HI-2299): nothing needs its record. */
export function runWriterReleased(run: string): void {
  writerRuns.delete(run)
  // No receipt is ever read for it now (HI-2303).
  dropBinding(run)
}

export function keepRunEnded(run: string): void {
  void readRecords().then(() => {
    if (endedRuns.includes(run)) return
    endedRuns = [...endedRuns, run].slice(-MAX_RUN_RECORDS)
    persist()
  })
}

/** How long Hive's quit waits for the stopped launches' jobs to be seen empty (HI-1886), and how often it looks. */
const QUIT_LOOK_MS = 5000
const QUIT_LOOK_EVERY_MS = 250

/**
 * Hive quitting (HI-1886): the runs seen ended are kept for a later start, so their slot writers are settled if their
 * releases aren't written before Hive exits. Those already known (`ended`), and the launches whose CLI hasn't been seen
 * to exit yet, or whose job is being looked at: their jobs looked at until empty, for at most QUIT_LOOK_MS. A job seen
 * empty is the proof, as when a CLI exits (its whole membership: what its processes started joined it), and only from the
 * helper that held it as the look began; one not seen empty by then, or lost meanwhile, is kept for nothing, so its
 * writer stays held. Before the kept list's last write.
 */
export async function recordEndedLaunches(): Promise<void> {
  await readRecords()
  const ended = [...outcomes].filter(([, o]) => o === 'ended').map(([r]) => r)
  // With the launches whose leftovers were asked to end and not yet seen gone (`confirming`, HI-2055: a quit that ends
  // them must still see them end, or their writers stay held after it).
  const pending = new Set([...running.keys(), ...looking.keys(), ...confirming.keys()].filter((r) => !outcomes.has(r)))
  const until = Date.now() + QUIT_LOOK_MS
  // Only the helper holding their jobs can say they're empty (HR2's round 2): one started in its place has none of them
  // and lists any as empty. The look stops once it changes, and a run settled meanwhile (lost: `unknown`) is let go.
  const helper = host.instance
  const tracked = (run: string): boolean => host.instance === helper && (running.has(run) || looking.has(run) || confirming.has(run)) && !outcomes.has(run)
  // No helper as it begins: nothing can be seen empty.
  if (helper !== null) {
    // Launches whose leftovers are listed (HI-2309): looked at once, not waited for, since what they left may run on
    // for good. Only Windows' own idle brokers left counts as ended, as the leftovers' own look would have it.
    for (const l of [...left.values()]) {
      if (l.restored || outcomes.has(l.runId) || host.instance !== helper) continue
      const list = await listJob(l.runId).catch(() => null)
      if (host.instance !== helper || !left.has(l.runId) || outcomes.has(l.runId)) continue
      if (list && (await nothingHolds(list.processes, list.more, l.agentName))) ended.push(l.runId)
    }
    scan: while (pending.size) {
      for (const run of [...pending]) {
        if (!tracked(run)) {
          if (host.instance !== helper) break scan
          // Settled meanwhile: kept if its own look saw it end.
          if (outcomes.get(run) === 'ended') ended.push(run)
          pending.delete(run)
          continue
        }
        const list = await listJob(run).catch(() => null)
        if (host.instance !== helper) break scan
        // HI-2309's one rule: nothing left that holds its slot (none, or only idle brokers).
        if (!list || !(await nothingHolds(list.processes, list.more, (running.get(run) ?? looking.get(run))?.agentName ?? run)) || !tracked(run)) continue
        pending.delete(run)
        ended.push(run)
      }
      if (!pending.size || Date.now() >= until) break
      await new Promise((r) => setTimeout(r, QUIT_LOOK_EVERY_MS))
    }
  }
  // Only runs still naming a writer (HI-2299): no other run's record is ever read, and with them the bound dropped the
  // records that were needed. A slot has one writer, so these are few.
  const keep = ended.filter((r) => writerRuns.has(r))
  endedRuns = [...new Set([...endedRuns, ...keep])].slice(-MAX_RUN_RECORDS)
  if (keep.length || pending.size) log.info(`Kept ${keep.length} ended run(s) for their slot writers as Hive quits${pending.size ? `; ${pending.size} launch(es) not seen to end` : ''}`)
  persist()
}

/** Whether this profile kept that an earlier Hive's run was seen to end (HI-1886): its job seen empty. */
export async function endedEarlier(run: string): Promise<boolean> {
  await readRecords()
  return endedRuns.includes(run)
}

/** An earlier run's record is no longer needed: the slot writer it was kept for is settled (HI-1886). */
export function forgetEarlierRun(run: string): void {
  void readRecords().then(() => {
    if (!endedRuns.includes(run)) return
    endedRuns = endedRuns.filter((r) => r !== run)
    persist()
  })
}

/** Once the kept list is written (Hive quitting). */
export function leftoversSaved(): Promise<void> {
  return saving
}

const identity = (p: AgentProcess): string => `${p.pid}:${p.created}`
const identities = (processes: AgentProcess[]): string => processes.filter((p) => p.created).map(identity).join(',')

/**
 * Which of the processes still run as the same processes: their ids and start times, as pairs (an id alone may name a
 * later process, #614). Null when the host can't say.
 */
async function stillRunning(processes: AgentProcess[]): Promise<{ processes: AgentProcess[]; more: number } | null> {
  const list = identities(processes)
  if (!list) return { processes: [], more: 0 }
  const r = await host.request('identify', list)
  if (!Array.isArray(r)) return null
  const alive = new Set(r.map(String))
  return { processes: processes.filter((p) => p.created && alive.has(identity(p))), more: 0 }
}

/** Ends the processes, each only while it is still the same process: whether none still runs. */
async function endExactly(processes: AgentProcess[]): Promise<boolean> {
  const list = identities(processes)
  if (!list) return true
  const r = (await host.request('endexact', list)) as { ended?: number; failed?: number } | null
  return !!r && typeof r === 'object' && r.failed === 0
}

/** The kept launches that can be read, within the bounds as Hive keeps them: the newest, and each list cut. */
function boundedSaved(saved: Partial<SavedLeftovers> | null): SavedLaunch[] {
  const valid = (Array.isArray(saved?.launches) ? saved.launches : [])
    .filter((l) => l && typeof l.runId === 'string' && typeof l.projectPath === 'string' && typeof l.agentId === 'string' && Array.isArray(l.processes))
    .map((l) => ({
      ...l,
      agentName: String(l.agentName ?? ''),
      since: String(l.since ?? new Date().toISOString()),
      processes: l.processes.filter((p) => p && Number.isSafeInteger(p.pid) && p.pid > 0 && /^\d+$/.test(String(p.created))).slice(0, MAX_LISTED)
    }))
    .filter((l) => l.processes.length)
  const perAgent = new Map<string, number>()
  const kept: SavedLaunch[] = []
  // Newest last, as listed: counted from the newest.
  for (const l of valid.reverse()) {
    const k = agentKey(l.projectPath, l.agentId)
    const n = perAgent.get(k) ?? 0
    if (n >= MAX_JOBS_PER_AGENT || kept.length >= MAX_JOBS) continue
    perAgent.set(k, n + 1)
    kept.push(l)
  }
  return kept.reverse()
}

/** The start's restore of what agents left running (restoreLeftovers), once it has begun. */
let restoring: Promise<AgentLeftovers[]> | null = null

/**
 * What agents left running before Hive last closed (#614): the kept launches' processes still running as the same ones,
 * each launch listed again on its own (the agent's pane's ⋯, `session:leftovers`) within the usual bounds, and
 * returned (per agent) for Hive to offer as when an agent stops. Without the host, nothing is restored and the list
 * stays kept for the next start. Once a start.
 */
export function restoreLeftovers(): Promise<AgentLeftovers[]> {
  if (!restoring) void pruneKeeperStates().catch((e) => log.warn('removing old keepers’ states', e))
  restoring ??= restore()
  return restoring
}

/**
 * Of processes an earlier run's agents had started (the running marker's, #987), those still running as the same
 * processes (id and start time), apart from those listed as left running (#614: offered on their own, once, after the
 * start's restore). Null when the host can't say.
 */
export async function stillRunningOf(processes: readonly AgentProcess[]): Promise<AgentProcess[] | null> {
  if (!processes.length) return []
  if (!(await trackingReady())) return null
  await restoring?.catch(() => [])
  const listed = new Set([...left.values()].flatMap((l) => l.processes.map(identity)))
  const seen = new Set<string>()
  const mine = processes.filter((p) => p.created && !listed.has(identity(p)) && !seen.has(identity(p)) && seen.add(identity(p)))
  return (await stillRunning(mine))?.processes ?? null
}

/** Ends these processes, each only while it is still the same process (id and start time, #987): whether none still runs. */
export async function endProcessesExactly(processes: readonly AgentProcess[]): Promise<boolean> {
  return (await trackingReady()) && !killFailsForTests() && (await endExactly([...processes]))
}

/**
 * Ends these processes with all they started that runs now (#1008: a hive-progress run's processes, so its whole test
 * run goes, what it started since Hive listed it too), each only while it is still the process it was checked to be
 * (EndTree). failed: those that still run after it, by id and start time (no label: Hive didn't list them), for the
 * caller to report and try again; unverified: the ids of the runs' children that still run and Hive could neither end
 * nor check (#1028: once their parent has ended, nothing tells them from a process that later gets the id, so they are
 * reported, never tried again). Null when the host can't say (none ended).
 */
export async function endTreesExactly(roots: readonly AgentProcess[]): Promise<{ failed: AgentProcess[]; unverified: number[] } | null> {
  const list = identities([...roots])
  if (!list) return { failed: [], unverified: [] }
  if (!(await trackingReady()) || killFailsForTests()) return null
  const r = (await host.request('endtree', list)) as { failedIds?: unknown; unverified?: unknown } | null
  if (!r || typeof r !== 'object' || !Array.isArray(r.failedIds)) return null
  const failed = r.failedIds.flatMap((id) => {
    const [pid, created] = String(id).split(':')
    return Number(pid) > 0 && /^\d+$/.test(created ?? '') ? [{ pid: Number(pid), name: '', label: '', created }] : []
  })
  const unverified = Array.isArray(r.unverified) ? [...new Set(r.unverified.map(Number).filter((pid) => Number.isInteger(pid) && pid > 0))] : []
  return { failed, unverified }
}

async function restore(): Promise<AgentLeftovers[]> {
  const launches = boundedSaved(await readJson<Partial<SavedLeftovers> | null>(savedFile(), null))
  const all = launches.flatMap((l) => l.processes)
  if (!all.length || !(await trackingReady())) return []
  const now = await stillRunning(all)
  if (!now) return []
  // Written again below, without those that have ended or are other processes by now.
  keptAny = true
  const alive = new Set(now.processes.map(identity))
  const agents = new Map<string, { projectPath: string; agentId: string }>()
  for (const l of launches) {
    const processes = l.processes.filter((p) => alive.has(identity(p))).map((p) => ({ pid: p.pid, name: String(p.name ?? ''), label: String(p.label ?? p.name ?? ''), created: String(p.created) }))
    const runId = l.runId.startsWith('restored:') ? l.runId : `restored:${l.runId}`
    if (!processes.length || left.has(runId)) continue
    // HI-2309's one rule: what holds nothing (only Windows' own idle brokers) isn't the agent's to list.
    if (await nothingHolds(processes, 0, l.agentName)) continue
    const launch = { runId, projectPath: l.projectPath, agentId: l.agentId, agentName: l.agentName }
    left.set(runId, { ...launch, processes, more: 0, since: l.since, restored: true })
    bound(launch)
    agents.set(agentKey(l.projectPath, l.agentId), { projectPath: l.projectPath, agentId: l.agentId })
    log.info(`${userText(l.agentName)} left ${processes.length} process(es) running before Hive restarted: ${userText(processes.map((p) => p.label).join('; '))}`)
  }
  persist()
  const found = [...agents.values()].map((a) => leftoversOf(a.projectPath, a.agentId)).filter((l) => l.processes.length)
  if (found.length) startPolling()
  for (const l of found) emit({ type: 'agent-leftovers', leftovers: l })
  return found
}

/** Tests: the helper's process id while it runs. */
export function trackerPid(): number | null {
  return host.pid
}
