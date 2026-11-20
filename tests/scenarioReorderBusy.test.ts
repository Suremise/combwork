// HI-3361 (HR2's round 1): assistant-reorder-busy credits asking Coder only for a message that went to this fixture's Coder
// and asks it to end its turn, never one telling it to keep working; and asking the user only when the reply offers both
// ways. Checked on the scenario's own expect, with observations as the harness records them.
import { describe, expect, it } from 'vitest'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
type Check = [string, boolean, string?]
type Scenario = { id: string; expect: (o: unknown, c: unknown) => Check[] }
const { SCENARIOS, helpers } = require('./scenarios/scenarios.cjs') as { SCENARIOS: Scenario[]; helpers: { asksToEndTurn: (t: unknown) => boolean } }
const scenario = SCENARIOS.find((s) => s.id === 'assistant-reorder-busy')!

const c = { cards: { a: 1, b: 2 }, agents: { coder: { id: 'a-coder' } }, coderStatuses: ['working'] }
type Call = { tool: string; ok: boolean; args: string; error?: string }
const refused: Call = { tool: 'cw_lane', ok: false, args: JSON.stringify({ action: 'start', project: 'alpha', builder: 'Coder', cards: ['AL-2', 'AL-1'], applyNow: true }), error: 'Coder is working: a reorder applied now never puts its card back under it.' }
const message = (args: object, ok = true): Call => ({ tool: 'cw_message_agent', ok, args: JSON.stringify({ project: 'alpha', ...args }) })
const observed = (calls: Call[], finalReply = '') => ({ combworkCalls: [refused, ...calls], finalReply, cards: { a: { column: 'doing' } }, skillsRead: ['run-lanes'] })
const main = (o: unknown): boolean => scenario.expect(o, c).find(([name]) => name.startsWith('queued the new order'))![1]

describe('assistant-reorder-busy credits only a real request to end the turn (HI-3361, HR2 round 1)', () => {
  it("a message telling Coder to keep working and not end its turn, with no reply, isn't one (HR2's false positive)", () => {
    expect(main(observed([message({ agent: 'Coder', text: 'Keep working on AL-1. Do not end your turn.' })]))).toBe(false)
  })

  it("a message to this fixture's Coder asking it to end its turn is one, by its name or its id", () => {
    expect(main(observed([message({ agent: 'Coder', text: 'Please save your progress and end your turn, so AL-2 can go first.' })]))).toBe(true)
    expect(main(observed([message({ agent: 'a-coder', text: 'Wrap up your turn now.' })]))).toBe(true)
  })

  it('the same request to another agent, refused, or in another project, is not', () => {
    expect(main(observed([message({ agent: 'Coder2', text: 'End your turn.' })]))).toBe(false)
    expect(main(observed([message({ agent: 'Coder', text: 'End your turn.' }, false)]))).toBe(false)
    expect(main(observed([message({ agent: 'Coder', project: 'beta', text: 'End your turn.' })]))).toBe(false)
  })

  it('a reply asking the user, only when it names both ways; a negated turn end names none', () => {
    expect(main(observed([], "Let me know whether to stop Coder's turn so AL-2 goes first, or set the new order to take effect after AL-1."))).toBe(true)
    expect(main(observed([], "Coder doesn't need to stop its turn; the order applies after AL-1 is done."))).toBe(false)
    expect(main(observed([], "When Coder's turn on #1 ends, I'll put #2 first and #1 last."))).toBe(false)
  })

  it('the matcher on its own: a sentence asking for the turn to end, never one negating it', () => {
    expect(helpers.asksToEndTurn('Finish and end your turn.')).toBe(true)
    expect(helpers.asksToEndTurn('No need to end your turn.')).toBe(false)
    expect(helpers.asksToEndTurn('Keep working; do not stop your turn.')).toBe(false)
    expect(helpers.asksToEndTurn(undefined)).toBe(false)
  })
})
