/**
 * The work under way on a thread, for "The main process was busy" (#1109, mainStalls.ts): what a stall overlapped is named
 * in its warning. IPC calls, Agent API requests and hooks are marked as they run; so are the synchronous steps that can
 * wait (HI-1692: a database's open, `BEGIN IMMEDIATE`'s busy wait, a commit, a transaction, a kept file read at start),
 * which were the cause the warning couldn't name. Its own module, with no Electron in it: db.ts and the files it reads run
 * in the usage worker too, where a mark just goes unread.
 */

export const stallClock = { mono: (): number => performance.now() }

export interface Work {
  /** A fixed name, or how to make it once it is known (an API request's route, found after it began). */
  label: string | (() => string)
  start: number
  end: number | null
  /** A synchronous step (timedStep, noteStep): it held the thread itself, where a call may only have waited behind it. */
  step?: true
}

/** Work under way, and the latest ended (enough to cover a burst of calls during a stall). */
export const running = new Set<Work>()
export const ended: Work[] = []
const ENDED_KEPT = 200

/** Marks work as begun (a fixed name, never the user's text); call what it returns when it has ended. */
export function beginWork(label: Work['label'], step = false): () => void {
  const w: Work = { label, start: stallClock.mono(), end: null, ...(step ? { step: true as const } : {}) }
  running.add(w)
  return () => {
    if (w.end !== null) return
    w.end = stallClock.mono()
    running.delete(w)
    ended.push(w)
    if (ended.length > ENDED_KEPT) ended.shift()
  }
}

/**
 * Notes a step that has just ended, from `start` (stallClock's), as work done: for steps too frequent to mark each time
 * (a log line), noted only when slow, so a stall they caused still names them.
 */
export function noteStep(label: string, start: number): void {
  ended.push({ label, start, end: stallClock.mono(), step: true })
  if (ended.length > ENDED_KEPT) ended.shift()
}

/** Runs a synchronous step that can wait (the disk, a lock), marked as work by its fixed name (HI-1692). */
export function timedStep<T>(label: string, fn: () => T): T {
  const done = beginWork(label, true)
  try {
    return fn()
  } finally {
    done()
  }
}
