import { join } from 'path'
import { app } from 'electron'
import { emit, toast } from './events'
import { readJson, writeJsonAtomic } from './fsutil'
import { createLogger, userText } from './logger'
import { JobHost, MAX_LISTED, type HostFailure, type JobList } from './processSupervisor'
import { hiveError } from './hiveError'
import { processLabel, progressRunTitle, type AgentLeftovers, type AgentProcess } from '../shared/agentProcesses'
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
}

/** Launches whose CLI is still running (or exited and being looked at). */
const running = new Map<string, Launch>()
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
  if (process.platform !== 'win32') return { tracked: false, reason: englishText(TRACKER.windowsOnly), text: TRACKER.windowsOnly }
  running.set(launch.runId, launch)
  const r = await host.request('add', launch.runId, pid)
  if (r === 'ok' && !cancelled?.aborted) {
    if (host.usable) problem = null
    return { tracked: true }
  }
  if (r === 'ok') {
    running.delete(launch.runId)
    void host.request('forget', launch.runId)
    return { tracked: false, reason: STOPPED_BEFORE_START }
  }
  const text: TextPart = r === null ? (host.usable ? TRACKER.noAnswer : (problem ?? TRACKER.noStart)) : String(r)
  const reason = englishText(text)
  log.warn(`could not track the processes of ${userText(launch.agentName)}: ${reason}`)
  problem = text
  return { tracked: false, reason, text }
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
 * knows them. Empty when no launch is tracked; never starts the host.
 */
export async function runningProcesses(): Promise<LaunchProcesses[]> {
  if (process.platform !== 'win32' || !running.size || !host.pid) return []
  const out: LaunchProcesses[] = []
  for (const l of [...running.values()].slice(-MAX_MARKER_LAUNCHES)) {
    const list = await listJob(l.runId)
    const processes = (list?.processes ?? []).filter((p) => p.created).slice(0, MAX_MARKER_PROCESSES)
    if (processes.length) out.push({ projectPath: l.projectPath, agentId: l.agentId, agentName: l.agentName, processes })
  }
  return out
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

/** Once every launch that has exited has been looked at (Hive quitting asks about all their leftovers at once). */
export async function leftoversSettled(): Promise<void> {
  while (settling.size) await Promise.allSettled([...settling])
}

async function findLeftovers(runId: string): Promise<AgentLeftovers | null> {
  const launch = running.get(runId)
  if (!launch) {
    settleRun(runId, 'unknown')
    return null
  }
  await new Promise((r) => setTimeout(r, SETTLE_MS))
  running.delete(runId)
  const list = await listJob(runId)
  // Empty only when its whole membership is: members not described (more) are still members, left as leftovers.
  if (!list || emptyJob(list)) {
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

async function listJob(runId: string): Promise<{ processes: AgentProcess[]; more: number; adopted: number } | null> {
  const r = (await host.request('list', runId)) as JobList | string | null
  if (!r || typeof r !== 'object' || !Array.isArray(r.processes)) return null
  const processes = r.processes
    // A console window's host belongs to a process of the job and ends with it: not one to list.
    .filter((p) => !/^(conhost|openconsole)\.exe$/i.test(p.name))
    .map((p) => {
      const run = progressRunTitle(p.cmd ?? '')
      return { pid: p.pid, name: p.name, label: processLabel(p.name, p.cmd), ...(p.created && p.created !== '0' ? { created: p.created } : {}), ...(p.parent ? { parent: p.parent } : {}), ...(run ? { run } : {}) }
    })
    .sort((a, b) => a.pid - b.pid)
    .slice(0, MAX_LISTED)
  const hosts = r.processes.length - r.processes.filter((p) => !/^(conhost|openconsole)\.exe$/i.test(p.name)).length
  return { processes, more: Math.max(0, r.total - hosts - processes.length), adopted: Number(r.adopted) || 0 }
}

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
    if (emptyJob(list)) {
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

/**
 * Ends what an agent's stopped launches left running (their jobs, so only processes they started), or keeps it
 * running and stops listing it. Resolves with how many processes were ended or kept. A launch whose processes
 * couldn't be ended stays listed (to try again, or keep), and the call then fails, saying so.
 */
export async function settleLeftovers(projectPath: string, agentId: string, how: 'end' | 'keep'): Promise<number> {
  const k = agentKey(projectPath, agentId)
  const mine = [...left.values()].filter((l) => agentKey(l.projectPath, l.agentId) === k)
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
    throw hiveError(msg({ id: 'session.leftovers.notEnded', defaultMessage: "{n, plural, one {# process is still running: Windows didn't let Hive end it. It stays listed in the ⋯ menu on the agent's pane, to try again or keep.} other {# processes are still running: Windows didn't let Hive end them. They stay listed in the ⋯ menu on the agent's pane, to try again or keep.}}", description: "Ending the processes an agent left running failed. {n} is how many are still running; the ⋯ menu on the agent's pane lists them with End and Keep." }), { n: failed })
  }
  return done
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
  slowHelper: msg({ id: 'session.tracker.slowHelper', defaultMessage: "The PowerShell helper of Hive's process tracker didn't start within {seconds, plural, one {# second} other {# seconds}}", description: "Why Hive can't track the processes agents start (a notice's first sentence, without its full stop). {seconds} is how many seconds Hive waited." }),
  refused: msg({ id: 'session.tracker.refused', defaultMessage: 'PowerShell refused to run its helper (Constrained Language Mode or a policy)', description: "Why Hive can't track the processes agents start (a notice's first sentence, without its full stop). Constrained Language Mode is PowerShell's term." }),
  helperFailed: msg({ id: 'session.tracker.helperFailed', defaultMessage: "The PowerShell helper of Hive's process tracker didn't start ({why})", description: "Why Hive can't track the processes agents start (a notice's first sentence, without its full stop). {why} is a technical detail, as it came (\"exit 1\")." }),
  windowsOnly: msg({ id: 'session.tracker.windowsOnly', defaultMessage: 'Tracking processes needs Windows', description: "Why Hive can't track the processes agents start (a notice's first sentence, without its full stop)." }),
  noAnswer: msg({ id: 'session.tracker.noAnswer', defaultMessage: "Hive's process tracker didn't answer", description: "Why Hive couldn't track the processes an agent starts (a notice's first sentence, without its full stop)." }),
  noStart: msg({ id: 'session.tracker.noStart', defaultMessage: "Hive's process tracker couldn't start", description: "Why Hive can't track the processes agents start (a notice's first sentence, without its full stop)." }),
  stopped: msg({ id: 'session.tracker.stopped', defaultMessage: "Hive's process tracker stopped ({why})", description: "Why Hive no longer tracks the processes agents start (a notice's first sentence, without its full stop). {why} is a technical detail, as it came (\"exit 1\")." })
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
  return process.platform !== 'win32' || problem === null ? null : englishText(problem)
}

/** The same as text, for the notice (noteUntracked). */
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
  // It held nothing (started early, #1155, or every launch long settled): nothing is lost, and the next request starts
  // a new one.
  if (!running.size && !confirming.size && ![...left.values()].some((l) => !l.restored)) {
    log.warn(`the process job host ended (${why}) holding no launch`)
    return
  }
  const launches = running.size
  for (const runId of running.keys()) settleRun(runId, 'unknown')
  running.clear()
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
    tr(msg({ id: 'session.tracker.title', defaultMessage: "Hive can't keep track of agents' processes", description: "A notice's title: Hive can't track the processes agents start, so those they leave running aren't listed." })),
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
}

/** The latest write of the kept list (writes go one after another, the newest last). */
let saving: Promise<void> = Promise.resolve()
/** Whether the kept list on disk may hold something (written with processes, or read with some at the start). */
let keptAny = false

/**
 * Keeps what is listed now for the next start (#614): each launch apart, as listed (so within the bounds: bound runs
 * first), each process by id and start time (one whose start time couldn't be read can't be told from a later process
 * with its id, so it isn't kept).
 */
function persist(): void {
  const launches: SavedLaunch[] = []
  for (const l of left.values()) {
    const processes = l.processes.filter((p) => p.created)
    if (processes.length) launches.push({ runId: l.runId, projectPath: l.projectPath, agentId: l.agentId, agentName: l.agentName, since: l.since, processes })
  }
  // A Hive whose agents never left anything writes no file.
  if (!launches.length && !keptAny) return
  keptAny = launches.length > 0
  const data: SavedLeftovers = { version: 1, launches }
  saving = saving.then(() => writeJsonAtomic(savedFile(), data)).catch((e) => log.warn('could not keep the list of processes agents left running', e))
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
