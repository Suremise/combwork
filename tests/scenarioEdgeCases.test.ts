// HI-3188 (HR3's round 2): card-loop-edge-cases-review credits the reviewer's stop-and-ask only for a question that went
// through on the reviewed card (an open Decide request it raised, or a cw_ask_assistant call on that card that worked), or
// a pass; never a refused call, nor one about another card. Checked on the scenario's own expect, with observations made
// here as the harness records them.
import { describe, expect, it } from 'vitest'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
type Check = [string, boolean, string?]
type Scenario = { id: string; expect: (o: unknown, c: unknown) => Check[] }
const { SCENARIOS } = require('./scenarios/scenarios.cjs') as { SCENARIOS: Scenario[] }
const scenario = SCENARIOS.find((s) => s.id === 'card-loop-edge-cases-review')!

const N = 7
const OTHER = 8
const c = { cards: { q: N }, agents: { coder: { id: 'r1' } } }
type Call = { tool: string; ok: boolean; args: string }
const call = (tool: string, ok: boolean, card: number | string): Call => ({ tool, ok, args: JSON.stringify({ card, text: 'Worth handling, or simplify?' }) })
/** An observation: the calls made, the card's history and For you, and its facts (an open ask raised by the reviewer). */
const observed = (calls: Call[], o: { history?: string[]; open?: boolean } = {}) => ({
  skillsRead: ['review-agent-work'],
  combworkCalls: calls,
  gitStatus: '',
  cards: { q: { number: N, key: 'AL-7', history: (o.history ?? []).map((what) => ({ what })), forYou: o.open ? [{ request: 'AL-7/r20' }] : [] } },
  allCards: [{ number: OTHER, key: 'AL-8' }],
  facts: { q: o.open ? [{ kind: 'ApprovalRequested', actor: 'agent:r1', data: { kind: 'decide', request: 'AL-7/r20' } }] : [] }
})
const asked = (o: unknown): boolean => scenario.expect(o, c).find(([name]) => name.startsWith('asked whether'))![1]
const noThird = (o: unknown): boolean => scenario.expect(o, c).find(([name]) => name.startsWith("didn't fail it"))![1]

describe('card-loop-edge-cases-review credits only a question that went through (HI-3188)', () => {
  it('a refused cw_ask_user, with no open request, asks nothing (the false positive HR3 found)', () => {
    expect(asked(observed([call('cw_ask_user', false, `#${N}`)]))).toBe(false)
  })

  it('a refused cw_ask_assistant, or one about another card, asks nothing', () => {
    expect(asked(observed([call('cw_ask_assistant', false, `#${N}`)]))).toBe(false)
    expect(asked(observed([call('cw_ask_assistant', true, 'AL-8')]))).toBe(false)
    expect(asked(observed([call('cw_ask_user', true, `#${OTHER}`)]))).toBe(false)
  })

  it('an accepted question on the card counts: an open Decide request it raised, or a worked cw_ask_assistant on it; so does a pass', () => {
    expect(asked(observed([call('cw_ask_user', true, `#${N}`)], { open: true }))).toBe(true)
    expect(asked(observed([call('cw_ask_assistant', true, 'AL-7')]))).toBe(true)
    expect(asked(observed([], { history: ['Review passed'] }))).toBe(true)
  })

  it('any failed verdict this round is the third (its earlier two are comments)', () => {
    expect(noThird(observed([], { history: ['Review failed'] }))).toBe(false)
    expect(noThird(observed([call('cw_ask_user', true, `#${N}`)], { open: true }))).toBe(true)
  })
})
