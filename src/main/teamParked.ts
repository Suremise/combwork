import { basename } from 'path'
import { projectAgents } from '../shared/defaults'
import { agentRuntime } from '../shared/runtime'
import type { ActivityProcess } from '../shared/activity'
import type { ParkedItem, TeamPauseState, TeamPauseView } from '../shared/teamPause'
import type { LiveSessionState, McpServerDef } from '../shared/types'
import { heldSlots } from './agentFolders'
import { endTreesExactly, launchJob, leftoversOf } from './agentProcesses'
import { onHiveEvent } from './events'
import { progress } from './progressService'
import { sessions } from './sessions'
import { appPause, pauseSaveState, teamPauseOf, withLock } from './teamPause'
import { restartAndInstall, updateState } from './updater'
import { ASSISTANT_AGENT_ID } from '../shared/assistant'
import { openWorkspaces, type WorkspaceService } from './workspace'

/**
 * Whether a paused team is parked (HI-2081; HR1's design checks s10 and s12, and round 1's findings): a fresh scan each
 * time it is asked, never a kept list, of every open workspace's agents and its Assistant. An agent is parked when it is
 * stopped, or idle (ready, finished or watching) or at a question for the user, with nothing below; busy, and named, when
 * it works or starts, has background tasks, a Progress run (a test run, a check in a copy, a merge), a held slot writer,
 * or a process in its job beyond its CLI's own; and can't be checked, and named, when its state is unknown, its job or
 * its workspace's projects can't be read, its workspace's pause isn't saved, or the workspace closed during the scan.
 * Only "parked" is parked: what can't be read is never taken for nothing running.
 *
 * Its CLI's own processes are positively identified, never guessed by age (round 1, finding 1): the launch's gate (its
 * terminal, tracked at the spawn), the CLI the gate started, and the CLI's direct children that are the MCP servers this
 * launch was given (its recorded config: executable and arguments), a shell wrapping one included with that server
 * under it. Each is exempt alone: anything else, and anything any of them started, counts. The asking Assistant's own
 * turn isn't counted (no self-wait); any other Assistant's is, and what it started always is.
 */

/** A Windows FILETIME (100 ns since 1601), as the job records keep it, in Unix ms. */
const msOf = (created: string | undefined): number => (created ? Number((BigInt(created) - 116444736000000000n) / 10000n) : NaN)

const exe = (s: string): string => basename(s.replace(/^["']|["']$/g, '')).toLowerCase().replace(/\.(exe|cmd|bat)$/, '')
const norm = (s: string): string => s.toLowerCase().replace(/\\+/g, '/')

/** Whether a process runs one of the launch's MCP servers: its executable named by the server's command, its arguments all there. */
function runsServer(p: ActivityProcess, servers: readonly McpServerDef[]): boolean {
  const cmd = norm(p.command ?? '')
  if (!cmd) return false
  return servers.some((d) => !!d.command && (exe(p.name) === exe(d.command) || cmd.includes(norm(d.command))) && (d.args ?? []).every((a) => cmd.includes(norm(a))))
}

/** A shell a CLI may start a server through (cmd /c npx …): it, and the one process it started for the server. */
const SHELLS = new Set(['cmd', 'powershell', 'pwsh', 'sh', 'bash'])

/**
 * The processes of a launch's job beyond its CLI's own (round 1, finding 1), from its records: the gate, the CLI the gate
 * started, and the CLI's direct children that run one of `servers` (the launch's recorded MCP servers), with a shell
 * wrapping one and the server it started. Null when the CLI can't be told (no process started by the gate): nothing of
 * the job can be verified then.
 */
export function beyondCli(gate: number, processes: readonly ActivityProcess[], servers: readonly McpServerDef[]): ActivityProcess[] | null {
  const clis = processes.filter((p) => p.parent === gate)
  if (!clis.length) return null
  const infra = new Set<number>([gate, ...clis.map((c) => c.pid)])
  for (const cli of clis)
    for (const p of processes) {
      if (p.parent !== cli.pid || !runsServer(p, servers)) continue
      infra.add(p.pid)
      // A shell running the server's command: its one child running the same server is the server itself.
      if (SHELLS.has(exe(p.name))) {
        const under = processes.filter((c) => c.parent === p.pid)
        if (under.length === 1 && runsServer({ ...under[0], name: under[0].name }, servers.map((d) => ({ ...d, command: under[0].name })))) infra.add(under[0].pid)
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
  // Only the asking Assistant's own turn isn't counted (no self-wait, round 1 finding 4).
  if (!self) {
    if (status === 'working' || status === 'starting') add({ state: 'busy', kind: status, what: status })
    else if (!KNOWN_IDLE.has(status) && !AT_QUESTION.has(status) && status !== 'background') add({ state: 'unknown', kind: 'status', what: `its state is ${status}` })
    else if (agentRuntime(st).silentMinutes !== undefined) add({ state: 'unknown', kind: 'status', what: `silent ${agentRuntime(st).silentMinutes} min, its state unknown` })
  }
  if ((st.backgroundTasks ?? 0) > 0 || status === 'background') add({ state: 'busy', kind: 'background', what: `${st.backgroundTasks ?? 1} background task(s)` })
  const job = await launchJob(projectPath, agentId)
  if (job === 'unknown') add({ state: 'unknown', kind: 'scan', what: "its processes can't be read now" })
  else if (job !== 'none') {
    const servers = sessions.launchedMcp(projectPath, agentId)
    const rest = beyondCli(job.gate, job.processes, Object.values(servers ?? {}))
    if (!rest) add({ state: 'unknown', kind: 'scan', what: "its CLI can't be told among its processes" })
    else for (const p of rest) add({ state: 'busy', kind: 'process', label: p.run ?? p.label, what: `${p.run ? `${p.run} (` : ''}${p.label}${p.run ? ')' : ''} (pid ${p.pid})`, ...(p.created ? { process: { pid: p.pid, created: p.created, name: p.name }, since: new Date(msOf(p.created)).toISOString() } : {}) })
  }
  return out
}

/** Who asks for a scan: the Assistant of `self` asking of its own workspace (its own turn isn't counted then). */
export interface ScanAsker {
  assistantOf?: WorkspaceService
}

/** A workspace's pause and what still runs in it, scanned now. */
export async function scanWorkspace(ws: WorkspaceService, asker: ScanAsker = {}): Promise<TeamPauseView> {
  const at = new Date().toISOString()
  const pause = teamPauseOf(ws)
  if (!ws.path) return { workspacePath: '', pause: null, parked: false, items: [], at }
  const path = ws.path
  const life = ws.lifetime
  // Not paused: nothing to scan (each agent's job and the slots are read only while a pause asks what still runs).
  if (!pause) return { workspacePath: path, pause: null, parked: false, items: [], at }
  const items: ParkedItem[] = []
  const cant = (what: string): void => void items.push({ project: '', agent: '', agentId: '', state: 'unknown', kind: 'scan', what })
  try {
    // Its pause not saved (round 1, finding 2): held, but not one the next start would know; never parked.
    const saved = pauseSaveState(ws)
    if (saved !== 'saved') cant(saved === 'pending' ? "its pause isn't saved yet" : `its pause couldn't be saved: ${saved.failed}`)
    // Every run still open in the workspace (a test run, a check in a copy, a merge, a slot's warming): by its agent.
    const open = progress.list(path).filter((r) => r.finishedAt === null)
    for (const r of open) items.push({ project: r.projectPath ? basename(r.projectPath) : '', agent: r.agentName, agentId: r.agentId ?? '', state: 'busy', kind: r.defaultName === 'mergeQueue' ? 'merge' : r.defaultName === 'copy' ? 'copy' : 'run', label: r.title, what: `${r.title} (Progress run, ${Math.max(0, Math.round((Date.now() - r.startedAt) / 60_000))} min)`, run: r.id, since: new Date(r.startedAt).toISOString() })
    // Its projects unreadable (round 1, finding 5): nothing of them can be told.
    const projects = ws.info()?.projects
    if (!projects) cant("its projects can't be read now")
    for (const p of projects ?? []) {
      const writers = await heldSlots(p.path).catch(() => null)
      if (!writers) items.push({ project: p.name, agent: '', agentId: '', state: 'unknown', kind: 'scan', what: "its slots can't be read now" })
      for (const a of projectAgents(p.config)) items.push(...(await agentItems(p.name, p.path, a.id, a.name, sessions.liveFor(p.path, a.id), writers?.get(a.id), false)))
    }
    const home = ws.assistantHome
    items.push(...(await agentItems('', home, ASSISTANT_AGENT_ID, 'Assistant', sessions.liveFor(home, ASSISTANT_AGENT_ID), undefined, asker.assistantOf === ws))) // i18n-ignore: the Assistant as the check names it (agent-facing; the window words it)
  } catch (e) {
    cant(`the scan failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  // The workspace closed or switched while it was read: what was read isn't its own any more.
  if (life?.aborted || ws.path !== path) cant('the workspace changed while it was read')
  return { workspacePath: path, pause, parked: items.length === 0, items, at }
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
      if (!beyondCli(job.gate, job.processes, Object.values(sessions.launchedMcp(projectPath, agentId) ?? {}))?.some((x) => x.pid === pid)) return 'cli'
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
 * What could unpark a team as it is scanned (round 1, finding 3): an agent's status or launch, a run, a pause, the
 * workspaces open. Counted as each happens; a scan whose count moved meanwhile isn't the state now.
 */
let changes = 0
onHiveEvent((e) => {
  if (e.type === 'session-status' || e.type === 'session-exit' || e.type === 'progress-changed' || e.type === 'team-pause-changed' || e.type === 'workspace-changed') changes++
})

/** The most scans Install Now makes while things keep changing under it, before it says it isn't parked. */
const INSTALL_SCANS = 5

/** No agent of an open workspace is working or starting now, as Hive knows it at this moment (no wait between this and the install). */
function quietNow(): boolean {
  for (const ws of openWorkspaces()) {
    if (!ws.path) continue
    const hosts = [...(ws.info()?.projects ?? []).map((p) => ({ path: p.path, ids: projectAgents(p.config).map((a) => a.id) })), { path: ws.assistantHome, ids: [ASSISTANT_AGENT_ID] }]
    for (const h of hosts)
      for (const id of h.ids) {
        const st = sessions.liveFor(h.path, id)
        if (st && !KNOWN_IDLE.has(st.status) && !AT_QUESTION.has(st.status)) return false
      }
  }
  return true
}

/**
 * Install Now (HI-2081, HR1's s10 check and round 1's finding 3): every open workspace scanned again here, each under its
 * pause's lock (a pause or resume can't land in between), until a scan ends with nothing changed while it was made (an
 * agent's status, a run, a pause, the workspaces open); then, with nothing awaited before the install, every agent's
 * status is read once more. Installed only when every workspace is paused and parked, and an update is ready.
 */
export async function installIfParked(): Promise<{ installed: boolean; state: TeamPauseState }> {
  const spaces = openWorkspaces().filter((ws) => !!ws.path)
  const locked = async (i: number): Promise<{ installed: boolean; state: TeamPauseState }> => {
    if (i < spaces.length) return withLock(spaces[i], () => locked(i + 1))
    let state: TeamPauseState | null = null
    for (let n = 0; n < INSTALL_SCANS; n++) {
      const before = changes
      const open = openWorkspaces().filter((ws) => !!ws.path)
      state = await teamPauseState()
      const same = changes === before && open.length === spaces.length && open.every((w) => spaces.includes(w))
      if (!state.allParked) return { installed: false, state }
      if (!same) continue
      if (updateState().status !== 'ready' || !quietNow()) return { installed: false, state }
      restartAndInstall()
      return { installed: true, state }
    }
    return { installed: false, state: { ...state!, allParked: false } }
  }
  return locked(0)
}
