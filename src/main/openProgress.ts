// Where a window is in opening its workspace (HI-1694): a 0.9 workspace took 88 s to open with nothing on screen saying
// what it was doing, and the window let the user open another meanwhile. A window's open, close or upgrade claims the
// window (one at a time: another is refused, saying why), each step is sent to the window, which shows it as a steady
// view, and only the operation holding the claim moves its steps on or lets it go.

import { basename } from 'path'
import type { OpenProgress } from '../shared/types'
import { msg } from '../shared/i18n'
import { emitTo } from './events'
import { hiveError } from './hiveError'
import { createLogger, userText } from './logger'
import type { WorkspaceService } from './workspace'

const log = createLogger('workspace')

const M = {
  busy: msg({ id: 'service.workspace.stillOpening', defaultMessage: '{name} is still opening: wait for it to finish, then try again.', description: "An error opening, making or closing a workspace while this window is still opening its workspace {name} (bringing its skills up to date, or upgrading it to Hive 1.0)." }),
  closing: msg({ id: 'service.workspace.stillClosing', defaultMessage: '{name} is still closing: wait for it to finish, then try again.', description: 'An error opening, making or closing a workspace while this window is still closing its workspace {name}.' })
}

/** What holds a window: its token, the workspace it is about, and its step when shown (a close shows none). */
interface Claim {
  token: symbol
  path: string
  name: string
  step: OpenProgress['step'] | null
  /** When it began, and when its step did (performance.now()). */
  since: number
  at: number
}

/** Each window's claim, by its workspace service. */
const claims = new Map<WorkspaceService, Claim>()

/** The window's open now, as the window shows it, or null. */
export function openProgress(ws: WorkspaceService): OpenProgress | null {
  const c = claims.get(ws)
  if (!c?.step) return null
  return { path: c.path, name: c.name, step: c.step }
}

/**
 * Claims the window for an operation on `path` (an open at `step`, or a close with none shown), checked and taken at once
 * where the operation begins to change the window: after its folder picker or the agents' stop, which a second request
 * may outlast (HR2's round 1 finding). Throws the user's reason while another holds it. Returns the claim's token.
 */
export function claimWindow(ws: WorkspaceService, path: string, step: OpenProgress['step'] | null): symbol {
  assertNotOpening(ws)
  const now = performance.now()
  const token = Symbol('claim')
  claims.set(ws, { token, path, name: basename(path), step, since: now, at: now })
  // The window's request, as main takes it (HI-1694: the log said nothing until "Opened workspace").
  log.info(`${step ? 'opening' : 'closing'} ${userText(basename(path))}: asked by the window`)
  if (step) tell(ws)
  return token
}

/** The token of the window's claim now, or null: for what carries an operation on after its call returns (an upgrade's adoption). */
export function windowClaim(ws: WorkspaceService): symbol | null {
  return claims.get(ws)?.token ?? null
}

/**
 * The window's open is at `step` now: told to its window, and logged with how long the step before took. Only for the
 * claim `token` names (or, without one, an open of `path`): a workspace opened another way (a test, a start) or an
 * operation since replaced changes nothing.
 */
export function openStep(ws: WorkspaceService, step: OpenProgress['step'], of: { token?: symbol | null; path?: string | null } = {}): void {
  const c = claims.get(ws)
  if (!c?.step || (of.token !== undefined && c.token !== of.token) || (of.path !== undefined && c.path !== of.path)) return
  const now = performance.now()
  if (c.step !== step) log.info(`opening ${userText(c.name)}: ${c.step} took ${Math.round(now - c.at)} ms`)
  claims.set(ws, { ...c, step, at: c.step === step ? c.at : now })
  tell(ws)
}

function tell(ws: WorkspaceService): void {
  if (ws.window && !ws.window.isDestroyed()) emitTo(ws.window, { type: 'workspace-progress', progress: openProgress(ws) })
}

/** Lets the window go, when `token` still holds it (a claim taken since stays): its view goes, and how long it took is logged. */
export function releaseWindow(ws: WorkspaceService, token: symbol | null): void {
  const c = claims.get(ws)
  if (!c || !token || c.token !== token) return
  claims.delete(ws)
  if (!c.step) return
  const now = performance.now()
  log.info(`opening ${userText(c.name)}: ${c.step} took ${Math.round(now - c.at)} ms; ${Math.round(now - c.since)} ms in all`)
  tell(ws)
}

/**
 * What an open starts in the background once the window has the workspace (HI-1705: the log said nothing of it), each
 * part timed from when it began, said in one line once all have ended: `track` each, then `seal` when none is to come.
 */
export class AfterOpen {
  private readonly parts: string[] = []
  private readonly started = performance.now()
  private pending = 0
  private sealed = false
  private said = false

  constructor(private readonly name: string) {}

  /**
   * Times `p` as `what` (it fails or not: its time either way), and gives it back. `since`: when its work began, where
   * that is later than now (work that waits for something first); 0, none ran.
   */
  track<T>(what: string, p: Promise<T>, since?: () => number): Promise<T> {
    const now = performance.now()
    const from = since ?? (() => now)
    this.pending++
    void p.then(
      () => this.ended(what, from()),
      () => this.ended(what, from())
    )
    return p
  }

  /** Nothing more is tracked: the line is said once what was has ended. */
  seal(): void {
    this.sealed = true
    this.sayWhenDone()
  }

  private ended(what: string, from: number): void {
    if (from) this.parts.push(`${what} ${Math.round(performance.now() - from)} ms`)
    this.pending--
    this.sayWhenDone()
  }

  private sayWhenDone(): void {
    if (!this.sealed || this.pending || this.said) return
    this.said = true
    if (this.parts.length) log.info(`after opening ${userText(this.name)}: ${this.parts.join(', ')}; ${Math.round(performance.now() - this.started)} ms in all`)
  }
}

/** Throws the user's reason while the window is claimed: for another open, a new workspace or a close (asked early, and again at the claim). */
export function assertNotOpening(ws: WorkspaceService): void {
  const c = claims.get(ws)
  if (c) throw hiveError(c.step ? M.busy : M.closing, { name: c.name }, { kind: 'conflict' })
}
