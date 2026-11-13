/**
 * HI-2854 (HR2's round 1 finding 3): card-decision's detector of a decision given by a refused submit. Only a
 * submit.decisionsReceived refusal whose unread lines give the decision's words counts; an unrelated refusal, a list
 * without it or with other words, a call outside the window, or a submit that went on, never does.
 */
import { describe, expect, it } from 'vitest'
import { createRequire } from 'module'

const { refusedWithDecision, unreadLines } = createRequire(import.meta.url)('./scenarios/freshnessChecks.cjs')

const WORDS = 'Show each error under its own field, not in a banner at the top.'
const at = (ms: number): string => new Date(ms).toISOString()
const refusal = (lines: string[]): string => ["AL-1 has a decision or a comment from the user that you haven't seen. (submit.decisionsReceived)", 'Check your work against each (listed below, or read the card), then submit again.', ...lines].join('\n')
const call = (over: Record<string, unknown>) => ({ tool: 'cw_submit', ok: false, at: at(1500), error: refusal([`Decision (2026-11-11, recorded by You): ${WORDS}`]), ...over })

describe("card-decision's refused-submit detector (HI-2854)", () => {
  it('counts the freshness refusal that gives the decision in full, inside the window', () => {
    expect(refusedWithDecision([call({})], WORDS, 1000, 2000)).toBe(true)
  })

  it('never an unrelated refusal (identity, missing work, a running check)', () => {
    for (const error of ['AL-1: commit abc1234 is by someone@else (submit.identity)\nRecommit it as the project.', 'AL-1 has uncommitted changes. (submit.clean)', 'AL-1: runs you started are still going (typecheck). (submit.ownRunsStopped)'])
      expect(refusedWithDecision([call({ error })], WORDS, 1000, 2000)).toBe(false)
  })

  it("never a freshness refusal whose list left the decision out, or gave other (stale) words", () => {
    expect(refusedWithDecision([call({ error: refusal([]) })], WORDS, 1000, 2000)).toBe(false)
    expect(refusedWithDecision([call({ error: refusal(['Comment from the user (2026-11-11): Keep it small.']) })], WORDS, 1000, 2000)).toBe(false)
    expect(refusedWithDecision([call({ error: refusal(['Decision (2026-11-11, recorded by You): Show the errors in a banner.']) })], WORDS, 1000, 2000)).toBe(false)
    // Its words quoted inside a comment are no decision given.
    expect(refusedWithDecision([call({ error: refusal([`Comment from the user (2026-11-11): ${WORDS}`]) })], WORDS, 1000, 2000)).toBe(false)
  })

  it('never outside the window, a submit that went on, or another tool', () => {
    expect(refusedWithDecision([call({ at: at(900) })], WORDS, 1000, 2000)).toBe(false)
    expect(refusedWithDecision([call({ at: at(2100) })], WORDS, 1000, 2000)).toBe(false)
    expect(refusedWithDecision([call({ ok: true })], WORDS, 1000, 2000)).toBe(false)
    expect(refusedWithDecision([call({ tool: 'cw_update_task' })], WORDS, 1000, 2000)).toBe(false)
    expect(refusedWithDecision(undefined, WORDS, 1000, 2000)).toBe(false)
  })

  it('reads only the unread lines', () => {
    expect(unreadLines(refusal(['Decision (d, recorded by You): x', 'Comment from the user (d): y']))).toEqual(['Decision (d, recorded by You): x', 'Comment from the user (d): y'])
  })
})
