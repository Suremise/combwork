import { basename, dirname } from 'path'
import { CW_DIR } from '../shared/defaults'
import { placeKey } from './fsutil'

/**
 * Admission to a workspace's databases (#1395, replacing #1379's fence and #1381's list of closed workspaces): combwork.db,
 * the Assistant's journal and usage.db are kept open (a persistent open: the board, the journal, the usage worker's file)
 * only for a workspace a window holds now, admitted as the window opens it and dismissed first as it closes it. Anything
 * else is a transient open (a lease: open, use, close in `finally`, as a store's last save as its workspace closes) or
 * is refused: work still going on for a closed workspace (a read that resumes after the close, a job queued before it)
 * used to open them again, holding the folder until Combwork quit, so it couldn't be moved or deleted. Keyed on the
 * workspace, not on who asks: work of no window's request (a timer, a session's end) is refused as well. By real paths
 * (`placeKey`): a junction, a symlink or an 8.3 short name is the same workspace and the same file, however it is spelt.
 */
/**
 * The places of the workspaces windows hold now (`placeKey`, as each window recorded it as it opened: #1402). Nothing
 * about closed workspaces is kept: one entry per open window (a window holds one workspace, and none is in two windows),
 * so it is bounded by the windows open.
 */
const admitted = new Set<string>()

/** The error a refused open throws: the workspace's own (`setFenceReason`), else a plain one. */
let reasonOf = (): Error => new Error('The workspace was closed') // i18n-ignore: replaced by the workspace's message at start (setFenceReason)

/** The error a refused open throws, made when one is refused (the workspace's "The workspace was closed"). */
export function setFenceReason(make: () => Error): void {
  reasonOf = make
}

/** Refusals are told apart from other failures to open (an upgrade check must not take one for "nothing pending"). */
const REFUSED = Symbol('refused')

/** Whether `e` is an admission's refusal (refusal, assertAdmitted). */
export const isRefusal = (e: unknown): boolean => !!e && typeof e === 'object' && (e as { [REFUSED]?: boolean })[REFUSED] === true

function refused(): Error {
  const e = reasonOf()
  Object.defineProperty(e, REFUSED, { value: true })
  return e
}

/** The refusal, for a caller judging by a place it recorded (isAdmitted) rather than by a file. */
export const refusedOpen = (): Error => refused()

/** A window opens a workspace: `place` is the place it recorded (`placeKey`), its databases open as they're used. */
export function admit(place: string): void {
  admitted.add(place)
}

/** A window starts closing the workspace it opened at `place` (as recorded then): from now on they aren't kept open. */
export function dismiss(place: string): void {
  admitted.delete(place)
}

/** How many workspaces are admitted (tests, diagnostics): the windows holding one. */
export const admittedCount = (): number => admitted.size

/** Whether the workspace at `place` (a `placeKey`, as a board recorded it as it opened) is admitted. */
export const isAdmitted = (place: string): boolean => admitted.has(place)

/**
 * The workspace a database file is of: the folder holding its nearest `.combwork` (by real path; a file not made yet by its
 * nearest existing folder's real location). Only the nearest: a database in a `.combwork` of its own further down (under the
 * Assistant's home, say) is that folder's, never the workspace's above it. Null: in no `.combwork`. `real`: the file is
 * already its real location (`realPath`), not resolved again (HI-1887: each usage history request's).
 */
export function ownerOf(file: string, real = false): string | null {
  const combwork = CW_DIR.toLowerCase()
  for (let d = dirname(real ? file.toLowerCase() : placeKey(file)); ; ) {
    if (basename(d) === combwork) return dirname(d)
    const up = dirname(d)
    if (up === d) return null
    d = up
  }
}

/** Why `file` isn't kept open (its workspace isn't admitted); null when it may be. */
export function refusal(file: string): Error | null {
  const owner = ownerOf(file)
  return owner !== null && admitted.has(owner) ? null : refused()
}

/** Throws why `file` isn't kept open (refusal). */
export function assertAdmitted(file: string): void {
  const reason = refusal(file)
  if (reason) throw reason
}

/** Throws the refusal for a database already open at `place` (as it recorded it) whose workspace isn't admitted now. */
export function assertPlaceAdmitted(place: string): void {
  if (!admitted.has(place)) throw refused()
}
