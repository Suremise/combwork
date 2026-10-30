import { basename } from 'path'
import { projectAgents } from '../shared/defaults'
import { agentRuntime } from '../shared/runtime'
import type { ActivityProcess } from '../shared/activity'
import type { ParkedItem, TeamPauseState, TeamPauseView } from '../shared/teamPause'
import type { LiveSessionState } from '../shared/types'
import { heldSlots } from './agentFolders'
import { endTreesExactly, launchJob, leftoversOf } from './agentProcesses'
import { progress } from './progressService'
import { sessions } from './sessions'
import { appPause, teamPauseOf, withLock } from './teamPause'
import { restartAndInstall, updateState } from './updater'
import { ASSISTANT_AGENT_ID } from '../shared/assistant'
import { openWorkspaces, type WorkspaceService } from './workspace'

/**
 * Whether a paused team is parked (HI-2081; HR1's design checks s10 and s12): a fresh scan each time it is asked, never a
 * kept list, of every open workspace's agents and the Assistant. An agent is parked when it is stopped, or idle (ready,
 * finished or watching) or at a question for the user, with nothing below; busy, and named, when it works or starts, has
 * background tasks, a Progress run (a test run, a check in a copy, a merge), a held slot writer, or a process in its job
 * beyond its CLI's own; and can't be checked, and named, when its state is unknown or its job can't be read. Only
 * "parked" is parked: an unreadable scan is never taken for nothing running.
 *
 * Its CLI's own processes are told by their recorded identity, never by a command line alone: the launch's gate (its
 * terminal, tracked at the spawn), the CLI the gate started, and the CLI's direct children that are its MCP servers
 * (Hive's own hive server, by its script, or one the CLI started as it started: the servers of its own config, which Hive
 * doesn't read). Each is exempt alone: what any of them started (a test runner, a dev server, a test copy of Hive) counts.
 * The Assistant's own turn doesn't count (it may be asking for this), but what it started does.
 */

/** A CLI's MCP servers start with it: a direct child it started this soon after itself counts as one. */
const STARTUP_MS = 120_000

/** A Windows FILETIME (100 ns since 1601), as the job records keep it, in Unix ms. */
const msOf = (created: string | undefined): number => (created ? Number((BigInt(created) - 116444736000000000n) / 10000n) : NaN)

/** Hive's own hive server, as a launch runs it (out/main/hive-mcp.js, or its packaged copy). */
const HIVE_SERVER = /(^|[\\/"' ])hive-mcp\.js(["' ]|$)/i

/**
 * The processes of a launch's job beyond its CLI's own (HR1's s12 check), from its records: the gate, the CLI the gate
 * started, and the CLI's MCP servers (direct children of the CLI that are Hive's server, or started with the CLI). Null
 * when the CLI can't be told (no process started by the gate): nothing of the job can be verified then.
 */
export function beyondCli(gate: number, processes: readonly ActivityProcess[]): ActivityProcess[] | null {
  const clis = processes.filter((p) => p.parent === gate)
  if (!clis.length) return null
  const infra = new Set<number>([gate, ...clis.map((c) => c.pid)])
  for (const cli of clis) {
    const born = msOf(cli.created)
    for (const p of processes) {
      if (p.parent !== cli.pid || !p.created) continue
      const at = msOf(p.created)
      if (HIVE_SERVER.test(p.command ?? '') || (Number.isFinite(born) && at >= born && at - born <= STARTUP_MS)) infra.add(p.pid)
    }
  }
  return processes.filter((p) => !infra.has(p.pid))
}

const KNOWN_IDLE = new Set(['ready', 'finished', 'watching'])
/** At a question for the user (a permission prompt, a sign-in): parked, with nothing else of it left (HR1's Q2). */
const AT_QUESTION = new Set(['waiting', 'signin'])

/** One agent's blockers, from its session, its job, its runs and its slots as they are now. */
async function agentItems(project: string, projectPath: string, agentId: string, agent: string, st: LiveSessionState | null, writer: string | undefined, self: boolean): Promise<ParkedItem[]> {
  const out: ParkedItem[] = []
  const add = (i: Omit<ParkedItem, 'project' | 'agent' | 'agentId'>): void => void out.push({ project, agent, agentId, ...i })
  if (writer) add({ state: 'busy', kind: 'writer', label: writer, what: `holds ${writer}, whose processes still run` })
  if (!st) {
    // Stopped: what its launches left running still counts.
    const left = leftoversOf(projectPath, agentId)
    for (const p of left.processes) add({ state: 'busy', kind: 'process', label: p.label, what: `left running: ${p.label} (pid ${p.pid})`, ...(p.created ? { process: { pid: p.pid, created: p.created, name: p.name } } : {}), since: left.since })
    if (left.more) add({ state: 'busy', kind: 'process', what: `${left.more} more processes left running` })
    return out
  }
  const status = st.status
  // The Assistant's own turn, which may be the call asking for this, isn't counted (no self-wait).
  if (!self) {
    if (status === 'working' || status === 'starting') add({ state: 'busy', kind: status, what: status })
    else if (!KNOWN_IDLE.has(status) && !AT_QUESTION.has(status) && status !== 'background') add({ state: 'unknown', kind: 'status', what: `its state is ${status}` })
    else if (agentRuntime(st).silentMinutes !== undefined) add({ state: 'unknown', kind: 'status', what: `silent ${agentRuntime(st).silentMinutes} min, its state unknown` })
  }
  if ((st.backgroundTasks ?? 0) > 0 || status === 'background') add({ state: 'busy', kind: 'background', what: `${st.backgroundTasks ?? 1} background task(s)` })
  const job = await launchJob(projectPath, agentId)
  if (job === 'unknown') add({ state: 'unknown', kind: 'scan', what: "its processes can't be read now" })
  else if (job !== 'none') {
    const rest = beyondCli(job.gate, job.processes)
    if (!rest) add({ state: 'unknown', kind: 'scan', what: "its CLI can't be told among its processes" })
    else for (const p of rest) add({ state: 'busy', kind: 'process', label: p.run ?? p.label, what: `${p.run ? `${p.run} (` : ''}${p.label}${p.run ? ')' : ''} (pid ${p.pid})`, ...(p.created ? { process: { pid: p.pid, created: p.created, name: p.name }, since: new Date(msOf(p.created)).toISOString() } : {}) })
  }
  return out
}

/** A workspace's pause and what still runs in it, scanned now. */
export async function scanWorkspace(ws: WorkspaceService): Promise<TeamPauseView> {
  const at = new Date().toISOString()
  const pause = teamPauseOf(ws)
  if (!ws.path) return { workspacePath: '', pause: null, parked: false, items: [], at }
  // Not paused: nothing to scan (each agent's job and the slots are read only while a pause asks what still runs).
  if (!pause) return { workspacePath: ws.path, pause: null, parked: false, items: [], at }
  const items: ParkedItem[] = []
  try {
    // Every run still open in the workspace (a test run, a check in a copy, a merge, a slot's warming): by its agent.
    const open = progress.list(ws.path).filter((r) => r.finishedAt === null)
    for (const r of open) items.push({ project: r.projectPath ? basename(r.projectPath) : '', agent: r.agentName, agentId: r.agentId ?? '', state: 'busy', kind: r.defaultName === 'mergeQueue' ? 'merge' : r.defaultName === 'copy' ? 'copy' : 'run', label: r.title, what: `${r.title} (Progress run, ${Math.max(0, Math.round((Date.now() - r.startedAt) / 60_000))} min)`, run: r.id, since: new Date(r.startedAt).toISOString() })
    for (const p of ws.info()?.projects ?? []) {
      const writers = await heldSlots(p.path).catch(() => null)
      if (!writers) items.push({ project: p.name, agent: '', agentId: '', state: 'unknown', kind: 'scan', what: "its slots can't be read now" })
      for (const a of projectAgents(p.config)) items.push(...(await agentItems(p.name, p.path, a.id, a.name, sessions.liveFor(p.path, a.id), writers?.get(a.id), false)))
    }
    const home = ws.assistantHome
    items.push(...(await agentItems('', home, ASSISTANT_AGENT_ID, 'Assistant', sessions.liveFor(home, ASSISTANT_AGENT_ID), undefined, true))) // i18n-ignore: the Assistant as the check names it (agent-facing; the window words it)
  } catch (e) {
    items.push({ project: '', agent: '', agentId: '', state: 'unknown', kind: 'scan', what: `the scan failed: ${e instanceof Error ? e.message : String(e)}` })
  }
  return { workspacePath: ws.path, pause, parked: !!pause && items.length === 0, items, at }
}

/** Every open workspace's pause and what still runs, scanned now; parked only when every one is paused and parked. */
export async function teamPauseState(): Promise<TeamPauseState> {
  const workspaces: TeamPauseView[] = []
  for (const ws of openWorkspaces()) if (ws.path) workspaces.push(await scanWorkspace(ws))
  return { workspaces, appPause: appPause(), allParked: workspaces.length > 0 && workspaces.every((w) => w.parked) }
}

/**
 * Ends a process the parked check names (End it, after the window's question), with all it started: found again in its
 * agent's job or among what its launches left, by its pid and recorded start (never a pid alone), and never its CLI's own.
 */
export async function endParkedProcess(projectPath: string, agentId: string, pid: number, created: string): Promise<'ended' | 'notFound' | 'cli' | 'failed'> {
  const job = await launchJob(projectPath, agentId)
  if (job !== 'none' && job !== 'unknown') {
    const p = job.processes.find((x) => x.pid === pid && x.created === created)
    if (p) {
      if (!beyondCli(job.gate, job.processes)?.some((x) => x.pid === pid)) return 'cli'
      const r = await endTreesExactly([p])
      return r && !r.failed.length && !r.unverified.length ? 'ended' : 'failed'
    }
  }
  const left = leftoversOf(projectPath, agentId).processes.find((x) => x.pid === pid && x.created === created)
  if (!left) return 'notFound'
  const r = await endTreesExactly([left])
  return r && !r.failed.length && !r.unverified.length ? 'ended' : 'failed'
}

/**
 * Install Now (HI-2081, HR1's s10 check): every open workspace scanned again here, each under its pause's lock, so a
 * resume or a new pause can't land between the scan and the install; installed only when each is paused and parked.
 */
export async function installIfParked(): Promise<{ installed: boolean; state: TeamPauseState }> {
  const spaces = openWorkspaces().filter((ws) => !!ws.path)
  const locked = async (i: number): Promise<{ installed: boolean; state: TeamPauseState }> => {
    if (i < spaces.length) return withLock(spaces[i], () => locked(i + 1))
    const state = await teamPauseState()
    if (!state.allParked || updateState().status !== 'ready') return { installed: false, state }
    restartAndInstall()
    return { installed: true, state }
  }
  return locked(0)
}
