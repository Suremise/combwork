import { join } from 'path'
import { Worker } from 'worker_threads'
import { previewable, type GuardPreview, type GuardProblem, type GuardReport, type MergeGuard } from '../../shared/workflow/mergeGuards'
import type { DiffRead } from '../platform/types'
import { bundledScriptExists, workerHere, workerStarted } from '../workerThreads'
import type { GuardsReply, GuardsRequest } from './mergeGuardsWorker'

/**
 * Running the merge guards (HI-3284, design HI-3284/s16 §1, §4): a merge's added lines read through its version control
 * (a `DiffRead`), then parsed and matched in a worker of its own (mergeGuardsWorker.ts) with a time limit. Whatever
 * can't finish (a read that fails, a diff past its bounds, the time limit, the worker ending, a cancel, a worker that
 * can't start) is incomplete, never a pass and never a match. A user's pattern never runs on main's thread, not even as
 * a fallback: with no worker, nothing is matched. The worker is ended (`terminate`) once the check settles, whatever
 * settled it, and the time limit's timer and the cancel's listener go with it.
 */

export type { DiffRead }

/** How long the empty-match rule may take at a save (design §4): past it the save is refused, naming the guard. */
export const EMPTY_CHECK_MS = 1_000

/** A check's outcome: its report, and whether an incomplete one was the environment's (a read that failed: tried again). */
export type GuardsOutcome = GuardReport & { transient?: boolean }

/** Why a worker gave no answer: its time limit (with the guard it was on), a cancel, or it failed or couldn't start. */
export type WorkerEnded = { ended: 'timedOut' | 'cancelled' | 'failed'; running?: string }

let scriptForTests: string | null = null
/** Tests: the worker's bundled script (built by the test, as the app's build makes merge-guards-worker.js). */
export function useGuardsWorker(script: string | null): void {
  scriptForTests = script
}
const guardsScript = (): string => scriptForTests ?? join(__dirname, 'merge-guards-worker.js')

/** Tests: the workers running now, to prove none outlives its check. */
export const guardWorkers = { live: 0 }

/**
 * One request in a worker of its own, ended once it settles: its answer, or why there is none (`timedOut` with the guard
 * it was on, `cancelled`, `failed`: it ended, or its script isn't there).
 */
export async function inWorker(m: GuardsRequest, timeoutMs: number, signal?: AbortSignal): Promise<GuardsReply | WorkerEnded> {
  if (signal?.aborted) return { ended: 'cancelled' }
  const script = guardsScript()
  if (!bundledScriptExists(script)) {
    workerHere('merge guards', "its script isn't there, so nothing is matched") // i18n-ignore: Copy Diagnostics' report, in English
    return { ended: 'failed' }
  }
  let w: Worker
  try {
    w = new Worker(script)
  } catch {
    return { ended: 'failed' }
  }
  guardWorkers.live++
  workerStarted('merge guards', w) // i18n-ignore: a worker's name, for Copy Diagnostics' report (English)
  let running: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    return await new Promise<GuardsReply | WorkerEnded>((done) => {
      let settled = false
      // The one way out: whatever settles it (an answer, the time limit, a cancel, the worker ending) settles it once.
      const settle = (r: GuardsReply | WorkerEnded): void => {
        if (settled) return
        settled = true
        done(r)
      }
      timer = setTimeout(() => settle({ ended: 'timedOut', ...(running !== undefined ? { running } : {}) }), timeoutMs)
      onAbort = (): void => settle({ ended: 'cancelled' })
      signal?.addEventListener('abort', onAbort, { once: true })
      w.on('message', (r: GuardsReply) => {
        if ('running' in r) running = r.running
        else settle(r)
      })
      w.on('error', () => settle({ ended: 'failed' }))
      w.on('exit', () => settle({ ended: 'failed' }))
      // A worker's port takes a transfer list where a window's postMessage takes an origin: none to transfer.
      w.postMessage(m, [])
    })
  } finally {
    clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
    // Ended whatever settled it: a runaway pattern stops here (terminate ends the thread mid-match), waited for so no
    // check leaves a thread behind.
    w.removeAllListeners()
    await w.terminate().catch(() => undefined)
    guardWorkers.live--
  }
}

/**
 * The guards over a merge's added lines (`read` gives them): a report of the matches, or incomplete with why. No guards,
 * nothing read and an empty report. `signal`: the check's life (the queue's lease, the workspace): once aborted, its
 * worker ends and the check is incomplete.
 */
export async function checkMergeGuards(guards: readonly MergeGuard[], read: () => Promise<DiffRead>, opts: { timeoutMs: number; maxLines: number; signal?: AbortSignal }): Promise<GuardsOutcome> {
  const none = (incomplete: string, transient = false): GuardsOutcome => ({ hits: [], more: 0, messages: [], incomplete, ...(transient ? { transient } : {}) })
  if (!guards.length) return { hits: [], more: 0, messages: [] }
  let d: DiffRead
  try {
    d = await read()
  } catch {
    return none('unreadable', true) // i18n-ignore: a reason's code
  }
  if ('tooLarge' in d) return none('tooLarge') // i18n-ignore: a reason's code
  if ('unreadable' in d) return none('unreadable', true) // i18n-ignore: a reason's code
  const r = await inWorker({ type: 'check', diff: d.text, guards: [...guards], maxLines: opts.maxLines }, opts.timeoutMs, opts.signal)
  if ('report' in r) return r.report
  if ('ended' in r) return none(r.ended === 'timedOut' ? `timedOut:${r.running ?? ''}` : r.ended === 'cancelled' ? 'cancelled' : 'failed', r.ended === 'cancelled') // i18n-ignore: a reason's code
  return none('failed') // i18n-ignore: a reason's code
}

/** A preview's bounds: the files, the text and one file's size read, and its time limit. */
export const PREVIEW_LIMITS = { maxFiles: 50_000, maxBytes: 64 * 1024 * 1024, maxFile: 2 * 1024 * 1024, timeoutMs: 10_000 }

/**
 * What one guard already matches in the project (HI-3284's decision), in the worker: `files` its version control's
 * (null: a walk of the folder leaving out `skipDirs`). A guard whose pattern or paths a save wouldn't take is incomplete,
 * never run; `signal` cancels it (its worker ended).
 */
export async function previewMergeGuard(root: string, files: string[] | null, skipDirs: string[], guard: MergeGuard, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<GuardPreview> {
  const none = (incomplete: string): GuardPreview => ({ count: 0, hits: [], files: 0, incomplete })
  if (!previewable(guard)) return none('invalid') // i18n-ignore: a reason's code
  const r = await inWorker({ type: 'preview', root, files, skipDirs, guard, maxFiles: PREVIEW_LIMITS.maxFiles, maxBytes: PREVIEW_LIMITS.maxBytes, maxFile: PREVIEW_LIMITS.maxFile }, opts.timeoutMs ?? PREVIEW_LIMITS.timeoutMs, opts.signal)
  if ('preview' in r) return r.preview
  return none('ended' in r ? r.ended : 'failed') // i18n-ignore: a reason's code
}

/** How many previews read at once, across every window (each a worker reading the project's files). */
export const PREVIEWS_AT_ONCE = 2

/** The previews waiting for their turn, oldest first, and those reading now; and each guard row's latest, by its slot. */
const previewQueue: { wake: () => void }[] = []
let previewsRunning = 0
const previewSlots = new Map<string, AbortController>()

/** Tests: the previews reading now and waiting. */
export const previewsNow = (): { running: number; waiting: number } => ({ running: previewsRunning, waiting: previewQueue.length })

/**
 * A preview in its turn (HR2's round 1, finding 3): at most PREVIEWS_AT_ONCE read at once, the rest wait, oldest first.
 * `slot` names the guard row asking: a newer request from it cancels the one before (ended if reading, dropped if
 * waiting), as `cancelPreview` does when the row closes. A cancelled preview answers `cancelled`, which the row ignores.
 */
export async function schedulePreview(slot: string | null, run: (signal: AbortSignal) => Promise<GuardPreview>): Promise<GuardPreview> {
  const cancelled: GuardPreview = { count: 0, hits: [], files: 0, incomplete: 'cancelled' } // i18n-ignore: a reason's code
  const ac = new AbortController()
  if (slot) {
    previewSlots.get(slot)?.abort()
    previewSlots.set(slot, ac)
  }
  try {
    // A turn frees when a reading preview ends (its finally wakes the next): wait for one while none is free.
    for (;;) {
      if (ac.signal.aborted || previewsRunning < PREVIEWS_AT_ONCE) break
      await new Promise<void>((resolve) => {
        const me = { wake: resolve }
        previewQueue.push(me)
        // Cancelled while waiting: out of the queue at once.
        ac.signal.addEventListener('abort', () => {
          const i = previewQueue.indexOf(me)
          if (i >= 0) previewQueue.splice(i, 1)
          resolve()
        }, { once: true })
      })
    }
    if (ac.signal.aborted) return cancelled
    previewsRunning++
    try {
      return await run(ac.signal)
    } finally {
      previewsRunning--
      previewQueue.shift()?.wake()
    }
  } finally {
    if (slot && previewSlots.get(slot) === ac) previewSlots.delete(slot)
  }
}

/** A guard row closed, or its guard changed: its preview cancelled (its worker ended, or it never starts). */
export function cancelPreview(slot: string): void {
  previewSlots.get(slot)?.abort()
  previewSlots.delete(slot)
}

/**
 * The empty-match rule at a save (design §4), off main's thread: each pattern that matches an empty line, or that takes
 * past EMPTY_CHECK_MS to say (the guard it was on named), is a problem; a worker that couldn't run says the patterns
 * couldn't be checked (the save refused: never taken unchecked). Run before a save takes the workflow's lock.
 */
export async function emptyMatchProblems(guards: readonly MergeGuard[] | undefined, timeoutMs = EMPTY_CHECK_MS): Promise<GuardProblem[]> {
  if (!guards?.length) return []
  const r = await inWorker({ type: 'empty', guards: [...guards] }, timeoutMs)
  if ('problems' in r) return r.problems
  const ended = 'ended' in r ? r : { ended: 'failed' as const, running: undefined }
  const at = ended.running !== undefined ? Number(ended.running) : 0
  return [{ guard: Number.isFinite(at) ? at : 0, field: 'pattern', why: ended.ended === 'timedOut' ? 'timedOut' : 'unchecked' }] // i18n-ignore: problems' codes (GUARD_PROBLEMS has their messages)
}
