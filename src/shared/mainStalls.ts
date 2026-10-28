/**
 * The main process's recent stalls, as the Performance view shows them (HI-1135): what main/mainStalls.ts noted in
 * hive.log as "The main process was busy", kept in memory since Hive started. Every label is a fixed name Hive gives
 * the work (a channel, a route template, a hook's event, a step and its file's own name), never the user's text.
 */

/** Work under way during a stall, as it was when the stall was recorded. */
export interface MainStallWork {
  label: string
  /** How long it took (the whole work, as hive.log's line says it, not only its overlap with the stall); so far, while running. */
  ms: number
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
  stepsMore: number
  /** The other work it overlapped (IPC calls, Agent API requests, hooks): context, which may only have waited behind it. */
  work: MainStallWork[]
  workMore: number
}

export interface MainStalls {
  /** Newest first, at most MAIN_STALLS_KEPT. */
  stalls: MainStall[]
  /** Every stall since Hive started, listed or not. */
  total: number
  /** When Hive started watching (epoch ms). */
  since: number
}

export const MAIN_STALLS_KEPT = 50

/** Whether a stall was mostly waiting (the disk, a lock, a child process): CPU under half its length. Unknown CPU isn't. */
export const mostlyWaiting = (s: Pick<MainStall, 'ms' | 'cpuMs'>): boolean => s.cpuMs !== null && s.cpuMs < s.ms / 2
