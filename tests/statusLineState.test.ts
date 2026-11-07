// What a CLI's status line says that no hook tells (HI-2545: agy's permission prompt and its cancel), derived in one place
// (statusLineState.ts's applyStatus) from the valid reports in hook order: the prompt showing and the idle period are the
// last report's alone, whatever came before; the ask is raised once as a prompt begins and answered once as it goes; the
// grace starts as an idle period begins (or when none runs for it) and is cancelled as it ends.
import { describe, expect, it } from 'vitest'
import { NO_STATUS, applyStatus, idleNow, type StatusAction, type StatusReport, type StatusState } from '../src/main/statusLineState'

const A = { turn: 'c:i1', session: 'c' }
const B = { turn: 'c:i7', session: 'c' }
const report = (o: Partial<StatusReport>): StatusReport => ({ ask: false, idle: false, scope: A, ...o })

/** Applies reports in order, a grace running from its start to its cancel; the actions and the end. */
function run(reports: StatusReport[]): { state: StatusState; actions: StatusAction[]; grace: boolean } {
  let state = NO_STATUS
  let grace = false
  const actions: StatusAction[] = []
  for (const r of reports) {
    const out = applyStatus(state, r, grace)
    state = out.next
    for (const a of out.actions) {
      actions.push(a)
      if (a === 'startGrace') grace = true
      if (a === 'cancelGrace') grace = false
    }
  }
  return { state, actions, grace }
}

describe("the status line's state, derived from its reports (HI-2545)", () => {
  it('a prompt asks once as it begins and is answered once as it goes', () => {
    expect(run([report({ ask: true }), report({ ask: true }), report({})]).actions.filter((a) => a === 'ask' || a === 'answer')).toEqual(['ask', 'answer'])
    expect(run([report({}), report({})]).actions.filter((a) => a === 'ask' || a === 'answer')).toEqual([])
  })

  it("an earlier turn's prompt is none for the next: its own prompt asks", () => {
    const r = run([report({ ask: true, scope: A }), report({ ask: true, scope: B })])
    expect(r.actions.filter((a) => a === 'ask')).toEqual(['ask', 'ask'])
    expect(r.state.asked).toEqual(B)
  })

  it('an idle period starts one grace; leaving it cancels it; a new one starts another', () => {
    const r = run([report({ idle: true }), report({ idle: true }), report({}), report({ idle: true })])
    expect(r.actions.filter((a) => a === 'startGrace' || a === 'cancelGrace')).toEqual(['startGrace', 'cancelGrace', 'startGrace'])
    expect(r.grace).toBe(true)
  })

  it('a grace a hook ended while still idle is started again by the next idle report', () => {
    const first = applyStatus(NO_STATUS, report({ idle: true }), false)
    expect(applyStatus(first.next, report({ idle: true }), false).actions).toEqual(['startGrace'])
  })

  it('every sequence of reports, prompt and idle mixed, ends as its last report says', () => {
    const kinds: Partial<StatusReport>[] = [{}, { ask: true }, { idle: true }, { ask: true, scope: B }, { idle: true, scope: B }, { scope: B }]
    // Every sequence of up to 4 reports.
    const seqs: Partial<StatusReport>[][] = [[]]
    for (let n = 0; n < 4; n++) for (const s of [...seqs]) if (s.length === n) for (const k of kinds) seqs.push([...s, k])
    for (const s of seqs.filter((x) => x.length)) {
      const reports = s.map(report)
      const last = reports.at(-1)!
      const r = run(reports)
      const why = JSON.stringify(s)
      expect(r.state, why).toEqual({ asked: last.ask ? last.scope : null, idle: last.idle ? last.scope : null })
      expect(idleNow(r.state, last.scope), why).toBe(last.idle)
      expect(r.grace, why).toBe(last.idle)
      // Asks and answers alternate, never two of one in a row.
      const edges = r.actions.filter((a) => a === 'answer' || a === 'ask')
      for (let i = 1; i < edges.length; i++) if (edges[i] === 'answer') expect(edges[i - 1], why).toBe('ask')
    }
  })
})
