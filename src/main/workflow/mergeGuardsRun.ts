import { join } from 'path'
import { Worker } from 'worker_threads'
import { previewable, type GuardPreview, type GuardProblem, type GuardReport, type MergeGuard } from '../../shared/workflow/mergeGuards'
import type { DiffRead } from '../platform/types'
import { bundledScriptExists, workerHere } from '../workerThreads'
import type { GuardsReply, GuardsRequest } from './mergeGuardsWorker'

/**
 * Running the merge guards (HI-3284, design HI-3284/s16 §1, §4): a merge's added lines read through its version control
 * (a `DiffRead`), then parsed and matched in a worker of its own (mergeGuardsWorker.ts) with a time limit. Whatever
 * can't finish (a read that fails, a diff past its bounds, the time limit, the worker ending, a cancel) is incomplete,
 * never a pass and never a match. The worker is ended (`terminate`) once the check settles, whatever settled it.
 */

export type { DiffRead }

/** How long the empty-match rule may take at a save (design §4): past it the save is refused, naming the guard. */
export const EMPTY_CHECK_MS = 1_000

/** A check's outcome: its report, and whether an incomplete one was the environment's (a read that failed: tried again). */
export type GuardsOutcome = GuardReport & { transient?: boolean }

let scriptForTests: string | null = null
/** Tests: the worker's bundled script (null: in this thread, as with no build). */
export function useGuardsWorker(script: string | null): void {
  scriptForTests = script
}
const guardsScript = (): string => scriptForTests ?? join(__dirname, 'merge-guards-worker.js')

/**
 * One request in a worker of its own, ended once it settles: its answer, or why there is none (`timedOut` with the
 * guard it was on, `cancelled`, `failed`). Where no worker script is built (unit tests without one), in this thread.
 */
export async function inWorker(m: GuardsRequest, timeoutMs: number, signal?: AbortSignal): Promise<GuardsReply | { ended: 'timedOut' | 'cancelled' | 'failed'; running?: string }> {
  if (signal?.aborted) return { ended: 'cancelled' }
  const script = guardsScript()
  if (!bundledScriptExists(script)) {
    workerHere('merge guards', "its script isn't there") // i18n-ignore: Copy Diagnostics' report, in English
    const { handleGuards } = await import('./mergeGuardsWorker')
    return handleGuards(m, () => undefined)
  }
  const w = new Worker(script)
  let running: string | undefined
  try {
    return await new Promise((done) => {
      const timer = setTimeout(() => done({ ended: 'timedOut', ...(running !== undefined ? { running } : {}) }), timeoutMs)
      const onAbort = (): void => done({ ended: 'cancelled' })
      signal?.addEventListener('abort', onAbort, { once: true })
      const settle = (r: Parameters<typeof done>[0]): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        done(r)
      }
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
    // Ended whatever settled it: a runaway pattern stops here (terminate ends the thread mid-match).
    w.removeAllListeners()
    void w.terminate().catch(() => undefined)
  }
}

/**
 * The guards over a merge's added lines (`read` gives them): a report of the matches, or incomplete with why. No guards,
 * nothing read and an empty report.
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
 * What one guard already matches in the project (Darren's decision, 15 Nov), in the worker: `files` its version
 * control's (null: a walk of the folder leaving out `skipDirs`). A guard a save wouldn't take is incomplete, never run.
 */
export async function previewMergeGuard(root: string, files: string[] | null, skipDirs: string[], guard: MergeGuard, timeoutMs = PREVIEW_LIMITS.timeoutMs): Promise<GuardPreview> {
  const none = (incomplete: string): GuardPreview => ({ count: 0, hits: [], files: 0, incomplete })
  if (!previewable(guard)) return none('invalid') // i18n-ignore: a reason's code
  const r = await inWorker({ type: 'preview', root, files, skipDirs, guard, maxFiles: PREVIEW_LIMITS.maxFiles, maxBytes: PREVIEW_LIMITS.maxBytes, maxFile: PREVIEW_LIMITS.maxFile }, timeoutMs)
  if ('preview' in r) return r.preview
  return none('ended' in r && r.ended === 'timedOut' ? 'timedOut' : 'failed') // i18n-ignore: a reason's code
}

/**
 * The empty-match rule at a save (design §4), off main's thread: each pattern that matches an empty line, or that takes
 * past EMPTY_CHECK_MS to say (the guard it was on named), is a problem. Run before a save takes the workflow's lock.
 */
export async function emptyMatchProblems(guards: readonly MergeGuard[] | undefined, timeoutMs = EMPTY_CHECK_MS): Promise<GuardProblem[]> {
  if (!guards?.length) return []
  const r = await inWorker({ type: 'empty', guards: [...guards] }, timeoutMs)
  if ('problems' in r) return r.problems
  const at = 'ended' in r && r.running !== undefined ? Number(r.running) : 0
  return [{ guard: Number.isFinite(at) ? at : 0, field: 'pattern', why: 'timedOut' }] // i18n-ignore: a problem's code (GUARD_PROBLEMS has its message)
}
