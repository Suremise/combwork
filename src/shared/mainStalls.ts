/**
 * The main process's recent stalls, as the Performance view shows them (HI-1135): what main/mainStalls.ts noted in
 * combwork.log as "The main process was busy", kept in memory since Combwork started. Every label is a fixed name Combwork gives
 * the work (a channel, a route template, a hook's event, a step and its file's own name), never the user's text.
 */

/** Work under way during a stall, as it was when the stall was recorded: each label once, with how many there were. */
export interface MainStallWork {
  label: string
  /** How many works had this label (the Assistant's review: one line each, not one per call). */
  count: number
  /** How long they took in all (each the whole work, as combwork.log's line says it, not only its overlap with the stall); so far, while running. */
  ms: number
  /** Whether one of them was still running. */
  running: boolean
}

export interface MainStall {
  /** When it ended (epoch ms). */
  at: number
  ms: number
  /** The main thread's CPU time over it; null where Node can't tell. */
  cpuMs: number | null
  /** The synchronous steps that held the thread (HI-1692): the stronger evidence of a cause. */
  steps: MainStallWork[]
  /** How many works the labels not listed had. */
  stepsMore: number
  /** The other work it overlapped (IPC calls, Agent API requests, hooks): context, which may only have waited behind it. */
  work: MainStallWork[]
  workMore: number
}

/**
 * One hour of main's event loop delays (HI-3293): the short hitches the stall list leaves out, counted, and the stalls'
 * causes, every one of them, where the log names only one stall a minute. A hitch is counted once per half second, the
 * longest delay in it (the delay as stalls are measured: Node's event loop delay, whose 20 ms timer is in it).
 */
export interface MainDelayHour {
  /** The hour's start (epoch ms, a whole hour of the PC's clock). */
  at: number
  /** Half seconds whose longest delay was 50 ms up to 100 ms. */
  d50: number
  /** From 100 ms up to the stalls' 250 ms. */
  d100: number
  /** Stalls (more than 250 ms, the PC's sleep and pauses of the whole process left out): every one, logged or not. */
  stalls: number
  /** How many of them combwork.log didn't name (its one warning a minute). */
  unlogged: number
  /** Each stall's first-named work (the step that held the thread, else the longest overlapping work), by label: the most first. */
  top: { label: string; count: number }[]
  /** Stalls with nothing marked under way. */
  unnamed: number
}

export interface MainStalls {
  /** Newest first, at most MAIN_STALLS_KEPT. */
  stalls: MainStall[]
  /** The hours since Combwork started with a delay counted, newest first (the current one too), at most MAIN_DELAY_HOURS_KEPT. */
  hours: MainDelayHour[]
  /** Every stall since Combwork started, listed or not. */
  total: number
  /** When Combwork started watching (epoch ms). */
  since: number
}

export const MAIN_STALLS_KEPT = 50
export const MAIN_DELAY_HOURS_KEPT = 24
/** The hitches counted (ms): from 50 to 100, from 100 up to a stall's 250. */
export const HITCH_MS = [50, 100] as const

/** Whether a stall was mostly waiting (the disk, a lock, a child process): CPU under half its length. Unknown CPU isn't. */
export const mostlyWaiting = (s: Pick<MainStall, 'ms' | 'cpuMs'>): boolean => s.cpuMs !== null && s.cpuMs < s.ms / 2
