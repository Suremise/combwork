// What a CLI's status line says of a running turn that no hook tells (HI-2545, the Antigravity CLI: its permission prompt,
// and a turn ended with no hook when that prompt is cancelled), derived in one place from the reports applied in the
// launch's hook order: never tracked as a report arrives, so reports applied in any arrival order end as the last valid
// one says (the Assistant's note on HI-2545, after HR1's and HR2's rounds).

/** The turn and session a report is about: those running as it arrived (null: no turn ran). */
export type StatusScope = { turn: string; session: string }

/** What the status line last said, as applied: the prompt showing and the idle period, each for the scope it was about. */
export interface StatusState {
  /** The scope whose permission prompt is showing, or null. */
  asked: StatusScope | null
  /** The scope the status line says is idle (no prompt pending), or null. */
  idle: StatusScope | null
}

export const NO_STATUS: StatusState = { asked: null, idle: null }

/** One report, as applied: whether a prompt is pending, whether idle, and the scope it is about. */
export interface StatusReport {
  ask: boolean
  idle: boolean
  scope: StatusScope
}

/**
 * What applying a report does besides the state: raise the one blocking ask (a prompt begins), answer it (the prompt is
 * gone), start the idle grace for the scope (idle begins, or no grace runs for it), or cancel the grace (no longer idle).
 */
export type StatusAction = 'ask' | 'answer' | 'startGrace' | 'cancelGrace'

const same = (a: StatusScope | null, b: StatusScope): boolean => !!a && a.turn === b.turn && a.session === b.session

/**
 * Applies a valid report (one about the running turn and session, checked by the caller in hook order) to the state:
 * the new state, and what to do. Everything is the report's own: a prompt pending or not, idle or not, for its scope; a
 * state of an earlier scope counts as none. `graceRunning`: whether a grace for this scope runs now (a hook may have
 * ended it while the status line stayed idle, so a later idle report starts it again).
 */
export function applyStatus(prev: StatusState, report: StatusReport, graceRunning: boolean): { next: StatusState; actions: StatusAction[] } {
  const actions: StatusAction[] = []
  const wasAsked = same(prev.asked, report.scope)
  if (report.ask && !wasAsked) actions.push('ask')
  else if (!report.ask && wasAsked) actions.push('answer')
  if (report.idle && !graceRunning) actions.push('startGrace')
  else if (!report.idle) actions.push('cancelGrace')
  return { next: { asked: report.ask ? report.scope : null, idle: report.idle ? report.scope : null }, actions }
}

/** Whether the state says the scope is idle now (the grace's last look before it interrupts the turn). */
export const idleNow = (s: StatusState, scope: StatusScope): boolean => same(s.idle, scope)
