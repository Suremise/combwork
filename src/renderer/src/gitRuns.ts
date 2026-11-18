// HI-3372: the user's own git work from the window (a Commit or Set aside, a Fetch, Pull or Push), each run under an id of
// its own that its Cancel names. Main registers the id with this window, its workspace and the run's project before it
// starts, and ends it as its time limit would; it never cancels another window's run, or one of another project. A run
// the user cancelled says what main said (only what is true: a push may have reached the remote), as a stop, not a failure.
import { msg, tr } from '@shared/i18n'
import { call, errorMessage } from './api'
import { dismissToast, notify, pushToast } from './store'

const T = {
  cancel: msg({ id: 'gitRuns.cancel', defaultMessage: 'Cancel', description: 'HI-3372: the button that cancels a commit, set aside, fetch, pull or push while it runs (beside its button, in its dialog, or on its notification while it runs).' }),
  stopped: msg({ id: 'gitRuns.stopped', defaultMessage: 'Stopped', description: "HI-3372: a notification's title after the user cancelled a commit, set aside, fetch, pull or push: what was stopped, and what is true now, is said under it." })
}

/** The runs going now, by their id: the project each was started in (its Cancel names it), and whether it was cancelled. */
const runs = new Map<string, { project: string; cancelled: boolean }>()

/** The Cancel button's words, for the views that show one beside their busy button. */
export const cancelLabel = (): string => tr(T.cancel)

/** Cancels the run `op` (a stale id, or one already ended, does nothing). */
export function cancelGitRun(op: unknown): void {
  const r = typeof op === 'string' ? runs.get(op) : undefined
  if (!r) return
  r.cancelled = true
  void call('git:cancel', op as string, r.project).catch(() => undefined)
}

/** A run started: its id (passed to main), whether the user cancelled it, and its end (always called). */
export interface GitRunHandle {
  op: string
  cancelled: () => boolean
  end: () => void
}

/**
 * Starts a run in `project`: its id, registered here for its Cancel. `running`: while it runs, a notification with Cancel
 * (an action with no button of its own left to stand beside: one from a notification, or a dialog's step).
 */
export function startGitRun(project: string, running?: string): GitRunHandle {
  const op = crypto.randomUUID()
  runs.set(op, { project, cancelled: false })
  const shown = running ? `git-run-${op}` : null
  if (shown) pushToast({ id: shown, level: 'info', title: running!, actions: [{ label: tr(T.cancel), command: 'git.cancelRun', args: [op] }], timestamp: new Date().toISOString(), timeoutMs: 24 * 60 * 60_000 })
  return {
    op,
    cancelled: () => !!runs.get(op)?.cancelled,
    end: () => {
      runs.delete(op)
      if (shown) dismissToast(shown)
    }
  }
}

/**
 * Runs `fn` with a new run's id (it passes it to main), told to `onOp` for a Cancel beside its button. `running`: as
 * startGitRun's. Its value, or undefined when it failed or was cancelled, each told: a failure under `failTitle`, a
 * cancel as Stopped with what main said.
 */
export async function gitRun<T>(project: string, failTitle: string, fn: (op: string) => Promise<T>, opts: { running?: string; onOp?: (op: string | null) => void } = {}): Promise<T | undefined> {
  const run = startGitRun(project, opts.running)
  opts.onOp?.(run.op)
  try {
    return await fn(run.op)
  } catch (e) {
    if (run.cancelled()) notify('info', tr(T.stopped), errorMessage(e))
    else notify('error', failTitle, errorMessage(e))
    return undefined
  } finally {
    run.end()
    opts.onOp?.(null)
  }
}
