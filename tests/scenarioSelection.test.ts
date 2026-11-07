// Which scenarios each fake provider runs (HI-2662, tests/scenarios/delivery.cjs): the common set, every scenario, on the
// fake Claude Code; the delivery contracts on the fake Codex and the Copilot CLI. No scenario may drop out of every set,
// and one whose own code reads the provider must be a delivery contract, so a provider's own behaviour never goes
// untested there. --only names any scenario on any provider; --every runs all of them anywhere.
import { describe, expect, it } from 'vitest'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
type Scenario = { id: string; [k: string]: unknown }
const { SCENARIOS } = require('./scenarios/scenarios.cjs') as { SCENARIOS: Scenario[] }
const { DELIVERY, DELIVERY_PROVIDERS, scenarioSet } = require('./scenarios/delivery.cjs') as {
  DELIVERY: Record<string, string>
  DELIVERY_PROVIDERS: string[]
  scenarioSet: (s: Scenario[], provider: string, o?: { only?: string[]; every?: boolean }) => Scenario[]
}
const ids = (list: Scenario[]) => list.map((s) => s.id)
/** A scenario's own code, as the selection guard reads it. */
const code = (s: Scenario) => ['setup', 'prompt', 'fake', 'expect', 'observe', 'fakeSkips'].map((k) => (typeof s[k] === 'function' ? String(s[k]) : JSON.stringify(s[k] ?? ''))).join('\n')

describe('the scenario sets by provider (HI-2662)', () => {
  it('names only scenarios that exist, each with what of the delivery it exercises, sorted', () => {
    const all = new Set(ids(SCENARIOS))
    for (const [id, why] of Object.entries(DELIVERY)) {
      expect(all.has(id), id).toBe(true)
      expect(why.trim().length, id).toBeGreaterThan(10)
    }
    expect(Object.keys(DELIVERY)).toEqual(Object.keys(DELIVERY).slice().sort())
    expect(DELIVERY_PROVIDERS).toEqual(['fake-codex', 'fake-copilot'])
  })

  it('runs every scenario on the fake Claude Code, so none drops out of every set', () => {
    expect(ids(scenarioSet(SCENARIOS, 'fake'))).toEqual(ids(SCENARIOS))
    const union = new Set([...ids(scenarioSet(SCENARIOS, 'fake')), ...DELIVERY_PROVIDERS.flatMap((p) => ids(scenarioSet(SCENARIOS, p)))])
    expect(union.size).toBe(SCENARIOS.length)
  })

  it('runs the delivery contracts on the fake Codex and the Copilot CLI, in the set’s order', () => {
    for (const p of DELIVERY_PROVIDERS) expect(ids(scenarioSet(SCENARIOS, p))).toEqual(ids(SCENARIOS).filter((id) => id in DELIVERY))
  })

  it('keeps every scenario whose own code reads the provider among the delivery contracts', () => {
    const reads = SCENARIOS.filter((s) => /\bprovider\b/.test(code(s))).map((s) => s.id)
    expect(reads.length).toBeGreaterThan(0)
    expect(reads.filter((id) => !(id in DELIVERY))).toEqual([])
  })

  it('--every runs all of them anywhere; --only names any scenario on any provider; model trials pick their own', () => {
    for (const p of DELIVERY_PROVIDERS) expect(scenarioSet(SCENARIOS, p, { every: true })).toHaveLength(SCENARIOS.length)
    const common = ids(SCENARIOS).find((id) => !(id in DELIVERY))!
    for (const p of [...DELIVERY_PROVIDERS, 'fake', 'claude-code', 'codex']) expect(ids(scenarioSet(SCENARIOS, p, { only: [common, 'work-on-card'] }))).toEqual(ids(SCENARIOS).filter((id) => id === common || id === 'work-on-card'))
    // The real CLIs as before: the whole set unless --only or --random narrows it.
    for (const p of ['claude-code', 'codex']) expect(scenarioSet(SCENARIOS, p)).toHaveLength(SCENARIOS.length)
  })
})
