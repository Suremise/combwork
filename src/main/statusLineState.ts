// What a CLI's status line says of a running turn that no hook tells (HI-2545, the Antigravity CLI: its permission prompt,
// and a turn ended with no hook when that prompt is cancelled), derived in one place from the reports applied in the
// launch's hook order: never tracked as a report arrives, so reports applied in any arrival order end as the last valid
// one says (the Assistant's notes on HI-2545, after HR1's and HR2's rounds).

/** The turn and session a report is about: those running as it arrived. */
export type StatusScope = { turn: string; session: string }

/** What the status line last said, as applied: the idle period, for the scope it was about. */
export interface StatusState {
  /** The scope the status line says is idle (no prompt pending), or null. */
  idle: StatusScope | null
}

export const NO_STATUS: StatusState = { idle: null }

/** One report, as applied: whether a prompt is pending, whether idle, and the scope it is about. */
export interface StatusReport {
  ask: boolean
  idle: boolean
  scope: StatusScope
}

/**
 * What applying a report does besides the state: raise the one blocking ask (a prompt the agent isn't shown waiting for),
 * answer it (the agent is shown waiting, with no prompt pending), start the idle grace for the scope (idle, and no grace
 * runs for it), or cancel the grace (no longer idle).
 */
export type StatusAction = 'ask' | 'answer' | 'startGrace' | 'cancelGrace'

const same = (a: StatusScope | null, b: StatusScope): boolean => !!a && a.turn === b.turn && a.session === b.session

/**
 * Applies a valid report (one about the running turn and session, checked by the caller in hook order) to the state:
 * the new state, and what to do. The prompt is compared with what is so now, not with what an earlier report said
 * (HR1's round 5, the Assistant's note): `waiting`, whether the agent waits for the person as everything before left it
 * (an ask raised, then answered by a tool's end, its Stop, or a report), so a pending report asks once while it isn't
 * waiting, a repeat changes nothing, and a report with none pending answers a wait. `graceRunning`: whether a grace for
 * this scope runs now (a hook may have ended it while the status line stayed idle, so a later idle report starts it again).
 */
export function applyStatus(prev: StatusState, report: StatusReport, graceRunning: boolean, waiting: boolean): { next: StatusState; actions: StatusAction[] } {
  void prev
  const actions: StatusAction[] = []
  if (report.ask && !waiting) actions.push('ask')
  else if (!report.ask && waiting) actions.push('answer')
  if (report.idle && !graceRunning) actions.push('startGrace')
  else if (!report.idle) actions.push('cancelGrace')
  return { next: { idle: report.idle ? report.scope : null }, actions }
}

/** Whether the state says the scope is idle now (the grace's last look before it interrupts the turn). */
export const idleNow = (s: StatusState, scope: StatusScope): boolean => same(s.idle, scope)
