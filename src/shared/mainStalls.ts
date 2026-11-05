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

export interface MainStalls {
  /** Newest first, at most MAIN_STALLS_KEPT. */
  stalls: MainStall[]
  /** Every stall since Combwork started, listed or not. */
  total: number
  /** When Combwork started watching (epoch ms). */
  since: number
}

export const MAIN_STALLS_KEPT = 50

/** Whether a stall was mostly waiting (the disk, a lock, a child process): CPU under half its length. Unknown CPU isn't. */
export const mostlyWaiting = (s: Pick<MainStall, 'ms' | 'cpuMs'>): boolean => s.cpuMs !== null && s.cpuMs < s.ms / 2
