import { monitorEventLoopDelay } from 'perf_hooks'
import { join } from 'path'
import { Worker } from 'worker_threads'
import { app, powerMonitor } from 'electron'
import { createLogger } from './logger'
import { ended, running, stallClock, type Work } from './stallWork'
import { pausedAlongside, slowProbe, WATCHDOG_SLOTS } from './stallWatchdog'
import { threadPoolSize } from './threadPool'
import { bundledScriptExists, workerHere, workerStarted } from './workerThreads'
import { MAIN_STALLS_KEPT, type MainStall, type MainStalls, type MainStallWork } from '../shared/mainStalls'

export { beginWork, stallClock, timedStep } from './stallWork'

/**
 * Notes in combwork.log when the main process was busy long enough to be felt (every terminal's typing goes through it), at
 * most once a minute, so pauses can be matched with what Hive was doing (#1109). The delay is Node's event loop delay
 * (`monitorEventLoopDelay`: its timer, every 20 ms, catches a block wherever it falls), read every half second. A gap
 * that spans the PC's sleep isn't a stall: the warning waits a few seconds, and a suspend or resume during it drops it
 * (one info line instead). The line names the work that overlapped the stall: IPC calls, Agent API requests, hooks and
 * the synchronous steps that can wait (stallWork.ts, HI-1692: a database's open, BEGIN, commit or transaction, a kept file
 * read), each by its fixed name (a channel, a route template, a hook's event, a file's own name: never the user's text),
 * with how long it took, and the main thread's CPU time over it (a stall with little CPU was waiting: on the disk, a child
 * process, a lock).
 *
 * A pause of the whole process isn't a stall either (HI-1692): a watchdog thread ticks on its own (stallWatchdog.ts),
 * and a stall its ticks stopped for too is the PC or the process paused (a sleep powerMonitor didn't tell, the display
 * off, the process suspended): one info line, not counted as busy.
 */

const log = createLogger('main')

/** The work a stall overlapped, kept as it is found, so later traffic pushing it out of `ended` can't lose its cause. */
const HELD_PER_STALL = 50
/** How many a warning names (the rest are counted). */
const NAMED = 5

// Labels from what a request says: only names Hive knows, so nothing a client sends reaches the log.
const HOOK_EVENTS = new Set(['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SubagentStop', 'Interrupt', 'ErrorOccurred', 'PreCompact', 'PostCompact'])
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
/** Agent API requests that wait by design (an event stream, a wait for cards or agents): open for minutes, never a cause. */
const IDLE = new Set(['api GET /v1/events', 'api POST /v1/tasks/wait', 'api POST /v1/agents/wait'])

/** A hook as a stall names it: its event if it is one the CLIs send, or the status line. */
export function hookLabel(statusLine: boolean, body: unknown): string {
  if (statusLine) return 'hook status line'
  const event = (body as { hook_event_name?: unknown } | null)?.hook_event_name
  return `hook ${typeof event === 'string' && HOOK_EVENTS.has(event) ? event : '(other event)'}`
}

/** An Agent API request as a stall names it: its method and route template (the router's, never the URL). */
export function apiLabel(method: string | undefined, route: string): string {
  return `api ${METHODS.has(method ?? '') ? method : 'other'} ${route}`
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`

/** A suspend or resume as powerMonitor told it, on `now`'s clock. */
interface PowerEvent {
  at: number
  resume: boolean
}

/**
 * Whether the PC slept over a stall or probe that began at `start`: a power event from `from - 1000` on (a suspend may be
 * told just before the stall's measured start, a resume after its end), up to `until`. A resume before `start` ended
 * that sleep before this began, so it and the events before it don't count (HI-2317: a busy stall soon after a resume
 * was taken for the sleep's).
 */
function sleptOver(power: PowerEvent[], from: number, start: number, until = Infinity): boolean {
  const woke = power.reduce((at, e) => (e.resume && e.at < start ? Math.max(at, e.at) : at), -Infinity)
  return power.some((e) => e.at >= from - 1000 && e.at <= until && e.at > woke)
}

const overlapOf = (w: Work, from: number, to: number, now: number): number => Math.min(to, w.end ?? now) - Math.max(from, w.start)

const labelOf = (w: Work): string => (typeof w.label === 'string' ? w.label : w.label())

/**
 * The work that overlapped [from, to] (with `held`, found earlier), the most overlap first, however long it has run (a
 * handler can wake from an await, block, and await again), but for the requests that wait by design (Darren's choice,
 * 20 Oct: the line is evidence to read, not a verdict). Synchronous steps come first (HR6's round 1 of HI-1692): one held
 * the thread itself, and the calls overlapping it, often many, may only have waited behind it, so it is never left among
 * the ones counted.
 */
function overlapping(from: number, to: number, held: Work[] = []): Work[] {
  const now = stallClock.mono()
  const o = (w: Work): number => overlapOf(w, from, to, now)
  return [...new Set([...held, ...running, ...ended])].filter((w) => o(w) > 0 && !IDLE.has(labelOf(w))).sort((a, b) => Number(!!b.step) - Number(!!a.step) || o(b) - o(a) || b.start - a.start)
}

/** The work that overlapped [from, to], the most overlap first: at most `max` described, and how many more. */
export function workDuring(from: number, to: number, max = NAMED, held: Work[] = []): { work: string[]; more: number } {
  const now = stallClock.mono()
  const found = overlapping(from, to, held)
  const work = found.slice(0, max).map((w) => `${labelOf(w)} (${seconds((w.end ?? now) - w.start)}${w.end === null ? ', still running' : ''})`)
  return { work, more: found.length - work.length }
}

/**
 * A stall as the Performance view keeps it (HI-1135), its work found as the warning finds it, copied now (labels made,
 * times fixed), so later changes to the work can't change it: the synchronous steps apart from the other work, each
 * label once with its count and total time, the longest total first (the Assistant's review: a burst of one call
 * crowded out the rest), at most NAMED each, with how many works the rest had.
 */
export function stallOf(from: number, to: number, ms: number, cpuMs: number | null, held: Work[] = []): Omit<MainStall, 'at'> {
  const now = stallClock.mono()
  const found = overlapping(from, to, held)
  const grouped = (ws: Work[]): { list: MainStallWork[]; more: number } => {
    const by = new Map<string, MainStallWork>()
    for (const w of ws) {
      const label = labelOf(w)
      const g = by.get(label) ?? { label, count: 0, ms: 0, running: false }
      g.count++
      g.ms += (w.end ?? now) - w.start
      g.running ||= w.end === null
      by.set(label, g)
    }
    const all = [...by.values()].map((g) => ({ ...g, ms: Math.round(g.ms) })).sort((a, b) => b.ms - a.ms || b.count - a.count)
    return { list: all.slice(0, NAMED), more: all.slice(NAMED).reduce((n, g) => n + g.count, 0) }
  }
  const steps = grouped(found.filter((w) => w.step))
  const work = grouped(found.filter((w) => !w.step))
  return { ms, cpuMs, steps: steps.list, stepsMore: steps.more, work: work.list, workMore: work.more }
}

/** The stalls kept since Hive started (HI-1135): the last MAIN_STALLS_KEPT, and how many in all. */
const recent: MainStall[] = []
let stallsSeen = 0
let watchingSince = Date.now()

export function keepStall(s: MainStall): void {
  stallsSeen++
  recent.push(s)
  if (recent.length > MAIN_STALLS_KEPT) recent.shift()
}

/** The Performance view's stalls (performance:stalls): newest first. */
export function recentStalls(): MainStalls {
  return { stalls: [...recent].reverse(), total: stallsSeen, since: watchingSince }
}

export function resetStallsForTests(): void {
  recent.length = 0
  stallsSeen = 0
}

export interface StallDeps {
  now(): number
  /**
   * The longest event loop delay since the last call, in ms (and starts measuring afresh), or null when it recorded none:
   * its timer had no whole turn since, the loop held from about the last call on (HI-2317: Node's reset forgets its
   * timer's last turn, so a block that begins before the next is never measured).
   */
  longestDelayMs(): number | null
  /** The main thread's CPU time so far in ms, or null where Node can't tell. */
  cpuMs(): number | null
  defer(fn: () => void, ms: number): void
  warn(line: string): void
  info(line: string): void
  /** Whether Hive's other threads stopped over [from, to] too (the watchdog's ticks): the whole process paused. */
  pausedAlongside?(from: number, to: number): boolean
  /** Keeps a stall for the Performance view (HI-1135), `end` its end on `now`'s clock: every one, logged or not, but not a pause. */
  record?(stall: Omit<MainStall, 'at'>, end: number): void
}

export const STALL_TIMING = { every: 500, over: 250, settleMs: 3000, quietMs: 60_000 }

/** The watch itself, with what it reads given (unit tests fake them): tick() every `every` ms, power() on a suspend or resume. */
export function stallWatcher(d: StallDeps, t = STALL_TIMING): { tick(): void; power(resume?: boolean): void } {
  let last = d.now()
  let cpuLast = d.cpuMs()
  let logged = -Infinity
  let unlogged = 0
  const power: PowerEvent[] = []
  return {
    power(resume = false): void {
      power.push({ at: d.now(), resume })
      if (power.length > 20) power.shift()
    },
    tick(): void {
      const now = d.now()
      const cpu = d.cpuMs()
      const cpuUsed = cpu !== null && cpuLast !== null ? cpu - cpuLast : null
      // The loop delay, or how late this timer itself is (whichever is longer: the histogram's timer may only fire next).
      // None recorded: the loop was held from about the last tick on, the whole time since.
      const delay = Math.max(d.longestDelayMs() ?? now - last, now - last - t.every)
      const since = last
      last = now
      cpuLast = cpu
      if (delay <= t.over) return
      const from = Math.min(since, now - delay)
      const span = [now - delay - t.every, now] as const
      const held = overlapping(...span).slice(0, HELD_PER_STALL)
      // Decided a little later: the resume may be told after the first timer that ran late, and work that was held up
      // ends just after.
      d.defer(() => {
        const ms = Math.round(delay)
        if (sleptOver(power, from, now - delay)) return d.info(`The main process was paused for ${ms} ms while the PC slept: not counted as busy`)
        if (d.pausedAlongside?.(now - delay, now)) return d.info(`The main process was paused for ${ms} ms with the rest of Combwork's process (its watchdog thread stopped too: the PC or the process was paused): not counted as busy`)
        const cpuMs = cpuUsed === null ? null : Math.round(Math.min(cpuUsed, delay + t.every))
        // Kept before the log's quiet minute: the view lists the stalls the log leaves out too.
        d.record?.(stallOf(...span, ms, cpuMs, held), now)
        if (d.now() - logged < t.quietMs) {
          unlogged++
          return
        }
        logged = d.now()
        const { work, more } = workDuring(...span, NAMED, held)
        const parts = [cpuMs === null ? '' : ` (main thread CPU ${cpuMs} ms)`]
        parts.push(work.length ? `; during it: ${work.join(', ')}${more ? ` and ${more} more` : ''}` : '; nothing marked was under way (no IPC call, Agent API request or hook, nor a database or kept file step)')
        if (unlogged) parts.push(`; ${unlogged} more stall(s) since the last warning, not logged`)
        unlogged = 0
        d.warn(`The main process was busy for ${ms} ms${parts.join('')}`)
      }, t.settleMs)
    }
  }
}

export interface FileWaitDeps {
  now(): number
  /** The watchdog thread's latest slow file call (stallWatchdog.ts): how many so far, its start (on `now`'s clock), how long it took. */
  slowProbe(): { n: number; start: number; ms: number } | null
  defer(fn: () => void, ms: number): void
  warn(line: string): void
  /** Whether Hive's other threads stopped over [from, to] too (the watchdog's ticks): the whole process paused. */
  pausedAlongside?(from: number, to: number): boolean
}

export const FILE_WAIT_TIMING = { every: 1000, settleMs: 3000, quietMs: 60_000 }

/**
 * Notes in combwork.log when a file call took long enough to be felt (HI-1702), at most once a minute. Every asynchronous
 * file call of main's and its worker threads takes one of the pool's threads (threadPool.ts): with them all held by
 * slow calls, the next waits, and a step awaiting many in turn (a window's open, a session listing) takes seconds
 * although no task holds main's thread, so the busy warning above never sees it. The call is the watchdog thread's
 * stat, every second (stallWatchdog.ts): timed on a thread that only ticks, main's thread being busy meanwhile isn't
 * in it (HR2's round 1: timed on main, a stall after the probe began was reported as the pool's). What it can't tell
 * apart is the pool's wait from the disk's, so the line says both. A probe the PC's sleep or a pause of the whole
 * process covered isn't counted, decided a little later as the busy warning is.
 */
export function fileWaitWatcher(d: FileWaitDeps, poolSize: number, t = FILE_WAIT_TIMING): { tick(): void; power(resume?: boolean): void } {
  let seen = 0
  let logged = -Infinity
  let unlogged = 0
  const power: PowerEvent[] = []
  return {
    power(resume = false): void {
      power.push({ at: d.now(), resume })
      if (power.length > 20) power.shift()
    },
    tick(): void {
      const p = d.slowProbe()
      if (!p || p.n === seen) return
      seen = p.n
      const end = p.start + p.ms
      d.defer(() => {
        if (sleptOver(power, p.start, p.start, end + t.settleMs)) return
        if (d.pausedAlongside?.(p.start, end)) return
        if (d.now() - logged < t.quietMs) {
          unlogged++
          return
        }
        logged = d.now()
        const { work, more } = workDuring(p.start, end)
        const parts = [work.length ? `; during it: ${work.join(', ')}${more ? ` and ${more} more` : ''}` : '']
        if (unlogged) parts.push(`; ${unlogged} more slow file call(s) since the last warning, not logged`)
        unlogged = 0
        d.warn(`A file call took ${Math.round(p.ms)} ms to end (timed off main's thread): it waited for the thread pool, whose ${poolSize} threads main and its worker threads share for file, zlib, crypto and DNS work, or for the disk${parts.join('')}`)
      }, t.settleMs)
    }
  }
}

/** The watchdog's ticks (stallWatchdog.ts), shared with its thread; null until it starts, or where it can't. */
let watchdog: Float64Array | null = null

/** Starts the watchdog thread beside main (its script beside main's, as the other workers'); none in unit tests. */
function startWatchdog(): void {
  const script = join(__dirname, 'stall-watchdog.js')
  if (!bundledScriptExists(script)) return workerHere('stall watchdog', "its script isn't there") // i18n-ignore: Copy Diagnostics' report, in English
  const ticks = new Float64Array(new SharedArrayBuffer(WATCHDOG_SLOTS * Float64Array.BYTES_PER_ELEMENT))
  try {
    const w = new Worker(script, { workerData: ticks.buffer })
    // It only ticks: running once it has.
    workerStarted('stall watchdog', w, () => ticks[0] > 0) // i18n-ignore: a worker's name, for Copy Diagnostics' report (English)
    w.on('error', (e) => log.warn('the stall watchdog thread ended', e))
    w.on('exit', () => void (watchdog = null))
    w.unref()
    watchdog = ticks
  } catch (e) {
    log.warn('starting the stall watchdog thread', e)
  }
}

export function watchMainStalls(): void {
  watchingSince = Date.now()
  startWatchdog()
  const delays = monitorEventLoopDelay({ resolution: 20 })
  delays.enable()
  // Tests (unpackaged builds): HIVE_TEST_STALL_QUIET_MS shortens the minute between warnings, so a stall at start
  // doesn't hide the one a suite makes.
  const quietMs = (!app.isPackaged && Number(process.env.HIVE_TEST_STALL_QUIET_MS)) || STALL_TIMING.quietMs
  const thread = (process as { threadCpuUsage?: () => { user: number; system: number } }).threadCpuUsage
  const watch = stallWatcher({
    now: () => stallClock.mono(),
    longestDelayMs: () => {
      const ms = delays.count ? delays.max / 1e6 : null
      delays.reset()
      return ms
    },
    cpuMs: () => {
      if (!thread) return null
      const u = thread.call(process)
      return (u.user + u.system) / 1000
    },
    defer: (fn, ms) => setTimeout(fn, ms).unref(),
    warn: (line) => log.warn(line),
    info: (line) => log.info(line),
    pausedAlongside: (from, to) => (watchdog ? pausedAlongside(watchdog, performance.timeOrigin + from, performance.timeOrigin + to) : false),
    record: (s, end) => keepStall({ at: Math.round(performance.timeOrigin + end), ...s })
  }, { ...STALL_TIMING, quietMs })
  powerMonitor.on('suspend', () => watch.power())
  powerMonitor.on('resume', () => watch.power(true))
  setInterval(() => watch.tick(), STALL_TIMING.every).unref()
  const files = fileWaitWatcher({
    now: () => stallClock.mono(),
    slowProbe: () => {
      const p = watchdog ? slowProbe(watchdog) : null
      return p && { ...p, start: p.start - performance.timeOrigin }
    },
    defer: (fn, ms) => setTimeout(fn, ms).unref(),
    warn: (line) => log.warn(line),
    pausedAlongside: (from, to) => (watchdog ? pausedAlongside(watchdog, performance.timeOrigin + from, performance.timeOrigin + to) : false)
  }, threadPoolSize, { ...FILE_WAIT_TIMING, quietMs })
  powerMonitor.on('suspend', () => files.power())
  powerMonitor.on('resume', () => files.power(true))
  setInterval(() => files.tick(), FILE_WAIT_TIMING.every).unref()
}
