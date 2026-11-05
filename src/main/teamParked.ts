import { basename } from 'path'
import { projectAgents } from '../shared/defaults'
import { agentMsg, say } from '../shared/agentText'
import { agentRuntime } from '../shared/runtime'
import type { AgentProcess } from '../shared/agentProcesses'
import type { ParkedItem, TeamPauseState, TeamPauseView } from '../shared/teamPause'
import type { LiveSessionState } from '../shared/types'
import { heldSlots } from './agentFolders'
import { endTreesExactly, leftoversOf } from './agentProcesses'
import { startNow } from './agentStarts'
import { onHiveEvent } from './events'
import { orphansOf } from './orphanProcesses'
import { progress } from './progressService'
import { sessions } from './sessions'
import { appPause, teamPauseOf, withLock } from './teamPause'
import { restartAndInstall, updateState } from './updater'
import { ASSISTANT_AGENT_ID } from '../shared/assistant'
import { openWorkspaces, type WorkspaceService } from './workspace'

/**
 * Whether a paused team is parked (HI-2081; HR1's design checks s10 and s12, its round 1 and 2 findings, and the
 * Assistant's call after round 2, the card's own scope): a fresh scan each time it is asked, never a kept list, of every
 * open workspace's agents and its Assistant, from what Hive itself records. An agent is parked when it is stopped, or
 * idle (ready, finished or watching) or at a question for the user, with nothing of Hive's records left: busy, and named,
 * when it works or starts, when its CLI reports background tasks, when a Progress run of it is open (a test run, a check
 * in a copy, a merge), when it holds a slot writer, or when its launches, an earlier one's included, left processes
 * running (HI-2055's leftovers), or when its running launch's commands left a process running, its parent gone (HI-2111:
 * orphanProcesses.ts); and can't be checked, and named, when its state is unknown, the workspace's projects or
 * slots can't be read, its pause isn't saved, or the workspace closed during the scan. Only "parked" is parked.
 *
 * Hive doesn't classify the CLI's own processes to guess what else it runs (its MCP servers, a command under way): those
 * have a live parent, and are the user's to end, as the user guide's Updates section says. The asking Assistant's
 * own turn isn't counted (no self-wait); any other Assistant's is, and what it left running always is.
 */

/**
 * What the check says of each item (agent-facing: the Agent API and the Assistant's tools read it, and the log): said in
 * the dialect of whoever asked (the request's scope), as the window words its own from `kind` and `label`.
 */
const T = {
  writer: agentMsg({ id: 'notice.parked.writer', text: 'holds {slot}, whose processes still run', note: "HI-2081: what keeps an agent from being parked: it holds a slot's writer (slot: its name) whose processes still run." }),
  leftover: agentMsg({ id: 'notice.parked.leftover', text: 'left running: {label} (pid {pid})', note: "HI-2081, HI-2055: a process an agent's launches left running (label: its command), by its process id." }),
  more: agentMsg({ id: 'notice.parked.more', text: '{n} more processes left running, not listed', note: "HI-2081: more processes an agent's launches left running than the check lists (n: how many more)." }),
  process: agentMsg({ id: 'notice.parked.process', text: 'process {pid}', note: 'HI-2111: a process left running whose command is not known, by its process id.' }),
  orphan: agentMsg({ id: 'notice.parked.orphan', text: 'its command left running: {label} (pid {pid})', note: "HI-2111: a process an agent's running launch's command left running, its parent gone (label: its command)." }),
  state: agentMsg({ id: 'notice.parked.state', text: 'its state is {status}', note: "HI-2081: an agent the check can't take as parked: its status (status: Combwork's code for it) isn't one it knows." }),
  silent: agentMsg({ id: 'notice.parked.silent', text: 'silent {minutes} min, its state unknown', note: "HI-2081: an agent the check can't take as parked: nothing heard from it for minutes." }),
  background: agentMsg({ id: 'notice.parked.background', text: '{n} background task(s)', note: "HI-2081: what keeps an agent from being parked: the tasks its CLI says run in the background (n: how many)." }),
  run: agentMsg({ id: 'notice.parked.run', text: '{title} (Progress run, {minutes} min)', note: "HI-2081: a Progress run still open in the paused workspace (title: the run's own title), and for how long." }),
  noProjects: agentMsg({ id: 'notice.parked.noProjects', text: "its projects can't be read now", note: "HI-2081: the check can't read the workspace's projects, so nothing of them can be told." }),
  noSlots: agentMsg({ id: 'notice.parked.noSlots', text: "its slots can't be read now", note: "HI-2081: the check can't read a project's slots." }),
  failed: agentMsg({ id: 'notice.parked.failed', text: 'the scan failed: {error}', note: "HI-2081: the check failed (error: what failed, in English)." }),
  changed: agentMsg({ id: 'notice.parked.changed', text: 'the workspace changed while it was read', note: 'HI-2081: the workspace closed or switched during the check: what was read is not its own any more.' })
}

/** A Windows FILETIME (100 ns since 1601), as the job records keep it, as an ISO time. */
const isoOf = (created: string | undefined): string | undefined => (created ? new Date(Number((BigInt(created) - 116444736000000000n) / 10000n)).toISOString() : undefined)

const KNOWN_IDLE = new Set(['ready', 'finished', 'watching'])
/** At a question for the user (a permission prompt, a sign-in): parked, with nothing else of it left (HR1's Q2). */
const AT_QUESTION = new Set(['waiting', 'signin'])

/**
 * One agent's blockers, from its session, its slot and its leftovers as they are now: what its launches left running is
 * always counted, an earlier launch's too once it has a new session (round 2, finding 2).
 */
async function agentItems(project: string, projectPath: string, agentId: string, agent: string, st: LiveSessionState | null, writer: string | undefined, self: boolean): Promise<ParkedItem[]> {
  const out: ParkedItem[] = []
  const add = (i: Omit<ParkedItem, 'project' | 'agent' | 'agentId'>): void => void out.push({ project, agent, agentId, ...i })
  if (writer) add({ state: 'busy', kind: 'writer', label: writer, what: say(T.writer, { slot: writer }) })
  const left = leftoversOf(projectPath, agentId)
  for (const p of left.processes) add({ state: 'busy', kind: 'process', label: p.label, what: say(T.leftover, { label: p.label, pid: String(p.pid) }), ...(p.created ? { process: { pid: p.pid, created: p.created, name: p.name }, since: isoOf(p.created) } : {}) })
  if (left.more) add({ state: 'unknown', kind: 'process', what: say(T.more, { n: String(left.more) }) })
  // What its running launch's commands left running (HI-2111: its parent gone), as soon as it is seen, shown or not.
  for (const o of orphansOf(projectPath, agentId)) {
    const label = o.label ?? say(T.process, { pid: String(o.pid) })
    add({ state: 'busy', kind: 'process', label, what: say(T.orphan, { label, pid: String(o.pid) }), process: { pid: o.pid, created: o.created, name: label }, since: isoOf(o.created) })
  }
  // A start of it under way, its session not made yet (round 3: reserved by sessions.start, or its slot being prepared):
  // starting, never stopped.
  if (!st) {
    if (startingNow(projectPath, agentId)) add({ state: 'busy', kind: 'starting', what: 'starting' })
    return out
  }
  const status = st.status
  // Only the asking Assistant's own turn isn't counted (no self-wait, round 1 finding 4).
  if (!self) {
    if (status === 'working' || status === 'starting') add({ state: 'busy', kind: status, what: status })
    else if (!KNOWN_IDLE.has(status) && !AT_QUESTION.has(status) && status !== 'background') add({ state: 'unknown', kind: 'status', what: say(T.state, { status }) })
    else if (agentRuntime(st).silentMinutes !== undefined) add({ state: 'unknown', kind: 'status', what: say(T.silent, { minutes: String(agentRuntime(st).silentMinutes) }) })
  }
  // Its CLI's own count of the tasks it runs in the background (a shell command, a subagent): relayed as it says.
  if ((st.backgroundTasks ?? 0) > 0 || status === 'background') add({ state: 'busy', kind: 'background', what: say(T.background, { n: String(st.backgroundTasks ?? 1) }) })
  return out
}

/** A start of the agent under way before its session exists (sessions.start's reservation, or Hive's start preparing it). */
const startingNow = (projectPath: string, agentId: string): boolean => !!sessions.pendingStart(projectPath, agentId) || startNow(projectPath, agentId).starting

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
    // Every run still open in the workspace (a test run, a check in a copy, a merge, a slot's warming): by its agent.
    const open = progress.list(path).filter((r) => r.finishedAt === null)
    for (const r of open) items.push({ project: r.projectPath ? basename(r.projectPath) : '', agent: r.agentName, agentId: r.agentId ?? '', state: 'busy', kind: r.defaultName === 'mergeQueue' ? 'merge' : r.defaultName === 'copy' ? 'copy' : 'run', label: r.title, what: say(T.run, { title: r.title, minutes: String(Math.max(0, Math.round((Date.now() - r.startedAt) / 60_000))) }), run: r.id, since: new Date(r.startedAt).toISOString() })
    // Its projects unreadable (round 1, finding 5): nothing of them can be told.
    const projects = ws.info()?.projects
    if (!projects) cant(say(T.noProjects))
    for (const p of projects ?? []) {
      const writers = await heldSlots(p.path).catch(() => null)
      if (!writers) items.push({ project: p.name, agent: '', agentId: '', state: 'unknown', kind: 'scan', what: say(T.noSlots) })
      for (const a of projectAgents(p.config)) items.push(...(await agentItems(p.name, p.path, a.id, a.name, sessions.liveFor(p.path, a.id), writers?.get(a.id), false)))
    }
    const home = ws.assistantHome
    // agent-protocol: the Assistant's name as the check's rows name it (as an agent's name is), which the window words itself
    items.push(...(await agentItems('', home, ASSISTANT_AGENT_ID, 'Assistant', sessions.liveFor(home, ASSISTANT_AGENT_ID), undefined, asker.assistantOf === ws)))
  } catch (e) {
    cant(say(T.failed, { error: e instanceof Error ? e.message : String(e) }))
  }
  // The workspace closed or switched while it was read: what was read isn't its own any more.
  if (life?.aborted || ws.path !== path) cant(say(T.changed))
  return { workspacePath: path, pause, parked: items.length === 0, items, at }
}

/** Every open workspace's pause and what still runs, scanned now; parked only when every one is paused and parked. */
export async function teamPauseState(): Promise<TeamPauseState> {
  const workspaces: TeamPauseView[] = []
  for (const ws of openWorkspaces()) if (ws.path) workspaces.push(await scanWorkspace(ws))
  return { workspaces, appPause: appPause(), allParked: workspaces.length > 0 && workspaces.every((w) => w.parked) }
}

/**
 * Ends a process the parked check names (End it, after the window's question), with all it started: one an agent's
 * launches left running (its leftovers, an earlier launch's included), found again by its pid and recorded start, never
 * by a pid alone.
 */
export async function endParkedProcess(projectPath: string, agentId: string, pid: number, created: string): Promise<'ended' | 'notFound' | 'failed'> {
  const left = leftoversOf(projectPath, agentId).processes.find((x) => x.pid === pid && x.created === created) ?? orphanProcess(projectPath, agentId, pid, created)
  if (!left) return 'notFound'
  const r = await endTreesExactly([left])
  return r && !r.failed.length && !r.unverified.length ? 'ended' : 'failed'
}

/** One of what an agent's running launch's commands left running (HI-2111), as a process to end, by its identity. */
function orphanProcess(projectPath: string, agentId: string, pid: number, created: string): AgentProcess | undefined {
  const o = orphansOf(projectPath, agentId).find((x) => x.pid === pid && x.created === created)
  return o && { pid: o.pid, created: o.created, name: o.label ?? '', label: o.label ?? '' }
}

/**
 * What could unpark a team as it is scanned (round 1, finding 3): an agent's status or launch, a run, a pause, the
 * workspaces open. Counted as each happens; a scan whose count moved meanwhile isn't the state now.
 */
let changes = 0
onHiveEvent((e) => {
  if (e.type === 'session-status' || e.type === 'session-exit' || e.type === 'agent-start' || e.type === 'progress-changed' || e.type === 'team-pause-changed' || e.type === 'workspace-changed') changes++
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
        // A start reserved, its session not made yet (round 3).
        if (!st && startingNow(h.path, id)) return false
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
