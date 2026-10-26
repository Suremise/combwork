// Where a window is in opening its workspace (HI-1694): a 0.9 workspace took 88 s to open with nothing on screen saying
// what it was doing, and the window let the user open another meanwhile. Each step is sent to the window, which shows it
// as a steady view; while one is under way, the window opens, makes or closes no other workspace.

import { basename } from 'path'
import type { OpenProgress } from '../shared/types'
import { msg } from '../shared/i18n'
import { emitTo } from './events'
import { hiveError } from './hiveError'
import { createLogger, userText } from './logger'
import type { WorkspaceService } from './workspace'

const log = createLogger('workspace')

const M = {
  busy: msg({ id: 'service.workspace.stillOpening', defaultMessage: '{name} is still opening: wait for it to finish, then try again.', description: "An error opening, making or closing a workspace while this window is still opening its workspace {name} (bringing its skills up to date, or upgrading it to Hive 1.0)." })
}

/** Each window's open under way, by its workspace service. */
const under = new Map<WorkspaceService, OpenProgress & { since: number; at: number }>()

/** The window's open now, or null. */
export function openProgress(ws: WorkspaceService): OpenProgress | null {
  const p = under.get(ws)
  if (!p) return null
  const { since: _since, at: _at, ...progress } = p
  return progress
}

/** The window begins opening `path` (its name shown as the folder's), at `step`: told to its window. */
export function openStart(ws: WorkspaceService, path: string, step: OpenProgress['step']): void {
  under.delete(ws)
  const now = performance.now()
  under.set(ws, { path, name: basename(path), step, since: now, at: now })
  tell(ws)
}

/**
 * The window's open under way is at `step` now, with counts where known: told to its window, and logged with how long
 * the step before took. Nothing when no open is under way (a workspace opened another way: a test, a start).
 */
export function openStep(ws: WorkspaceService, step: OpenProgress['step'], counts: { done?: number; total?: number } = {}): void {
  const was = under.get(ws)
  if (!was) return
  const now = performance.now()
  if (was.step !== step) log.info(`opening ${userText(basename(was.path))}: ${was.step} took ${Math.round(now - was.at)} ms`)
  under.set(ws, { path: was.path, name: was.name, step, ...counts, since: was.since, at: was.step === step ? was.at : now })
  tell(ws)
}

function tell(ws: WorkspaceService): void {
  if (ws.window && !ws.window.isDestroyed()) emitTo(ws.window, { type: 'workspace-progress', progress: openProgress(ws) })
}

/** The window's open is done (or failed): its view goes, and how long it took is logged. */
export function openDone(ws: WorkspaceService): void {
  const p = under.get(ws)
  if (!p) return
  under.delete(ws)
  const now = performance.now()
  log.info(`opening ${userText(basename(p.path))}: ${p.step} took ${Math.round(now - p.at)} ms; ${Math.round(now - p.since)} ms in all`)
  tell(ws)
}

/** Throws the user's reason when the window is still opening its workspace: for another open, a new workspace or a close. */
export function assertNotOpening(ws: WorkspaceService): void {
  const p = under.get(ws)
  if (p) throw hiveError(M.busy, { name: p.name }, { kind: 'conflict' })
}
