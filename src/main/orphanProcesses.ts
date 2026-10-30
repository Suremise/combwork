import { basename } from 'path'
import { app } from 'electron'
import { ORPHAN_NOTICE } from '../shared/advanced'
import { commandText, filetimeMs, type ActivityProcess } from '../shared/activity'
import { NOTICE_PREFIX } from '../shared/doorbell'
import { msg, tr } from '../shared/i18n'
import { durationText } from '../shared/tasks'
import { advanced } from './advanced'
import { launchLineage, launchProcessesNow, runningLaunches } from './agentProcesses'
import { toast } from './events'
import { createLogger, userText } from './logger'

/**
 * What an agent's command left running while the agent runs (HI-2111). Its launch's job holds everything it started
 * (agentProcesses.ts, #507), and what is left when its CLI exits is listed then; this is the gap while it keeps running.
 *
 * One rule, nothing classified: an **orphan** is a process in a running launch's job whose parent has exited, by its
 * parent's id and start time (a process running by that id now that started after the child is another one, given the
 * id again). The CLI and what it starts directly (its MCP servers, a command under way) have a live parent, so they
 * never count; a server started with `&` from a shell that has since ended does, and should: it is left running.
 *
 * An orphan seen at two looks that has run for ORPHAN_MS is shown: Activity marks it (its CPU time too) with End It, a
 * notice says so once, and the agent is told once, at its next tool call or turn's end (inboxNotices), so it can end
 * it; Hive doesn't. Pause the team counts every orphan as not parked (teamParked.ts). ORPHAN_NOTICE turns off the notice
 * and the agent's line.
 */

const log = createLogger('processes')

/** How long an orphan has run before it is shown (its start time on). */
export const ORPHAN_MS = 10 * 60_000
/** How often running launches are looked at. */
const POLL_MS = 30_000
/** Test copies (unpackaged) shorten both: HIVE_TEST_ORPHAN_MS, HIVE_TEST_ORPHAN_POLL_MS. */
const testMs = (name: string, fallback: number): number => (!app.isPackaged && Number(process.env[name]) > 0 ? Number(process.env[name]) : fallback)

/** A process of a launch's job as the host's "lineage" gives it: its parent's id, and that id's state now. */
export interface Lineage {
  pid: number
  /** Its start time, a Windows FILETIME as text. */
  created: string
  parent: number
  /** The start time of the process running by the parent's id now; "0", none runs by it; "?", it can't be told. */
  parentCreated: string
  /** Its CPU time (kernel and user), in ms. */
  cpu: number
}

/** The rule (HI-2111): its parent has exited, or the parent's id names a process started after it. Unknown: not one. */
export function isOrphan(l: Lineage): boolean {
  if (l.parentCreated === '0') return true
  if (!/^\d+$/.test(l.parentCreated) || !/^\d+$/.test(l.created)) return false
  return BigInt(l.parentCreated) > BigInt(l.created)
}

/** An orphan of a running launch, as followed from look to look. */
export interface Orphan {
  runId: string
  projectPath: string
  agentId: string
  agentName: string
  pid: number
  created: string
  cpuMs: number
  /** Past ORPHAN_MS, seen at two looks: Activity marks it, and it is told (once). */
  shown: boolean
  /** The agent was told of it. */
  told: boolean
  /** What it runs (its command line, masked), once it is shown. */
  label?: string
  command?: string
}

type LaunchRef = { runId: string; projectPath: string; agentId: string; agentName: string }

/** The lineage the host gave for one job, the well-formed entries only. */
export function parseLineage(raw: unknown): Lineage[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((e): Lineage[] => {
    const x = e as Partial<Lineage>
    if (!Number.isSafeInteger(x?.pid) || (x.pid as number) <= 0 || typeof x.created !== 'string' || !/^\d+$/.test(x.created) || x.created === '0' || typeof x.parentCreated !== 'string') return []
    return [{ pid: x.pid as number, created: x.created, parent: Number(x.parent) || 0, parentCreated: x.parentCreated, cpu: Math.max(0, Number(x.cpu) || 0) }]
  })
}

/**
 * One look at a launch (pure, for the tests): its orphans now, from those followed before (by pid and start time), and
 * those shown at this look (`due`). An orphan is shown once seen at an earlier look too (a parent and child ending
 * together isn't one) and run for `bound` ms; once shown, it stays so. What isn't an orphan any more has ended.
 */
export function lookAtLaunch(known: ReadonlyMap<string, Orphan>, launch: LaunchRef, lineage: readonly Lineage[], now: number, bound = ORPHAN_MS): { orphans: Map<string, Orphan>; due: Orphan[] } {
  const orphans = new Map<string, Orphan>()
  const due: Orphan[] = []
  for (const l of lineage) {
    if (!isOrphan(l)) continue
    const key = `${l.pid}:${l.created}`
    const before = known.get(key)
    const started = filetimeMs(l.created)
    const shown = !!before?.shown || (!!before && started !== null && now - started >= bound)
    const o: Orphan = { ...(before ?? { ...launch, pid: l.pid, created: l.created, told: false }), cpuMs: l.cpu, shown }
    if (shown && !before?.shown) due.push(o)
    orphans.set(key, o)
  }
  return { orphans, due }
}

/** Each running launch's orphans, by run id, then by "pid:created". */
const byLaunch = new Map<string, Map<string, Orphan>>()
let timer: ReturnType<typeof setInterval> | null = null
let looking = false

/** Starts looking (once, at start): every POLL_MS, only while a launch runs, never starting the job host. */
export function startOrphanWatch(): void {
  if (timer || process.platform !== 'win32') return
  timer = setInterval(() => void look(), testMs('HIVE_TEST_ORPHAN_POLL_MS', POLL_MS))
  timer.unref?.()
}

/** Hive quitting. */
export function stopOrphanWatch(): void {
  if (timer) clearInterval(timer)
  timer = null
}

async function look(): Promise<void> {
  if (looking) return
  looking = true
  try {
    const launches = runningLaunches()
    for (const run of [...byLaunch.keys()]) if (!launches.some((l) => l.runId === run)) byLaunch.delete(run)
    if (!launches.length) return
    const all = await launchLineage(launches.map((l) => l.runId))
    if (!all) return
    const now = Date.now()
    for (const launch of launches) {
      if (!(launch.runId in all)) continue
      const { orphans, due } = lookAtLaunch(byLaunch.get(launch.runId) ?? new Map(), launch, parseLineage(all[launch.runId]), now, testMs('HIVE_TEST_ORPHAN_MS', ORPHAN_MS))
      // Stopped meanwhile: its leftovers are listed as such.
      if (!runningLaunches().some((l) => l.runId === launch.runId)) continue
      byLaunch.set(launch.runId, orphans)
      if (due.length) await shownNow(launch, due)
    }
  } catch (e) {
    log.warn('looking for processes left running', e)
  } finally {
    looking = false
  }
}

/** Orphans shown at this look: named by their command lines, logged, and told in a notice (once each). */
async function shownNow(launch: LaunchRef, due: Orphan[]): Promise<void> {
  const processes = (await launchProcessesNow(launch.runId)) ?? []
  for (const o of due) {
    const p = processes.find((x) => x.pid === o.pid && x.created === o.created)
    if (p) Object.assign(o, { label: commandText(p), command: p.command ?? p.label })
    const started = filetimeMs(o.created) ?? Date.now()
    log.info(`${userText(launch.agentName)}'s command left ${userText(o.label ?? String(o.pid))} (pid ${o.pid}) running, its parent gone, for ${Math.round((Date.now() - started) / 60_000)} min`)
    if (!advanced.get<boolean>(ORPHAN_NOTICE)) continue
    toast(
      'warning',
      tr(M.title, { agent: launch.agentName, command: cut(o.label ?? String(o.pid)), time: durationText(Date.now() - started, tr) }),
      tr(M.body, { pid: o.pid }),
      undefined,
      'processes',
      { kind: 'agent', projectPath: launch.projectPath, agentId: launch.agentId, name: launch.agentName, project: basename(launch.projectPath) }
    )
  }
}

/** A command as a notice's title names it: on one line, cut short. */
const cut = (s: string, n = 60): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

/**
 * An agent's orphans now (every one, shown or not: Pause the team counts them all), of its launches still running: a
 * stopped one's are its leftovers from then on (agentProcesses), never counted twice before the next look forgets them.
 */
export function orphansOf(projectPath: string, agentId: string): Orphan[] {
  const runs = new Set(runningLaunches().map((l) => l.runId))
  const out: Orphan[] = []
  for (const [run, m] of byLaunch) {
    if (!runs.has(run)) continue
    for (const o of m.values()) if (o.agentId === agentId && o.projectPath.toLowerCase() === projectPath.toLowerCase()) out.push(o)
  }
  return out
}

/** The shown orphan with this identity, if it is one now (Activity marks it). */
export function shownOrphan(runId: string, pid: number, created: string | undefined): Orphan | null {
  const o = created ? byLaunch.get(runId)?.get(`${pid}:${created}`) : undefined
  return o?.shown ? o : null
}

/** Activity's processes of a launch, those shown as left running marked with their CPU time. */
export function markOrphans(runId: string, processes: readonly ActivityProcess[]): ActivityProcess[] {
  return processes.map((p) => {
    const o = shownOrphan(runId, p.pid, p.created)
    return o ? { ...p, orphan: { cpuMs: o.cpuMs } } : p
  })
}

/**
 * The agent's line for what its commands left running (HI-2111), in English: each shown orphan it wasn't told of, once,
 * then counted as told. Empty when there's none, or with ORPHAN_NOTICE off (nothing counted as told then).
 */
export function orphanLinesFor(projectPath: string, agentId: string): string {
  if (!advanced.get<boolean>(ORPHAN_NOTICE)) return ''
  const due = orphansOf(projectPath, agentId).filter((o) => o.shown && !o.told)
  if (!due.length) return ''
  for (const o of due) o.told = true
  const each = due.map((o) => `pid ${o.pid} \`${cut(o.command ?? o.label ?? '?', 200)}\` (running ${Math.round((Date.now() - (filetimeMs(o.created) ?? Date.now())) / 60_000)} min)`) // i18n-ignore: agent-facing (a hook notice to the agent)
  return `${NOTICE_PREFIX}${due.length === 1 ? 'A process your command started is' : `${due.length} processes your commands started are`} still running with the shell that started ${due.length === 1 ? 'it' : 'them'} gone: ${each.join('; ')}. End ${due.length === 1 ? 'it' : 'them'} if not needed; Hive won't.` // i18n-ignore: agent-facing (a hook notice to the agent)
}

/** For tests: a launch's orphans as a look would leave them (null: forgotten). */
export function setOrphansForTests(runId: string, orphans: Orphan[] | null): void {
  if (orphans) byLaunch.set(runId, new Map(orphans.map((o) => [`${o.pid}:${o.created}`, o])))
  else byLaunch.delete(runId)
}

const M = {
  title: msg({ id: 'session.orphan.title', defaultMessage: '{agent} left {command} running for {time}', description: "A notice's title (HI-2111): a process an agent's command started is still running with the shell that started it gone. {agent} is the agent's name; {command} what the process runs, cut short; {time} how long it has run (\"12 min\")." }),
  body: msg({ id: 'session.orphan.body', defaultMessage: 'Process {pid}: the shell that started it has exited. Activity lists it, with End It; the agent is told too.', description: "The notice that an agent left a process running (HI-2111). {pid} is its process id. Activity is a tab of Hive's; End It is a button there." })
}
