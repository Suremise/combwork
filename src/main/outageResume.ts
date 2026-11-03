import { OUTAGE_CHECK_FIRST_SECONDS, OUTAGE_CHECK_MOST_SECONDS, OUTAGE_RESUME, OUTAGE_RESUMES_PER_HOUR, OUTAGE_WAIT_MINUTES, outageCheckUrlId } from '../shared/advanced'
import { formatTime } from '../shared/dates'
import { agentMsg, inDialectOf, say, type AgentMsg, type AgentValues } from '../shared/agentText'
import { ASSISTANT_AGENT_ID } from '../shared/assistant'
import { msg, tr } from '../shared/i18n'
import type { LiveSessionState } from '../shared/types'
import { getAccount } from './accounts'
import { advanced } from './advanced'
import { noteForAssistant } from './assistantNotes'
import { deliverNow } from './deliveries'
import { onHiveEvent, toast } from './events'
import { createLogger } from './logger'
import { clock, connectionDropped, OutageResume, reachable, type OutageAgent, type OutageHost } from './outageCore'
import { progress, progressGate } from './progressService'
import { sessions } from './sessions'
import { workspaceOf } from './workspace'
import { pausedFor } from './teamPause'

/**
 * Resuming agents after a connection drops (HI-1612, SPEC §6.3). Off by default (Settings → Advanced, Hive's "Resume
 * agents after a connection drops"). An agent whose turn ended on a connection error (its CLI's words, as the failed
 * turn keeps them, found by the CLI's pattern and not by the one for a usage limit, a sign-in or "overloaded") waits
 * for its CLI's API host to answer, checked with a request that never holds main's thread, backing off; once it
 * answers, its own conversation gets one note to rerun what was cut off. Its status and a Progress run say it waits.
 * It gives up after the wait's limit, or when a turn ends on a connection error again after three resumes in an hour:
 * the PC's own network may not have come back (Darren's 25 Oct case needed a restart), so the user is told the likely
 * fixes, and the Assistant too. Anything else that starts the agent's turn (the user, a wake) or ends its launch ends
 * the wait.
 */
const log = createLogger('outage')
const HIVE = { kind: 'hive', name: 'Hive' } as const // i18n-ignore: the product's name, as a delivery's sender

const M = {
  waiting: msg({ id: 'session.status.waitingForConnection', defaultMessage: 'Waiting for the connection…', description: "An agent's status while Hive waits for its CLI's connection to come back, to resume it (Settings → Advanced, Resume agents after a connection drops)." }),
  progressTitle: msg({ id: 'main.outage.progressTitle', defaultMessage: '{agent}: waiting for the connection', description: "A Progress panel run's title while Hive waits for an agent's connection to come back, to resume it. {agent} is the agent's name." }),
  progressWaiting: msg({ id: 'main.outage.progressWaiting', defaultMessage: 'the connection to come back', description: 'What a Progress panel run waits for, after "Waiting for": the connection of an agent whose turn a dropped connection ended.' }),
  resumedSummary: msg({ id: 'main.outage.resumedSummary', defaultMessage: 'Resumed: the connection dropped at {dropped} and came back at {back}.', description: "A Progress panel run's summary: Hive resumed an agent once its connection came back. {dropped} and {back} are times of day." }),
  gaveUpTitle: msg({ id: 'main.outage.gaveUpTitle', defaultMessage: "{agent}'s connection keeps dropping", description: "A notice's title: an agent's connection dropped again after Hive had resumed it several times in an hour, so Hive stopped resuming it. {agent} is the agent's name." }),
  gaveUpBody: msg({ id: 'main.outage.gaveUpBody', defaultMessage: "{n, plural, one {It was resumed once in the past hour} other {It was resumed # times in the past hour}} and stopped again, so Combwork won't resume it again by itself. This PC's network may not have recovered: try renewing its network adapter's addresses (ipconfig /renew), flushing DNS (ipconfig /flushdns) or restarting the PC, then resume it.", description: 'The notice that Hive stopped resuming an agent whose connection kept dropping. {n} is how many times it was resumed in the past hour. ipconfig /renew and ipconfig /flushdns are Windows commands: keep them.' }),
  timedOutTitle: msg({ id: 'main.outage.timedOutTitle', defaultMessage: "{agent}'s connection didn't come back", description: "A notice's title: Hive waited for an agent's connection to come back, to resume it, and gave up. {agent} is the agent's name." }),
  timedOutBody: msg({ id: 'main.outage.timedOutBody', defaultMessage: "Combwork waited {minutes, plural, one {# minute} other {# minutes}} and stopped waiting. If other apps can reach the internet, this PC's network may not have recovered: try renewing its network adapter's addresses (ipconfig /renew), flushing DNS (ipconfig /flushdns) or restarting the PC, then resume it.", description: 'The notice that Hive stopped waiting for an agent\'s connection. {minutes} is how long it waited. ipconfig /renew and ipconfig /flushdns are Windows commands: keep them.' }),
  gaveUpStatus: msg({ id: 'session.status.connectionKeepsDropping', defaultMessage: 'Stopped: its connection keeps dropping', description: "An agent's status once Hive stopped resuming it: its connection dropped again after several resumes in an hour." }),
  timedOutStatus: msg({ id: 'session.status.connectionNotBack', defaultMessage: "Stopped: its connection didn't come back", description: "An agent's status once Hive stopped waiting for its connection to come back." })
}

/** What the Assistant is told (agent messages, said in its dialect). */
const A = {
  resumed: agentMsg({ id: 'notice.outage.resumed', text: "{agent}'s connection dropped at {dropped}; it came back at {back} and Hive resumed it.", note: "HI-1612: the Assistant's notice that an agent's dropped connection came back and Hive resumed it. agent: its name; dropped, back: times of day (notice.outage.clock)." }),
  gaveUp: agentMsg({ id: 'notice.outage.gaveUp', text: "{agent}'s connection dropped again after {resumes} resumes in an hour: Hive stopped resuming it. The PC's network may not have recovered; the user was told the likely fixes (ipconfig /renew, ipconfig /flushdns, a restart).", note: "HI-1612: the Assistant's notice that Hive stopped resuming an agent whose connection kept dropping. agent: its name; resumes: how many in the past hour. ipconfig /renew and /flushdns are Windows commands." }),
  timedOut: agentMsg({ id: 'notice.outage.timedOut', text: "{agent}'s connection didn't come back within {minutes} minutes: Hive stopped waiting. The user was told the likely fixes.", note: "HI-1612: the Assistant's notice that Hive stopped waiting for an agent's connection. agent: its name; minutes: how long it waited." }),
  after: agentMsg({ id: 'notice.outage.after', text: '(Settings → Advanced: Resume agents after a connection drops.)', note: "HI-1612: what ends the Assistant's connection notices: the setting that turns these resumes on and off." })
}

/** An agent of a launch, as the wait names it. */
function agentOf(st: LiveSessionState): OutageAgent | null {
  if (!st.projectPath || !st.failedTurn) return null
  const conn = st.launchedConnection?.server ? getAccount(st.launchedConnection.id) : undefined
  return {
    key: `${st.projectPath.toLowerCase()}|${st.agentId}`,
    projectPath: st.projectPath,
    agentId: st.agentId,
    runId: st.runId,
    provider: st.provider,
    turn: st.failedTurn.since,
    ...(conn?.server?.baseUrl ? { baseUrl: conn.server.baseUrl } : {}),
    assistant: workspaceOf(st.projectPath).isAssistantHome(st.projectPath)
  }
}

/** The agent's name as notices show it: its project, and its own name where the project has several. */
function nameOf(a: OutageAgent): string {
  return sessions.agentLabel(a.projectPath, a.agentId)
}

/** Each waiting agent's Progress run. */
const runs = new Map<string, { id: string; caller: Parameters<typeof progress.start>[0] }>()

/** A line for the Assistant (agents resumed together come in one notice: assistantNotes.ts), said in its dialect. */
function tellAssistant(a: OutageAgent, line: AgentMsg, values: () => AgentValues): void {
  if (a.assistant) return
  const said = inDialectOf({ projectPath: workspaceOf(a.projectPath).assistantHome, agentId: ASSISTANT_AGENT_ID }, () => ({ line: say(line, values()), after: say(A.after) }))
  noteForAssistant(a.projectPath, said.line, said.after)
}

function startRun(a: OutageAgent): void {
  if (!progressGate.on()) return
  const st = sessions.liveFor(a.projectPath, a.agentId)
  if (!st) return
  const ws = workspaceOf(a.projectPath).path
  if (!ws) return
  const caller = { source: 'agent' as const, workspacePath: ws, projectPath: a.projectPath, agentId: a.agentId, agentName: st.agentName ?? a.agentId, provider: a.provider }
  try {
    const run = progress.start(caller, { title: tr(M.progressTitle, { agent: nameOf(a) }), waiting: tr(M.progressWaiting) })
    runs.set(a.key, { id: run.id, caller })
  } catch (e) {
    log.warn('the wait for the connection not shown in Progress', e)
  }
}

function finishRun(a: OutageAgent, body: Record<string, unknown>): void {
  const r = runs.get(a.key)
  if (!r) return
  runs.delete(a.key)
  try {
    progress.finish(r.caller, r.id, body)
  } catch {
    // forgotten meanwhile (the panel turned off, the workspace closed)
  }
}

const hiveHost: OutageHost = {
  on: () => advanced.get<boolean>(OUTAGE_RESUME) === true,
  dropped: (provider, words) => connectionDropped(provider, words, (id) => advanced.pattern(id)),
  reachable: (a) => reachable(a.baseUrl ?? advanced.get<string>(outageCheckUrlId(a.provider))),
  stillStopped(a) {
    const st = sessions.liveFor(a.projectPath, a.agentId)
    return !!st && st.runId === a.runId && st.failedTurn?.since === a.turn
  },
  waiting(a) {
    // agent-text: M
    sessions.connectionWait(a.projectPath, a.agentId, a.runId, M.waiting)
    startRun(a)
  },
  ended(a, end) {
    const name = nameOf(a)
    switch (end.kind) {
      case 'resumed':
        finishRun(a, { ok: true, summary: tr(M.resumedSummary, { dropped: formatTime(end.droppedAt), back: formatTime(end.backAt) }) })
        tellAssistant(a, A.resumed, () => ({ agent: name, dropped: clock(end.droppedAt), back: clock(end.backAt) }))
        break
      case 'cancelled':
        sessions.connectionWait(a.projectPath, a.agentId, a.runId, null)
        finishRun(a, { ok: false, stopped: true })
        break
      case 'gaveUp':
      case 'timedOut': {
        const gaveUp = end.kind === 'gaveUp'
        sessions.connectionWait(a.projectPath, a.agentId, a.runId, gaveUp ? M.gaveUpStatus : M.timedOutStatus)
        finishRun(a, { ok: false })
        const title = tr(gaveUp ? M.gaveUpTitle : M.timedOutTitle, { agent: name })
        const body = gaveUp ? tr(M.gaveUpBody, { n: end.resumes }) : tr(M.timedOutBody, { minutes: end.minutes })
        toast('warning', title, body, undefined, a.projectPath)
        tellAssistant(a, gaveUp ? A.gaveUp : A.timedOut, (): AgentValues => (end.kind === 'gaveUp' ? { agent: name, resumes: String(end.resumes) } : { agent: name, minutes: String(end.minutes) }))
        break
      }
    }
  },
  async resume(a, note) {
    // Not while its team is paused (HI-2081): a turn carried on is work, which waits for the team to resume.
    const still = (): boolean => hiveHost.stillStopped(a) && !pausedFor(a.projectPath)
    if (!still()) return false
    return !!(await deliverNow(a.projectPath, { agentId: a.agentId, kind: 'control', from: HIVE, body: note, source: 'connection-back', ref: `${a.runId}@${a.turn}`, forRun: a.runId }, still).catch(() => null))
  },
  now: () => Date.now(),
  later(fn, ms) {
    const t = setTimeout(fn, ms)
    t.unref?.()
    return () => clearTimeout(t)
  },
  checkFirstMs: () => advanced.number(OUTAGE_CHECK_FIRST_SECONDS) * 1000,
  checkMostMs: () => advanced.number(OUTAGE_CHECK_MOST_SECONDS) * 1000,
  waitMs: () => advanced.number(OUTAGE_WAIT_MINUTES) * 60_000,
  resumesPerHour: () => advanced.number(OUTAGE_RESUMES_PER_HOUR)
}

let outage: OutageResume | null = null

/**
 * Starts following agents' failed turns (once): a session's status with a new failed turn may start a wait, one
 * without it (a new turn) or a launch's exit ends one, and the switch turned off ends them all.
 */
export function startOutageResume(host: OutageHost = hiveHost): OutageResume {
  if (outage) return outage
  const o = new OutageResume(host)
  outage = o
  const seen = new Map<string, string>()
  onHiveEvent((ev) => {
    if (ev.type === 'session-status') {
      const st = ev.state
      if (!st.projectPath) return
      const key = `${st.projectPath.toLowerCase()}|${st.agentId}`
      const mark = st.failedTurn ? `${st.runId}@${st.failedTurn.since}` : ''
      if ((seen.get(key) ?? '') === mark) return
      if (mark) seen.set(key, mark)
      else seen.delete(key)
      o.cleared(key)
      const a = mark ? agentOf(st) : null
      if (a) o.failed(a, st.failedTurn!.message)
    } else if (ev.type === 'session-exit') {
      const key = `${ev.projectPath.toLowerCase()}|${ev.agentId}`
      seen.delete(key)
      o.cleared(key)
    }
  })
  advanced.onChange(() => {
    if (!host.on()) o.turnedOff()
  })
  return o
}
