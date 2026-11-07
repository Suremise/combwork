// What a CLI's status line says that no hook tells (HI-2545: agy's permission prompt and its cancel), derived in one place
// (statusLineState.ts's applyStatus) from the valid reports in hook order: the prompt showing and the idle period are the
// last report's alone, whatever came before; the ask is raised once as a prompt begins and answered once as it goes; the
// grace starts as an idle period begins (or when none runs for it) and is cancelled as it ends. The prompt is compared with
// whether the agent waits now, whoever ended the wait last (a tool's end, its Stop, a report).
import { describe, expect, it } from 'vitest'
import { NO_STATUS, applyStatus, idleNow, type StatusAction, type StatusReport, type StatusState } from '../src/main/statusLineState'

const A = { turn: 'c:i1', session: 'c' }
const B = { turn: 'c:i7', session: 'c' }
const report = (o: Partial<StatusReport>): StatusReport => ({ ask: false, idle: false, scope: A, ...o })

/** Applies reports in order, a grace running from its start to its cancel; the actions and the end. */
function run(reports: (StatusReport | 'toolEnd')[]): { state: StatusState; actions: StatusAction[]; grace: boolean; waiting: boolean } {
  let state = NO_STATUS
  let grace = false
  // As the hooks leave the agent: waiting from an ask until it is answered, or a tool's end answers it.
  let waiting = false
  const actions: StatusAction[] = []
  let scope: StatusReport['scope'] | null = null
  for (const r of reports) {
    if (r === 'toolEnd') {
      waiting = false
      continue
    }
    // Another turn began (its prompt hook): no one is waited for any more, as the hooks would leave it.
    if (scope && (scope.turn !== r.scope.turn || scope.session !== r.scope.session)) waiting = false
    scope = r.scope
    const out = applyStatus(state, r, grace, waiting)
    state = out.next
    for (const a of out.actions) {
      actions.push(a)
      if (a === 'startGrace') grace = true
      if (a === 'cancelGrace') grace = false
      if (a === 'ask') waiting = true
      if (a === 'answer') waiting = false
    }
  }
  return { state, actions, grace, waiting }
}

describe("the status line's state, derived from its reports (HI-2545)", () => {
  it('a prompt asks once as it begins and is answered once as it goes', () => {
    expect(run([report({ ask: true }), report({ ask: true }), report({})]).actions.filter((a) => a === 'ask' || a === 'answer')).toEqual(['ask', 'answer'])
    expect(run([report({}), report({})]).actions.filter((a) => a === 'ask' || a === 'answer')).toEqual([])
  })

  it("an earlier turn's prompt is none for the next: its own prompt asks", () => {
    const r = run([report({ ask: true, scope: A }), report({ ask: true, scope: B })])
    expect(r.actions.filter((a) => a === 'ask')).toEqual(['ask', 'ask'])
    expect(r.waiting).toBe(true)
  })

  it('an idle period starts one grace; leaving it cancels it; a new one starts another', () => {
    const r = run([report({ idle: true }), report({ idle: true }), report({}), report({ idle: true })])
    expect(r.actions.filter((a) => a === 'startGrace' || a === 'cancelGrace')).toEqual(['startGrace', 'cancelGrace', 'startGrace'])
    expect(r.grace).toBe(true)
  })

  it('a grace a hook ended while still idle is started again by the next idle report', () => {
    const first = applyStatus(NO_STATUS, report({ idle: true }), false, false)
    expect(applyStatus(first.next, report({ idle: true }), false, false).actions).toEqual(['startGrace'])
  })

  it('a prompt a tool hook answered (the agent working again) is asked again by the next pending report; the same prompt reported again asks once', () => {
    expect(run([report({ ask: true }), 'toolEnd', report({ ask: true })]).waiting).toBe(true)
    expect(run([report({ ask: true }), 'toolEnd', report({ ask: true })]).actions.filter((a) => a === 'ask')).toEqual(['ask', 'ask'])
    expect(run([report({ ask: true }), report({ ask: true }), report({ ask: true })]).actions.filter((a) => a === 'ask')).toEqual(['ask'])
  })

  it('every sequence of reports and tool ends, prompt and idle mixed, ends as its last report says', () => {
    const kinds: (Partial<StatusReport> | 'toolEnd')[] = [{}, { ask: true }, { idle: true }, { ask: true, scope: B }, { idle: true, scope: B }, { scope: B }, 'toolEnd']
    // Every sequence of up to 4 inputs ending with a report.
    const seqs: (Partial<StatusReport> | 'toolEnd')[][] = [[]]
    for (let n = 0; n < 4; n++) for (const s of [...seqs]) if (s.length === n) for (const k of kinds) seqs.push([...s, k])
    for (const s of seqs.filter((x) => x.length && x.at(-1) !== 'toolEnd')) {
      const inputs = s.map((k) => (k === 'toolEnd' ? k : report(k)))
      const last = inputs.at(-1) as StatusReport
      const r = run(inputs)
      const why = JSON.stringify(s)
      expect(r.state, why).toEqual({ idle: last.idle ? last.scope : null })
      // Whether the agent waits is the last report's, whatever tool ends came before it.
      expect(r.waiting, why).toBe(last.ask)
      expect(idleNow(r.state, last.scope), why).toBe(last.idle)
      expect(r.grace, why).toBe(last.idle)
      // Asks and answers alternate, never two of one in a row.
      const edges = r.actions.filter((a) => a === 'answer' || a === 'ask')
      for (let i = 1; i < edges.length; i++) if (edges[i] === 'answer') expect(edges[i - 1], why).toBe('ask')
    }
  })
})
