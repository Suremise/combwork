import { stat } from 'original-fs'
import { parentPort, workerData } from 'worker_threads'

/**
 * The stall watchdog (HI-1692): a thread beside main that only ticks, noting each gap in its own ticks. When main stalls,
 * the watchdog either ticked on (main itself was blocked: Combwork's, a warning) or stopped for the same span (the whole
 * process was paused: the PC asleep without powerMonitor saying so, the display off, the process suspended; not Combwork's,
 * not counted). Darren's log had stalls of 7–8 s with no main-thread CPU and nothing under way, at quiet times, that only
 * this can tell apart. Shared with main: [0] the last tick, [1] how many gaps were noted, then the latest GAPS gaps as
 * (start, end) pairs, each in ms since the epoch (performance's timeOrigin + now: the same on both threads).
 */

const TICK_MS = 50
/** A gap in its ticks longer than this is noted. */
const GAP_MS = 250
const GAPS = 16
/**
 * It also times a file call through the thread pool (HI-1702): a stat every PROBE_MS, one at a time, the latest that took
 * over PROBE_SLOW_MS kept after the gaps as (how many so far, its start, how long it took). Timed here, on a thread
 * that only ticks, a main thread busy meanwhile isn't counted: only the pool's wait and the disk's.
 */
const PROBE = 2 + 2 * GAPS
const PROBE_MS = 1000
export const PROBE_SLOW_MS = 250
export const WATCHDOG_SLOTS = PROBE + 3

const at = (): number => performance.timeOrigin + performance.now()

/** One tick: a gap since the last noted. */
export function watchdogTick(ticks: Float64Array, now = at()): void {
  const last = ticks[0]
  if (last && now - last > GAP_MS) {
    const i = ticks[1] % GAPS
    ticks[2 + 2 * i] = last
    ticks[3 + 2 * i] = now
    ticks[1]++
  }
  ticks[0] = now
}

/**
 * Whether the watchdog stopped over most of [from, to] too (ms since the epoch): a gap of its own covering 80% of it.
 * False when it can't say (it hasn't ticked since `to`: not running, or stopped now).
 */
export function pausedAlongside(ticks: Float64Array, from: number, to: number): boolean {
  if (!(ticks[0] >= to)) return false
  const span = to - from
  for (let i = 0; i < Math.min(ticks[1], GAPS); i++) {
    const start = ticks[2 + 2 * i]
    const end = ticks[3 + 2 * i]
    if (Math.min(to, end) - Math.max(from, start) >= 0.8 * span) return true
  }
  return false
}

/** A probe that has ended (ms since the epoch): kept when it was slow, its count raised last. */
export function probeEnded(ticks: Float64Array, start: number, end: number): void {
  if (end - start <= PROBE_SLOW_MS) return
  ticks[PROBE + 1] = start
  ticks[PROBE + 2] = end - start
  ticks[PROBE]++
}

/** The latest slow probe: how many there have been, its start (ms since the epoch) and how long it took; null if none. */
export function slowProbe(ticks: Float64Array): { n: number; start: number; ms: number } | null {
  return ticks[PROBE] ? { n: ticks[PROBE], start: ticks[PROBE + 1], ms: ticks[PROBE + 2] } : null
}

if (parentPort && workerData instanceof SharedArrayBuffer) {
  const ticks = new Float64Array(workerData)
  setInterval(() => watchdogTick(ticks), TICK_MS)
  let probing = false
  setInterval(() => {
    if (probing) return
    probing = true
    const start = at()
    stat(process.execPath, () => {
      probing = false
      probeEnded(ticks, start, at())
    })
  }, PROBE_MS)
}
