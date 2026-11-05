import { app, BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync, readFileSync, renameSync, rmSync, statSync } from 'original-fs'
import { rm, writeFile } from 'original-fs/promises'
import { join } from 'path'
import { agentMsg, inDefaultDialect, say } from '../shared/agentText'
import { ASSISTANT_AGENT_ID } from '../shared/assistant'
import { fmt, msg, tr } from '../shared/i18n'
import { HEARTBEAT_MS, RUN_MARKER, parseRunMarker, LeftoverStops, resumeFailedLine, resumeHeldLine, unexpectedCloseText, type LaunchProcesses, type LeftMerge, type ResumeReport, type RunMarker, type RunningAgent } from '../shared/unexpectedClose'
import type { StoredText, ToastAction } from '../shared/types'
import { endProcessesExactly, endTreesExactly, onLaunchProcessJoined, runningProcesses, stillRunningOf } from './agentProcesses'
import { assistantHome } from './assistantControl'
import { config } from './config'
import { leaveDelivery } from './deliveries'
import { journalFactAt } from './journalService'
import { onHiveEvent, toast } from './events'
import { dropOfferActions, resolveOffer } from './notify'
import { crashDumps, type CrashDump } from './exitLog'
import { renameRetrying } from './fsutil'
import { hiveError } from './hiveError'
import { createLogger, userText } from './logger'
import { sessions } from './sessions'
import { adoptInstalledRun, ownsResume } from './restartResume'
import { inWorkspace, openWorkspaces, workspaceOf } from './workspace'
import { dataFolder } from './hiveFolder'

/**
 * Hive closing unexpectedly (#984, shared/unexpectedClose.ts): the marker in the profile while Hive runs, and at the next
 * start the notice of a run that ended without quitting (when it was last seen, what was running, what the agents had
 * started that still runs with Stop Them (#987), a crash dump of it, a merge left half done), the Assistant told, and the
 * agents resumed only if Settings → Sessions says so. Nothing is stopped unless the user says so.
 */
const log = createLogger('lastRun')
const HIVE = { kind: 'hive', name: 'Combwork' } as const // i18n-ignore: the product's name, as a delivery's sender

/** What the last run left, found at this start: null when it quit normally (or this is the first run). */
export interface UnexpectedClose {
  /** When it was last seen (its last heartbeat, or the marker's time when the marker couldn't be read). */
  lastSeen: string
  startedAt: string | null
  agents: RunningAgent[]
  workspaces: string[]
  /** A crash dump made during that run (#985). */
  dump: CrashDump | null
  merges: LeftMerge[]
  /** What the agents' launches had started, as the marker kept it (#987). */
  processes: LaunchProcesses[]
}

let found: UnexpectedClose | null = null
/** The notice is out: a merge found later is told on its own. */
let told = false
let telling = false
/** Startup work the notice waits for (startupStep): each restored workspace opening, and its merge slots recovered. */
const startup = new Set<Promise<unknown>>()

/**
 * Startup work the notice depends on: a restored workspace opening (index.ts), a workspace's merge slots recovered
 * (ipc.ts, as it opens: before its opening is done). Only while there is a notice to give and it isn't out yet.
 */
export function startupStep(p: Promise<unknown>): void {
  if (!found || told) return
  const step: Promise<unknown> = p.catch(() => undefined).finally(() => startup.delete(step))
  startup.add(step)
}

/** Until every startup step has ended, steps added meanwhile (a workspace's recovery, as it opens) included. */
async function startupDone(): Promise<void> {
  if (startup.size) log.info(`The notice waits for ${startup.size} startup step(s): workspaces opening, merge slots recovered`)
  while (startup.size) await Promise.allSettled([...startup])
}
/** The agents left to resume from the notice (once). */
let toResume: RunningAgent[] = []
/**
 * What the agents had started that still ran as the notice was given, for its Stop Them (#987; those that end go), with
 * all the marker kept of it (the hive-progress runs among them, #1008), and the ids of a run's children Stop Them could
 * neither end nor check (#1028: said by every click after, never tried again).
 */
const leftovers = new LeftoverStops({ endTrees: endTreesExactly, endExact: endProcessesExactly, stillRunning: stillRunningOf })
let startedAt = ''
let ended = false
let timer: NodeJS.Timeout | null = null
let soon: NodeJS.Timeout | null = null

const markerFile = (): string => join(app.getPath('userData'), RUN_MARKER)

/** At start, before this run's marker is written: whether the last run left its marker, and what it says. */
export function checkLastRun(file = markerFile()): UnexpectedClose | null {
  found = null
  if (!existsSync(file)) return null
  let text = ''
  let at = new Date().toISOString()
  try {
    text = readFileSync(file, 'utf8')
    at = statSync(file).mtime.toISOString()
  } catch {
    // Read as a marker without its details.
  }
  const m = parseRunMarker(text)
  const since = m ? Date.parse(m.startedAt) : NaN
  const dump = crashDumps().find((d) => Number.isNaN(since) || d.at >= since) ?? null
  found = { lastSeen: m?.lastSeen ?? at, startedAt: m?.startedAt ?? null, agents: m?.agents ?? [], workspaces: m?.workspaces ?? [], dump, merges: [], processes: m?.processes ?? [] }
  // Ended by an installer that couldn't ask it to close first (HI-1707): a newer version starting now. Its agents are an
  // install's, resumed by the restart queue as the switch says, not left to this notice.
  if (m && m.hive && m.hive !== app.getVersion() && found.agents.length) adoptInstalledRun(found.agents, m.hive, found.lastSeen)
  // The agents a restart's record has (restartResume.ts owns their resume): not resumed from here too.
  toResume = found.agents.filter((a) => !ownsResume(a.projectPath, a.agentId))
  log.warn(`The last run of Combwork ended without quitting: last seen ${found.lastSeen}${m ? ` (Combwork ${m.hive}, started ${m.startedAt})` : ' (its marker could not be read)'}; ${found.agents.length} agent(s) were running${found.agents.length ? `: ${found.agents.map((a) => `${userText(a.agentName)} in ${userText(a.project)}`).join(', ')}` : ''}${dump ? `; a crash dump from ${new Date(dump.at).toISOString()}` : '; no crash dump'}`) // i18n-ignore: a line of hive.log
  return found
}

/** What the last run left, found at this start (Copy Diagnostics, tests). */
export const lastUnexpectedClose = (): UnexpectedClose | null => found

/** The agents running now, as the marker lists them (the Assistant's own session is the Assistant's, not an agent's). */
function runningAgents(): RunningAgent[] {
  const out: RunningAgent[] = []
  for (const s of sessions.liveStates()) {
    let ws: ReturnType<typeof workspaceOf>
    try {
      ws = workspaceOf(s.projectPath)
    } catch {
      continue
    }
    if (ws.isAssistantHome(s.projectPath)) continue
    const project = ws.info()?.projects.find((p) => p.path.toLowerCase() === s.projectPath.toLowerCase())?.name ?? s.projectPath.split(/[\\/]/).pop() ?? s.projectPath
    out.push({ workspace: ws.path ?? '', projectPath: s.projectPath, project, agentId: s.agentId, agentName: s.agentName ?? s.agentId, provider: s.provider, sessionId: s.sessionId, ...(s.sessionName ? { sessionName: s.sessionName } : {}) })
  }
  return out
}

/** A marker write is under way (it lists the launches' processes first), and another is due after it. */
let writing = false
let again = false

/**
 * Writes this run's marker: what the running agents' launches have started first (#987, from the process tracker's
 * jobs), then the marker. One write at a time; one asked for meanwhile follows it.
 */
function writeMarker(): void {
  if (ended) return
  if (writing) {
    again = true
    return
  }
  writing = true
  void runningProcesses()
    .catch((e) => {
      log.warn("Couldn't list what the running agents started, for the running marker", e)
      return []
    })
    .then(writeMarkerNow)
    .finally(() => {
      writing = false
      if (!again) return
      again = false
      writeMarker()
    })
}

/** A marker write stopped because the run ended meanwhile (writeMarkerFile's guard). */
class NotWanted extends Error {}

/**
 * Writes a marker whole beside its file, without holding the main process up (#1111: it was written synchronously on
 * every status change), then renames it into place, so a reader never sees half of one. The rename is tried again while
 * the marker is held for a moment (HI-2201: a reader or a virus scanner had it open, the write that had a hive-progress
 * run's processes failed with EPERM, and the marker missed them until the next heartbeat). `wanted` is asked just before
 * each rename, with nothing awaited between: a marker removed meanwhile (Hive quitting) is never put back. So each try is
 * synchronous, in the guard's turn (HR2's round 1: an asynchronous rename, started after the guard, could finish after
 * endRunMarker's removal and put the marker back); only the waits between tries are not. True if written.
 * `renameOnce` is the single rename (tests replace it).
 */
export async function writeMarkerFile(file: string, marker: RunMarker, wanted: () => boolean, renameOnce: (from: string, to: string) => Promise<void> = async (from, to) => renameSync(from, to)): Promise<boolean> {
  const tmp = `${file}.tmp`
  try {
    await writeFile(tmp, `${JSON.stringify(marker)}\n`)
    const guard = (): void => {
      if (!wanted()) throw new NotWanted()
    }
    await renameRetrying(tmp, file, 20, guard, renameOnce)
    return true
  } catch (e) {
    if (e instanceof NotWanted) {
      await rm(tmp, { force: true }).catch(() => undefined)
      return false
    }
    log.warn("Couldn't write the running marker", e)
    await rm(tmp, { force: true }).catch(() => undefined)
    return false
  }
}

/** Writes the marker now (writeMarkerFile), unless this run has ended. */
async function writeMarkerNow(processes: LaunchProcesses[]): Promise<void> {
  if (ended) return
  const marker: RunMarker = { version: 1, pid: process.pid, startedAt, lastSeen: new Date().toISOString(), hive: app.getVersion(), workspaces: openWorkspaces().flatMap((w) => (w.path ? [w.path] : [])), agents: runningAgents(), processes }
  await writeMarkerFile(markerFile(), marker, () => !ended)
}

/** A marker write two seconds from now, unless one is due already: the changes in between go in one write. */
function writeSoon(): void {
  if (soon || ended) return
  soon = setTimeout(() => {
    soon = null
    writeMarker()
  }, 2000)
  soon.unref()
}

/**
 * This run's marker: written now, every minute, and soon after an agent starts or stops, or a process joins a running
 * launch (#1134: one the agent started after its turn's write). Once, after checkLastRun().
 */
export function startRunMarker(): void {
  startedAt = new Date().toISOString()
  writeMarker()
  timer = setInterval(writeMarker, HEARTBEAT_MS)
  timer.unref()
  onHiveEvent((e) => {
    if (e.type === 'session-exit' || e.type === 'session-status' || e.type === 'workspace-changed') writeSoon()
  })
  onLaunchProcessJoined(writeSoon)
  // Windows ending the session is a clean end too: Hive may be ended without quitting after it.
  const watch = (w: BrowserWindow): void => void w.on('session-end', () => endRunMarker('Windows is ending the session')) // i18n-ignore: why, for hive.log
  for (const w of BrowserWindow.getAllWindows()) watch(w)
  app.on('browser-window-created', (_e, w) => watch(w))
  app.on('will-quit', () => endRunMarker('Combwork is quitting')) // i18n-ignore: why, for hive.log
}

/** A normal end (quitting, an update, a restart, Windows ending the session): the marker goes, and isn't written again. */
export function endRunMarker(why: string): void {
  if (ended) return
  ended = true
  if (timer) clearInterval(timer)
  if (soon) clearTimeout(soon)
  try {
    rmSync(markerFile(), { force: true })
    log.info(`Removed the running marker: ${why}`)
  } catch (e) {
    log.warn("Couldn't remove the running marker", e)
  }
}

/**
 * A merge slot hold Hive closed under (mergeSlotHost.ts): told in the notice when the last run closed unexpectedly and
 * the notice isn't out yet. False when it isn't (the caller tells it on its own).
 */
export function addLeftMerge(m: LeftMerge): boolean {
  if (!found || told) return false
  found.merges.push(m)
  return true
}

/** Resumes the agents that were running, one at a time; one already running again, or with no conversation, is left. */
async function resumeAgents(agents: readonly RunningAgent[]): Promise<ResumeReport> {
  const out: ResumeReport = { resumed: [], failed: [], held: [] }
  for (const a of agents) {
    if (sessions.liveFor(a.projectPath, a.agentId) || !a.sessionId) continue
    // Only where it may resume now (#1434): one whose slot is free or holds other work is left, and listed.
    const hold = await inWorkspace(workspaceOf(a.projectPath), () => sessions.resumeHoldFor(a.projectPath, a.agentId, a.sessionId!)).catch(() => null)
    if (hold) {
      out.held!.push({ name: a.agentName, hold })
      log.info(`Left ${userText(a.agentName)} in ${userText(a.project)} to resume by hand after the unexpected close (${hold.is})`)
      continue
    }
    try {
      await inWorkspace(workspaceOf(a.projectPath), () => sessions.start(a.projectPath, { agentId: a.agentId, resumeId: a.sessionId, auto: true, ...(a.sessionName ? { name: a.sessionName } : {}) }))
      out.resumed.push(a.agentName)
      log.info(`Resumed ${userText(a.agentName)} in ${userText(a.project)} after the unexpected close`)
    } catch (e) {
      out.failed.push({ name: a.agentName, error: e instanceof Error ? e.message : String(e) })
      log.warn(`Couldn't resume ${userText(a.agentName)} in ${userText(a.project)} after the unexpected close: ${userText(e instanceof Error ? e.message : String(e))}`)
    }
  }
  return out
}

/** The unexpected close's notice (HI-2320), and which of its buttons still have something to do. */
let closeOffer: string | null = null
let resumeOpen = false
let stopOpen = false

/**
 * One of the notice's actions is done (HI-2320, HR2's round 1): its button goes and the notice says what it did, in
 * place of another notice; with nothing left to do, the notice is resolved with it.
 */
function settled(part: 'resume' | 'stop', level: 'success' | 'error' | 'info', text: string): void {
  if (part === 'resume') resumeOpen = false
  else stopOpen = false
  if (closeOffer && !resumeOpen && !stopOpen && resolveOffer(closeOffer, text)) {
    closeOffer = null
    return
  }
  if (closeOffer && dropOfferActions(closeOffer, [part === 'resume' ? 'session.resumeAfterClose' : 'session.stopLeftAfterClose'], text)) return
  toast(level, text)
}

/** The notice's Resume All: the agents the notice listed, resumed once; the result told. */
export async function resumeAfterClose(): Promise<ResumeReport> {
  const agents = toResume
  toResume = []
  const r = await resumeAgents(agents)
  if (r.held?.length) toast('info', tr(msg({ id: 'main.unexpectedClose.heldTitle', defaultMessage: '{n, plural, one {One agent left stopped} other {# agents left stopped}}', description: "A notice's title after resuming the agents that were running when Combwork closed unexpectedly (#1434): {n} were left stopped, their conversations' slots free (only their own Resume takes one) or holding other work." }), { n: r.held.length }), resumeHeldLine(r.held))
  if (r.failed.length) {
    // Said in the notice whose Resume All it was (the button gone: its agents were each tried once).
    settled('resume', 'error', `${tr(msg({ id: 'main.unexpectedClose.resumeFailedTitle', defaultMessage: "Some agents couldn't resume", description: "A notice's title: resuming the agents that were running when Combwork closed unexpectedly failed for some." }))}: ${resumeFailedLine(r)}`)
  } else settled('resume', 'success', tr(msg({ id: 'main.unexpectedClose.resumedTitle', defaultMessage: '{n, plural, =0 {Nothing to resume} one {Resumed one agent} other {Resumed # agents}}', description: "A notice's title: the agents that were running when Combwork closed unexpectedly were resumed ({n} of them; 0: all were running again or had no conversation)." }), { n: r.resumed.length }))
  return r
}

/** What the last run's unexpected close tells the Assistant and its journal (dialects, HI-2438). */
const A = {
  assistant: agentMsg({
    id: 'restart.closed.assistant',
    text: "Combwork closed unexpectedly: last seen {lastSeen}. {agentCount, plural, =0 {No agents were running.} other {{agentCount} agent(s) were running: {agents}. {resumed}}}{still, plural, =0 {} other { {still} process(es) the agents started are still running; the user can stop them from Combwork's notice.}} Check for card loops and lanes that stalled and tell the user; don't restart or stop anything yourself.",
    note: "The line the Assistant finds in its inbox after an unexpected close (#987, #1031). agents: each running agent as \"name (project)\", joined by commas; resumed: restart.closed.resumed or restart.closed.nothingResumed; still: the processes the agents had started that still run. It doesn't act itself: the user decides."
  }),
  resumed: agentMsg({
    id: 'restart.closed.resumed',
    text: "Combwork resumed {resumed} of them (the user's setting){failed, plural, =0 {} other {; {failed} couldn't resume}}{held, plural, =0 {} other {; {held} left stopped (their slots are free, to resume by hand, or hold other work)}}.",
    note: 'With Settings → Sessions → Resume agents after an unexpected close on: how many were resumed, failed, and left stopped (#1434: their slots free, or holding other work).'
  }),
  nothingResumed: agentMsg({ id: 'restart.closed.nothingResumed', text: 'Nothing was resumed: the user decides.', note: 'With Settings → Sessions → Resume agents after an unexpected close off (the default): the notice offers Resume All.' }),
  fact: agentMsg({
    id: 'restart.closed.fact',
    text: 'Combwork closed unexpectedly (last seen {lastSeen}); {agentCount} agent(s) of this workspace were running',
    note: "The journal's fact of an unexpected close (#1031): stored, so always the Default's."
  })
}

/** The line the Assistant finds in its inbox (agent-facing). */
export function assistantLine(c: Pick<UnexpectedClose, 'agents' | 'lastSeen'>, r: ResumeReport | null, still: number): string {
  const agents = c.agents.map((a) => `${a.agentName} (${a.project})`).join(', ') // i18n-ignore: names, not wording (agent-protocol)
  const resumed = r ? say(A.resumed, { resumed: r.resumed.length, failed: r.failed.length, held: r.held?.length ?? 0 }) : say(A.nothingResumed)
  return say(A.assistant, { lastSeen: c.lastSeen, agentCount: c.agents.length, agents, resumed, still })
}

/** The journal's fact of an unexpected close, for a workspace (stored: the Default's words). */
export const closeFact = (lastSeen: string, agentCount: number): string => inDefaultDialect(() => say(A.fact, { lastSeen, agentCount }))
/** The fact's message, stored beside its English summary, to be said in each reader's dialect when read (5b, 6b). */
export const closeFactText = (lastSeen: string, agentCount: number): StoredText => ({ id: A.fact.id, values: { lastSeen, agentCount } })

/** Tells each workspace's Assistant that was open in the last run (one there to tell), for its next start. */
async function tellAssistants(c: UnexpectedClose, r: ResumeReport | null, still: number): Promise<void> {
  const homes = new Set([...c.workspaces, ...c.agents.map((a) => a.workspace)].filter(Boolean).map((w) => w.toLowerCase()))
  for (const ws of homes) {
    const home = assistantHome(ws)
    // A fact for its journal (#1031), Assistant or not.
    const count = c.agents.filter((a) => a.workspace.toLowerCase() === ws).length
    await journalFactAt(ws, { summary: closeFact(c.lastSeen, count), summaryText: closeFactText(c.lastSeen, count), importance: 2, tags: ['incident', 'unexpected-close'] })
    // A session host's own config is in its .combwork folder: none, the workspace has no Assistant to tell.
    if (!existsSync(join(dataFolder(home, 'assistant'), 'project.json'))) continue
    // Its workspace may be open in no window now (#1395): left on a lease, for its next open, not admitted for this.
    // Stored for its next start: the Default's words until stored text is said when read (5b, 6b).
    await leaveDelivery(home, { agentId: ASSISTANT_AGENT_ID, kind: 'control', from: HIVE, body: inDefaultDialect(() => assistantLine(c, r, still)) }).catch((e) => log.warn('telling the Assistant Combwork closed unexpectedly', e))
  }
}

/**
 * Once Hive's window is up: the notice of the last run's unexpected close, if there was one. With Settings → Sessions →
 * Resume agents after an unexpected close on, the agents are resumed first and the notice says so; off (the default),
 * the notice offers Resume All and nothing resumes on its own. The Assistant is told either way.
 */
export async function tellUnexpectedClose(): Promise<void> {
  const c = found
  if (!c || told || telling) return
  telling = true
  // The restored workspaces opened and their merge slots recovered: their merges are in the notice, and the agents
  // can be resumed in them. However long they take: the notice waits for them, not for a time.
  await startupDone()
  const auto = config.settings.sessions.resumeAfterUnexpectedClose === true
  const mine = c.agents.filter((a) => !ownsResume(a.projectPath, a.agentId))
  const r = auto && mine.length ? await resumeAgents(mine) : null
  if (r) toResume = []
  // What the agents had started that still runs as the same processes (#987): listed, never stopped unasked.
  const kept = c.processes.flatMap((l) => l.processes)
  const leftRunning = (await stillRunningOf(kept).catch(() => null)) ?? []
  leftovers.set(leftRunning, kept)
  if (kept.length) log.info(`Of ${kept.length} process(es) the agents had started, ${leftRunning.length} still run${leftRunning.length ? `: ${userText(leftRunning.map((p) => p.label).join('; '))}` : ''}`) // i18n-ignore: a line of hive.log
  told = true
  const actions: ToastAction[] = []
  if (!r && mine.length) actions.push({ label: tr(msg({ id: 'main.unexpectedClose.resumeAll', defaultMessage: 'Resume All', description: 'A button in the notice that Combwork closed unexpectedly: resumes the agents that were running.' })), command: 'session.resumeAfterClose' })
  if (leftRunning.length) actions.push({ label: tr(msg({ id: 'main.unexpectedClose.stopThem', defaultMessage: 'Stop Them', description: 'A button in the notice that Combwork closed unexpectedly: ends the processes the agents had started that are still running (only those, checked to be the same processes).' })), command: 'session.stopLeftAfterClose' })
  actions.push({ label: tr(msg({ id: 'main.unexpectedClose.overview', defaultMessage: 'Show Overview', description: "A button in the notice that Combwork closed unexpectedly: shows the Workspace Overview, with every project's agents." })), command: 'view.overview' })
  // It stays up for two minutes (a notice with buttons goes after 15 s), and in the Notifications panel after.
  const title = tr(msg({ id: 'main.unexpectedClose.title', defaultMessage: 'Combwork closed unexpectedly', description: "The notice's title at start when the last run of Combwork ended without quitting (killed, a crash, the power)." }))
  // Its offer (HI-2320): live while Resume All or Stop Them still has something to do; the last one's result is what it
  // says then, in place of its buttons.
  closeOffer = `lastrun:${randomUUID()}`
  resumeOpen = !r && mine.length > 0
  stopOpen = leftRunning.length > 0
  toast('warning', title, unexpectedCloseText({ ...c, dump: !!c.dump, stillRunning: leftRunning, kept }, r), actions, undefined, undefined, { offer: closeOffer, timeoutMs: 120_000 })
  await tellAssistants(c, r, leftRunning.length)
}

/**
 * The notice's Stop Them (#987): ends what the agents had started that still runs, each only while it is still the
 * same process (id and start time), so nothing else is touched. Resolves with how many were stopped; fails, saying so,
 * when some still run (they stay, to try again), and on every click while a run's child it could neither end nor check
 * may still run (#1028: no click can find it again, so the error says where to look instead of to try again).
 */
export async function stopLeftAfterClose(): Promise<number> {
  // After any click still going (#1028): it sees what that one left, never a list from before it.
  const { stopped, left, tried } = await leftovers.click()
  if (stopped) log.info(`Stopped ${stopped} process(es) the agents had started before Combwork closed unexpectedly`)
  const n = left.running.length
  const u = left.unverified.length
  if (n) log.warn(`Couldn't stop ${n} process(es) the agents had started before Combwork closed unexpectedly`)
  if (u && tried) log.warn(`${u} process(es) a test run had started may still run: Windows let Combwork neither end nor check them (ids ${left.unverified.join(', ')})`)
  // A test run's child Hive could neither end nor check may still run: never a success (#1008), on any click (#1028).
  if (!n && !u && !tried) return 0
  const ids = fmt.list(left.unverified.map(String))
  if (n && u) throw hiveError(msg({ id: 'main.unexpectedClose.notStoppedNorChecked', defaultMessage: "{n, plural, one {# process is still running: Windows didn't let Combwork end it; Stop Them in the notice tries again.} other {# processes are still running: Windows didn't let Combwork end them; Stop Them in the notice tries again.}} {u, plural, one {Another, started by a test run, may still be running: Windows let Combwork neither end nor check it, so Combwork can't find it again. Look for process ID {ids} in Task Manager's Details.} other {# others, started by a test run, may still be running: Windows let Combwork neither end nor check them, so Combwork can't find them again. Look for process IDs {ids} in Task Manager's Details.}}", description: "Stopping the processes the agents had started before Combwork closed unexpectedly failed for some. {n} is how many still run, which Stop Them (the notice's button) tries again; {u} is how many more, started by a test run, Windows let Combwork neither end nor check, so Combwork can't tell them from other processes any more: {ids} lists their process IDs (\"4242, 4250\"), to look for in Task Manager's Details tab." }), { n, u, ids })
  if (n) throw hiveError(msg({ id: 'main.unexpectedClose.notStopped', defaultMessage: "{n, plural, one {# process is still running: Windows didn't let Combwork end it.} other {# processes are still running: Windows didn't let Combwork end them.}} Stop Them in the notice tries again.", description: "Stopping the processes the agents had started before Combwork closed unexpectedly failed for some. {n} is how many still run; Stop Them is the notice's button." }), { n })
  if (u) throw hiveError(msg({ id: 'main.unexpectedClose.notChecked', defaultMessage: "{u, plural, one {A process started by a test run may still be running: Windows let Combwork neither end nor check it, so Combwork can't find it again. Look for process ID {ids} in Task Manager's Details.} other {# processes started by a test run may still be running: Windows let Combwork neither end nor check them, so Combwork can't find them again. Look for process IDs {ids} in Task Manager's Details.}}", description: "Stop Them (in the notice that Combwork closed unexpectedly) ended what it could, but {u} processes a test run had started may still run: Windows let Combwork neither end nor check them, and with what started them ended Combwork can't tell them from other processes any more, so pressing Stop Them again won't reach them. {ids} lists their process IDs (\"4242, 4250\"), to look for in Task Manager's Details tab." }), { u, ids })
  settled('stop', 'success', tr(msg({ id: 'main.unexpectedClose.stopped', defaultMessage: '{n, plural, one {Stopped one process} other {Stopped # processes}}', description: "A notice's title: the processes the agents had started before Combwork closed unexpectedly were ended ({n} of them)." }), { n: stopped }))
  return stopped
}

/** Copy Diagnostics' line about the last run (English, for the maintainer). */
export function lastRunDiagnostics(): string {
  const c = found
  if (!c) return '- The last run quit normally (or this is the first).' // i18n-ignore: Copy Diagnostics' report, in English
  const kept = c.processes.reduce((n, l) => n + l.processes.length, 0)
  const left = leftovers.leftovers
  return `- The last run ended without quitting: last seen ${c.lastSeen}${c.startedAt ? `, started ${c.startedAt}` : ''}; ${c.agents.length} agent(s) were running; ${c.dump ? 'a crash dump of it was kept' : 'no crash dump'}${c.merges.length ? `; ${c.merges.length} merge(s) left half done` : ''}${kept ? `; the agents had started ${kept} process(es), ${left.running.length} still running now${left.unverified.length ? `, ${left.unverified.length} more Stop Them could neither end nor check (ids ${left.unverified.join(', ')})` : ''}` : ''}` // i18n-ignore: Copy Diagnostics' report, in English
}
