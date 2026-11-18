import { AsyncLocalStorage } from 'async_hooks'
import { combworkError } from './combworkError'
import { msg } from '../shared/i18n/msg'
import type { WorkspaceService } from './workspace'

/**
 * HI-3372: the user's Cancel of their own git work from the window (a Commit or Set aside, a Fetch, Pull or Push). The
 * window names each run by an id of its own (`op`); its handler registers it here before anything runs, with its owner
 * (the window's webContents, its workspace's open and the project), and ends it whatever ends the run. A Cancel ends a run
 * only when its caller is that owner: an id unknown, already ended, or another window's, workspace's or project's changes
 * nothing. A window or workspace that closes takes its runs off the list (they run to their end, as before: a close never
 * cancels a push). No agent tool or Agent API route reaches it: these are the user's window actions only.
 */

/** Who may cancel a run: the window that started it, in that workspace's open, for that project. */
export interface CancelOwner {
  sender: number
  ws: WorkspaceService
  project: string
}

const M = {
  taken: msg({ id: 'service.gitCancel.taken', defaultMessage: 'That action is already running.', description: "HI-3372: an error when the window starts an action (a commit, a fetch, a push) under an id another one still runs under: it isn't started again." })
}

const runs = new Map<string, { owner: CancelOwner; ctl: AbortController }>()

/**
 * The user's Cancel of the git run going now, for the Git modules' steps to take (gitRepo's network commands; Commit's and
 * Set aside's forward steps): set around the run by its IPC handler, read where git is started. Here, not in a Git
 * module, so the window's handlers reach no Git module (the Git/None audit's rule).
 */
const current = new AsyncLocalStorage<AbortSignal>()

/** Runs `fn` with `signal` as its Cancel (its Git steps read it with gitRunSignal). */
export const cancellableGit = <T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> => current.run(signal, fn)

/** The Cancel of the user's git run in progress here, if any. */
export const gitRunSignal = (): AbortSignal | undefined => current.getStore()

const sameOwner = (a: CancelOwner, b: CancelOwner): boolean => a.sender === b.sender && a.ws === b.ws && a.project.toLowerCase() === b.project.toLowerCase()

/**
 * Runs `run` under `op` (the window's id), cancellable by its owner with cancelGitRun. No id: run as before, with no
 * Cancel. An id that is running already: refused, nothing started.
 */
export async function withGitCancel<T>(op: unknown, owner: CancelOwner, run: (signal: AbortSignal | undefined) => Promise<T>): Promise<T> {
  if (typeof op !== 'string' || !op) return run(undefined)
  if (runs.has(op)) throw combworkError(M.taken, undefined, { kind: 'conflict' })
  const ctl = new AbortController()
  runs.set(op, { owner, ctl })
  try {
    return await run(ctl.signal)
  } finally {
    if (runs.get(op)?.ctl === ctl) runs.delete(op)
  }
}

/** The owner's Cancel of the run `op`: anyone else's, or an id not running, changes nothing. */
export function cancelGitRun(op: unknown, caller: CancelOwner): void {
  if (typeof op !== 'string') return
  const r = runs.get(op)
  if (r && sameOwner(r.owner, caller)) r.ctl.abort()
}

/** A window closed (its webContents id), or a workspace's open ended: its runs off the list, running on to their end. */
export function dropGitRuns(gone: { sender?: number; ws?: WorkspaceService }): void {
  for (const [op, r] of runs) if ((gone.sender !== undefined && r.owner.sender === gone.sender) || (gone.ws !== undefined && r.owner.ws === gone.ws)) runs.delete(op)
}

/** Tests: the runs registered now. */
export const gitRunsNow = (): number => runs.size
