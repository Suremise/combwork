/**
 * Combwork closing unexpectedly (#984): while Combwork runs, its profile holds a marker (running.json) saying when it started,
 * when it was last seen (a heartbeat) and which agents were running. A normal quit, an update, a restart or Windows
 * ending the session removes it; one still there at the next start is a run that ended some other way (killed, a crash,
 * the power). The pure part: the marker's shape and reading it back.
 */
import { leftoversSummary, progressRunsIn, type AgentProcess } from './agentProcesses'
import { formatDate, formatTime } from './dates'
import { fmt, msg, tr } from './i18n'
import type { ProviderId } from './types'
import type { ResumeHold } from './agentFolders'
import { shownText } from './advanced'
import { holdShort } from './sessionResume'
import { cardRef } from './projectKeys'

/** An agent running when the marker was last written. */
export interface RunningAgent {
  workspace: string
  projectPath: string
  project: string
  agentId: string
  agentName: string
  provider: ProviderId
  /** The conversation it was in: what Resume would open (empty when its CLI hadn't said yet). */
  sessionId: string
  sessionName?: string
}

export interface RunMarker {
  version: 1
  pid: number
  /** When that Combwork started, and when it last wrote the marker (ISO). */
  startedAt: string
  lastSeen: string
  /** The version of Combwork that wrote it (HI-2587: `hive` before 1.1, renamed by the names upgrade at start). */
  app: string
  /** The workspaces it had open. */
  workspaces: string[]
  agents: RunningAgent[]
  /** What the running agents' launches had started (#987), each process by id and start time. */
  processes: LaunchProcesses[]
}

/**
 * What a running agent's launch had started when the marker was last written (#987): its job's processes, its CLI and
 * all it started, each by id and start time, so the next start can tell them from later processes with their ids.
 */
export interface LaunchProcesses {
  projectPath: string
  agentId: string
  agentName: string
  /** The launch's run (#1506: Release Slot… lists these for a held writer of that run only); absent in a marker from before. */
  runId?: string
  processes: AgentProcess[]
}

/** At most this many launches, and processes per launch, a marker keeps (as leftovers.json does). */
export const MAX_MARKER_LAUNCHES = 100
export const MAX_MARKER_PROCESSES = 50

/** The marker's file name, in Combwork's profile. */
export const RUN_MARKER = 'running.json'

/** How often a running Combwork says it is still there. */
export const HEARTBEAT_MS = 60_000

const str = (v: unknown, max = 2000): v is string => typeof v === 'string' && v.length <= max

/** A marker's text read back; null when it isn't one (damaged, or written by something else). Bad agent rows are left out. */
export function parseRunMarker(text: string): RunMarker | null {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (d.version !== 1 || !str(d.startedAt, 40) || !str(d.lastSeen, 40) || Number.isNaN(Date.parse(d.lastSeen))) return null
  const agents: RunningAgent[] = []
  for (const a of Array.isArray(d.agents) ? d.agents.slice(0, 500) : []) {
    if (!a || typeof a !== 'object') continue
    const r = a as Record<string, unknown>
    if (!str(r.workspace) || !str(r.projectPath) || !r.projectPath || !str(r.project, 300) || !str(r.agentId, 200) || !r.agentId || !str(r.agentName, 300) || !str(r.provider, 40) || !str(r.sessionId, 300)) continue
    agents.push({ workspace: r.workspace, projectPath: r.projectPath, project: r.project, agentId: r.agentId, agentName: r.agentName, provider: r.provider as ProviderId, sessionId: r.sessionId, ...(str(r.sessionName, 300) && r.sessionName ? { sessionName: r.sessionName } : {}) })
  }
  const workspaces = Array.isArray(d.workspaces) ? d.workspaces.filter((w): w is string => str(w) && !!w).slice(0, 50) : []
  return { version: 1, pid: Number(d.pid) || 0, startedAt: d.startedAt, lastSeen: d.lastSeen, app: str(d.app, 40) ? d.app : '', workspaces, agents, processes: parseLaunches(d.processes) }
}

/** The marker's launches read back: only processes known by id and start time, within the bounds; bad rows left out. */
function parseLaunches(v: unknown): LaunchProcesses[] {
  const out: LaunchProcesses[] = []
  for (const l of Array.isArray(v) ? v.slice(0, MAX_MARKER_LAUNCHES) : []) {
    if (!l || typeof l !== 'object') continue
    const r = l as Record<string, unknown>
    if (!str(r.projectPath) || !r.projectPath || !str(r.agentId, 200) || !r.agentId || !Array.isArray(r.processes)) continue
    const processes: AgentProcess[] = []
    for (const x of r.processes.slice(0, MAX_MARKER_PROCESSES)) {
      const p = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>
      if (!Number.isSafeInteger(p.pid) || (p.pid as number) <= 0 || !str(p.created, 30) || !/^\d+$/.test(p.created)) continue
      const name = str(p.name, 300) ? p.name : ''
      const run = str(p.run, 300) && p.run ? { run: p.run } : {}
      const parent = Number.isSafeInteger(p.parent) && (p.parent as number) > 0 ? { parent: p.parent as number } : {}
      processes.push({ pid: p.pid as number, name, label: str(p.label, 300) ? p.label : name, created: p.created, ...parent, ...run })
    }
    const runId = str(r.runId, 100) && r.runId ? { runId: r.runId } : {}
    if (processes.length) out.push({ projectPath: r.projectPath, agentId: r.agentId, agentName: str(r.agentName, 300) ? r.agentName : '', ...runId, processes })
  }
  return out
}

/** The projects the agents were running in, by name, each once, in the order first met. */
export function projectsOf(agents: readonly RunningAgent[]): string[] {
  const seen = new Map<string, string>()
  for (const a of agents) if (!seen.has(a.projectPath.toLowerCase())) seen.set(a.projectPath.toLowerCase(), a.project)
  return [...seen.values()]
}

/** A merge an agent held the merge slot for when Combwork closed (#984: told in the same notice). */
export interface LeftMerge {
  agentName: string
  branch: string
  cards: number[]
  /**
   * Those cards as its own workspace names them (HI-1661: by key), made where the merge is recovered: the notice can hold
   * several workspaces' merges, and is told outside any of them. Absent: by number.
   */
  cardNames?: string[]
  /** The folder the merge was in: the agent's worktree, or the project's main checkout. */
  folder: string
}

/**
 * What resuming the agents that were running came to: the names resumed, those that failed with why, and those left
 * (#1434: their conversations can't resume where they were made now, or only by hand).
 */
export interface ResumeReport {
  resumed: string[]
  failed: { name: string; error: string }[]
  held?: { name: string; hold: ResumeHold }[]
}

/** The agents left to resume by hand, with why in a few words (#1434). */
export const resumeHeldLine = (held: NonNullable<ResumeReport['held']>): string =>
  tr(msg({ id: 'main.unexpectedClose.held', defaultMessage: '{n, plural, one {One was left stopped: {agents}.} other {# were left stopped: {agents}.}}', description: "In the notice that Combwork closed unexpectedly (#1434): agents whose conversations can't resume now where they ran (their slot is free, or holds other work), left for the user ({agents}: their names, each with why in a few words)." }), { n: held.length, agents: fmt.list(held.map((h) => `${h.name} (${shownText(holdShort(h.hold))})`)) })

/** The agents that couldn't resume, with why. */
export const resumeFailedLine = (r: ResumeReport): string =>
  tr(msg({ id: 'main.unexpectedClose.failed', defaultMessage: "{n, plural, one {One couldn't resume: {agents}.} other {# couldn't resume: {agents}.}}", description: 'In the notice that Combwork closed unexpectedly, or the report of resuming its agents: the agents that failed to resume ({agents}: their names with why).' }), { n: r.failed.length, agents: fmt.list(r.failed.map((f) => `${f.name} (${f.error})`)) })

/**
 * The notice's line on what the agents started that still runs (#987): how many, and what. A cw-progress run, the test
 * run's whole tree, is one item named by its title (#1008), found among all the marker kept (kept).
 */
export function stillRunningLine(processes: readonly AgentProcess[], kept: readonly AgentProcess[] = processes): string {
  const { runs, rest } = progressRunsIn(processes, kept)
  const items: AgentProcess[] = [
    ...runs.map((g) => ({ pid: g.root.pid, name: '', label: tr(msg({ id: 'main.unexpectedClose.progressRun', defaultMessage: '{title} ({n, plural, one {# process} other {# processes}})', description: 'In the notice that Combwork closed unexpectedly, a test run (or other command) an agent ran through cw-progress that still runs, as one item of the list of what still runs: its title as the agent gave it ({title}: "e2e: 196 suites in hb2") and how many of its processes still run ({n}).' }), { title: g.title, n: g.processes.length }) })),
    ...rest
  ]
  return tr(msg({ id: 'main.unexpectedClose.stillRunning', defaultMessage: '{n, plural, one {One process the agents started is still running: {processes}.} other {# processes the agents started are still running: {processes}.}}', description: 'The notice that Combwork closed unexpectedly: processes the agents had started (test runs, servers) still run, checked to be the same ones. {n} is how many; {processes} lists them ("node serve.js, 2 × npm run e2e"). The notice has a Stop Them button.' }), { n: processes.length, processes: leftoversSummary({ processes: items, more: 0 }, 4, { tr, list: fmt.list }) })
}

/** What Stop Them does with the processes (#987, #1008): passed in, so the unit tests give their own. */
export interface StopProcesses {
  /**
   * Ends these with all they started that runs now: those that still run after it (failed), and the ids of their
   * children that run and it could neither end nor check (unverified); null when it can't say.
   */
  endTrees(roots: readonly AgentProcess[]): Promise<{ failed: AgentProcess[]; unverified: number[] } | null>
  /** Ends these, each only while it is still the same process. */
  endExact(processes: readonly AgentProcess[]): Promise<unknown>
  /** Which still run as the same processes (null: it can't say). */
  stillRunning(processes: readonly AgentProcess[]): Promise<AgentProcess[] | null>
}

/**
 * The notice's Stop Them (#987): ends what the agents had started that still runs (running), each only while it is still
 * the same process. A cw-progress run goes whole (#1008): from its top (the shell that ran it, while it still runs) and
 * each of its processes still running, all they started that runs now, listed or not (found among all the marker kept).
 * Replies with how many of those listed were stopped, and what still runs as the same processes after it: those listed,
 * and those of a run's tree it couldn't end, to report and to try again (all of them when it can't say); unverified, the
 * ids of a run's children that still run and it could neither end nor check (reported, never counted as stopped, and
 * never tried again: with their parent ended, nothing tells them from a process that later gets the id, #1028).
 */
export async function stopStillRunning(running: readonly AgentProcess[], kept: readonly AgentProcess[], ops: StopProcesses): Promise<{ stopped: number; still: AgentProcess[]; unverified: number[] }> {
  const trees = progressRunsIn(running, kept).runs.flatMap((g) => [g.top, ...g.processes])
  const tree = trees.length ? await ops.endTrees(trees).catch(() => null) : { failed: [], unverified: [] }
  const treeFailed = tree ? tree.failed : trees
  await ops.endExact(running)
  const key = (p: AgentProcess): string => `${p.pid}:${p.created}`
  const tried = [...new Map([...running, ...treeFailed].map((p) => [key(p), p])).values()]
  const still = (await ops.stillRunning(tried).catch(() => null)) ?? tried
  const listed = new Set(running.map(key))
  return { stopped: running.length - new Set(still.map(key).filter((k) => listed.has(k))).size, still, unverified: tree?.unverified ?? [] }
}

/**
 * What Stop Them has left (#1028): what still runs as the same processes (running: listed, tried again by the next
 * click), and the ids of a run's children it could neither end nor check (unverified: their parent ended, so no click can
 * find them again by id alone; kept so that each click still says they may run).
 */
export interface Leftovers {
  running: AgentProcess[]
  unverified: number[]
}

/** One click of Stop Them on what is left: how many of those listed it stopped, and what is left after it. */
export async function stopLeftovers(left: Leftovers, kept: readonly AgentProcess[], ops: StopProcesses): Promise<{ stopped: number; left: Leftovers }> {
  if (!left.running.length) return { stopped: 0, left }
  const r = await stopStillRunning(left.running, kept, ops)
  return { stopped: r.stopped, left: { running: r.still, unverified: [...new Set([...left.unverified, ...r.unverified])] } }
}

/**
 * What the notice's Stop Them has left, and its clicks (#1028): one at a time, each on what the one before it left, so a
 * click that overlaps another (twice quickly, or from two windows) can't put back a list that no longer holds the ids
 * the other kept, or report a success over them.
 */
export class LeftoverStops {
  private left: Leftovers = { running: [], unverified: [] }
  private kept: readonly AgentProcess[] = []
  private last: Promise<unknown> = Promise.resolve()

  constructor(private readonly ops: StopProcesses) {}

  /** What still runs as the notice is given, and all the marker kept (for the runs among them). */
  set(running: readonly AgentProcess[], kept: readonly AgentProcess[]): void {
    this.left = { running: [...running], unverified: [] }
    this.kept = kept
  }

  get leftovers(): Leftovers {
    return this.left
  }

  /** One click, once those before it have ended: how many it stopped, what is left, and how many it tried. */
  click(): Promise<{ stopped: number; left: Leftovers; tried: number }> {
    const run = this.last.then(async () => {
      const tried = this.left.running.length
      const r = await stopLeftovers(this.left, this.kept, this.ops)
      this.left = r.left
      return { ...r, tried }
    })
    this.last = run.catch(() => undefined)
    return run
  }
}

/** The notice's text: when, what was running, what became of it, what it started that still runs, a crash dump, merges left half done. */
export function unexpectedCloseText(c: { lastSeen: string; agents: readonly RunningAgent[]; dump: boolean; merges: readonly LeftMerge[]; stillRunning?: readonly AgentProcess[]; kept?: readonly AgentProcess[] }, r: ResumeReport | null): string {
  const lines = [tr(msg({ id: 'main.unexpectedClose.when', defaultMessage: 'Combwork was last seen on {date} at {time}.', description: 'The notice at start that the last run of Combwork ended without quitting (its title says so): when that run was last seen running ({date}, {time}).' }), { date: formatDate(c.lastSeen), time: formatTime(c.lastSeen) })]
  lines.push(tr(msg({ id: 'main.unexpectedClose.agents', defaultMessage: '{n, plural, =0 {No agents were running.} one {One agent was running in {projects}.} other {# agents were running in {projects}.}}', description: 'The notice that Combwork closed unexpectedly: how many agents were running ({n}) and in which projects ({projects}: their names, listed).' }), { n: c.agents.length, projects: fmt.list(projectsOf(c.agents)) }))
  if (r) {
    lines.push(tr(msg({ id: 'main.unexpectedClose.resumed', defaultMessage: '{n, plural, =0 {None was resumed.} one {One was resumed, as Settings → Sessions says.} other {# were resumed, as Settings → Sessions says.}}', description: 'The notice that Combwork closed unexpectedly, with "Resume agents after an unexpected close" on: how many of the agents Combwork resumed ({n}).' }), { n: r.resumed.length }))
    if (r.failed.length) lines.push(resumeFailedLine(r))
    if (r.held?.length) lines.push(resumeHeldLine(r.held))
  } else if (c.agents.length) lines.push(tr(msg({ id: 'main.unexpectedClose.notResumed', defaultMessage: 'Nothing was resumed.', description: 'The notice that Combwork closed unexpectedly: Combwork did not resume the agents that were running (the user chooses).' })))
  if (c.stillRunning?.length) lines.push(stillRunningLine(c.stillRunning, c.kept))
  if (c.dump) lines.push(tr(msg({ id: 'main.unexpectedClose.dump', defaultMessage: 'Combwork kept a crash dump of it: Help → Copy Diagnostics names it.', description: 'The notice that Combwork closed unexpectedly: a crash dump of that run was saved on this PC.' })))
  for (const m of c.merges) {
    const cards = fmt.list(m.cardNames ?? m.cards.map(cardRef))
    lines.push(
      m.cards.length
        ? tr(msg({ id: 'main.unexpectedClose.mergeCards', defaultMessage: '{agent} was merging {branch} ({cards}): check {folder} for a merge left half done (git status there) before the next merge.', description: 'The notice that Combwork closed unexpectedly: an agent ({agent}) held the merge slot for a branch ({branch}) for cards ({cards}); {folder} is where the merge was (its worktree or the main checkout).' }), { agent: m.agentName, branch: m.branch, cards, folder: m.folder })
        : tr(msg({ id: 'main.unexpectedClose.merge', defaultMessage: '{agent} was merging {branch}: check {folder} for a merge left half done (git status there) before the next merge.', description: 'The notice that Combwork closed unexpectedly: an agent ({agent}) held the merge slot for a branch ({branch}); {folder} is where the merge was (its worktree or the main checkout).' }), { agent: m.agentName, branch: m.branch, folder: m.folder })
    )
  }
  return lines.join(' ')
}
