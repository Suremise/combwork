// Which scenarios each fake provider runs (HI-2662, tests/scenarios/delivery.cjs): the common set, every scenario, on the
// fake Claude Code; the delivery contracts on the fake Codex and the Copilot CLI. No scenario may drop out of every set,
// and one whose own definition depends on the provider must be a delivery contract, so a provider's own behaviour never goes
// untested there. --only names any scenario on any provider; --every runs all of them anywhere.
import { describe, expect, it } from 'vitest'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
type Scenario = { id: string; [k: string]: unknown }
const { SCENARIOS } = require('./scenarios/scenarios.cjs') as { SCENARIOS: Scenario[] }
const { DELIVERY, DELIVERY_PROVIDERS, providerSensitive, scenarioSet } = require('./scenarios/delivery.cjs') as {
  DELIVERY: Record<string, string>
  DELIVERY_PROVIDERS: string[]
  providerSensitive: (s: Scenario) => boolean
  scenarioSet: (s: Scenario[], provider: string, o?: { only?: string[]; every?: boolean }) => Scenario[]
}
const ids = (list: Scenario[]) => list.map((s) => s.id)

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

  it('keeps every scenario whose own definition depends on the provider among the delivery contracts', () => {
    const sensitive = SCENARIOS.filter(providerSensitive).map((s) => s.id)
    expect(sensitive.length).toBeGreaterThan(5)
    expect(sensitive.filter((id) => !(id in DELIVERY))).toEqual([])
    // HR3's round 1: skips by provider under another parameter name, and the wakes and timings each CLI meets its own way.
    for (const id of ['coordinator-lanes-to-end', 'review-decision-next-round', 'skill-changed', 'inbox-act-then-ack']) expect(sensitive, id).toContain(id)
    // The agent watch's wake isn't seen lexically: listed by hand, for what it delivers.
    expect(DELIVERY['assistant-agent-watch']).toMatch(/agent watch/)
  })

  it('reads a definition as provider-dependent whatever its callback calls the provider', () => {
    expect(providerSensitive({ id: 'x', fakeSkips: (p: string) => (p === 'fake' ? [] : ['a check']) })).toBe(true)
    expect(providerSensitive({ id: 'x', fakeSkips: ['a check'] })).toBe(false)
    for (const k of ['fakeWakes', 'beforeLaunch', 'beforePrompt', 'during']) expect(providerSensitive({ id: 'x', [k]: () => null }), k).toBe(k !== 'during')
    expect(providerSensitive({ id: 'x', expect: (_o: unknown, c: { provider: string }) => c.provider === 'codex' })).toBe(true)
    expect(providerSensitive({ id: 'x', during: () => 'the providers page' })).toBe(false)
    expect(providerSensitive({ id: 'x', expect: () => [] })).toBe(false)
  })

  it('--every runs all of them anywhere; --only names any scenario on any provider; model trials pick their own', () => {
    for (const p of DELIVERY_PROVIDERS) expect(scenarioSet(SCENARIOS, p, { every: true })).toHaveLength(SCENARIOS.length)
    const common = ids(SCENARIOS).find((id) => !(id in DELIVERY))!
    for (const p of [...DELIVERY_PROVIDERS, 'fake', 'claude-code', 'codex']) expect(ids(scenarioSet(SCENARIOS, p, { only: [common, 'work-on-card'] }))).toEqual(ids(SCENARIOS).filter((id) => id === common || id === 'work-on-card'))
    // The real CLIs as before: the whole set unless --only or --random narrows it.
    for (const p of ['claude-code', 'codex']) expect(scenarioSet(SCENARIOS, p)).toHaveLength(SCENARIOS.length)
  })
})
