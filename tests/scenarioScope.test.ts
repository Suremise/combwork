// Which fake providers run each scenario (HI-2663, tests/scenarios/fakeScope.cjs): every name a scenario, the default all
// three fakes, and a run's selection for each provider: what it runs, and what it leaves out, said with where it runs.
import { describe, expect, it } from 'vitest'
// @ts-expect-error: plain CommonJS modules without types
import { SCENARIOS } from './scenarios/scenarios.cjs'
// @ts-expect-error: plain CommonJS modules without types
import { FAKES, FAKE_CLAUDE_ONLY, MODEL_TRIALS_ONLY, NOT_A_TRIAL, PROVIDER_WAITS, SCENARIO_WAITS, fakesFor, scopeProblems, selectFor } from './scenarios/fakeScope.cjs'

type Scenario = { id: string }
type Selection = { run: Scenario[]; excluded: { id: string; why: string }[] }
const ids = (SCENARIOS as Scenario[]).map((s) => s.id)
const pick = (provider: string, only: string[]): Selection => selectFor((SCENARIOS as Scenario[]).filter((s) => only.includes(s.id)), provider) as Selection
const runIds = (sel: Selection): string[] => sel.run.map((s) => s.id)

describe("the scenarios' fake providers", () => {
  it('names only scenarios, each once, and none that would run nowhere', () => {
    expect(scopeProblems(ids)).toEqual([])
    expect(scopeProblems([...ids, 'x'].filter((i) => i !== 'tool-sweep'))).toEqual(['tool-sweep: no such scenario'])
  })

  it('a scenario not named runs on every fake (a new one keeps every provider)', () => {
    expect(fakesFor('work-on-card')).toEqual(FAKES)
    expect(fakesFor('a-new-scenario')).toEqual(['fake', 'fake-codex', 'fake-copilot', 'fake-antigravity', 'fake-opencode'])
    expect(fakesFor(FAKE_CLAUDE_ONLY[0])).toEqual(['fake'])
    expect(fakesFor(MODEL_TRIALS_ONLY[0])).toEqual([])
  })

  it("keeps on every fake what differs per CLI: skill delivery, launches, the shell, typed lines, slots and copies, and loss of work", () => {
    for (const id of ['work-on-card', 'review-card', 'merge-main-moved', 'card-loop-lane', 'inbox-rebrief', 'slot-start', 'review-in-copy', 'merge-slot-queued', 'review-interrupted', 'assistant-settings-change', 'tool-sweep']) {
      expect(fakesFor(id), id).toEqual(FAKES)
    }
  })

  describe('a run, by provider', () => {
    const sample = ['work-on-card', 'review-passed', 'hold-skipped', 'tool-sweep']
    it.each([
      ['fake', ['work-on-card', 'review-passed', 'tool-sweep'], ['hold-skipped']],
      ['fake-codex', ['work-on-card', 'tool-sweep'], ['review-passed', 'hold-skipped']],
      ['fake-copilot', ['work-on-card', 'tool-sweep'], ['review-passed', 'hold-skipped']],
      ['fake-antigravity', ['work-on-card', 'tool-sweep'], ['review-passed', 'hold-skipped']],
      // Since HI-2760 gave OpenCode agents their turn status and HI-2762 their transcript, as every fake.
      ['fake-opencode', ['work-on-card', 'tool-sweep'], ['review-passed', 'hold-skipped']],
      // Model trials run every scenario but the fakes' plumbing check, whatever the fakes' lists say.
      ['claude-code', ['work-on-card', 'review-passed', 'hold-skipped'], ['tool-sweep']],
      ['codex', ['work-on-card', 'review-passed', 'hold-skipped'], ['tool-sweep']]
    ])('%s runs %j and leaves out %j', (provider, runs, left) => {
      const sel = pick(provider, sample)
      expect(runIds(sel)).toEqual(runs)
      expect(sel.excluded.map((x) => x.id)).toEqual(left)
    })

    it('a provider whose runs wait for a card leaves every scenario out, saying why; none waits now', () => {
      expect(PROVIDER_WAITS).toEqual({})
      PROVIDER_WAITS['fake-opencode'] = 'waits for HI-0: why'
      try {
        const sel = pick('fake-opencode', ['work-on-card', 'tool-sweep'])
        expect(sel.run).toEqual([])
        expect(new Set(sel.excluded.map((x) => x.why))).toEqual(new Set(['waits for HI-0: why']))
      } finally {
        delete PROVIDER_WAITS['fake-opencode']
      }
    })

    it("leaves out each scenario that waits for a card on that provider, saying which card; the others' runs keep it; none waits now (HI-2771 lifted the last)", () => {
      expect(SCENARIO_WAITS).toEqual({})
      const waits = SCENARIO_WAITS as Record<string, { why: string; ids: string[] }[]>
      waits['fake-opencode'] = [{ why: 'waits for HI-0: why', ids: ['assistant-journal-recall'] }]
      try {
        const sel = pick('fake-opencode', ['work-on-card', 'assistant-journal-recall', 'tool-sweep', 'slot-start'])
        expect(runIds(sel).sort()).toEqual(['slot-start', 'tool-sweep', 'work-on-card'])
        expect(Object.fromEntries(sel.excluded.map((x) => [x.id, x.why]))['assistant-journal-recall']).toBe('waits for HI-0: why')
        expect(runIds(pick('fake-codex', ['work-on-card', 'assistant-journal-recall']))).toEqual(['work-on-card', 'assistant-journal-recall'])
        // Each wait names a scenario that provider would otherwise run, once.
        expect(scopeProblems([...ids.filter((i) => i !== 'assistant-journal-recall')])).toContain("assistant-journal-recall: no such scenario (fake-opencode's waits)")
      } finally {
        delete waits['fake-opencode']
      }
    })

    it('says where each scenario it leaves out does run', () => {
      const why = Object.fromEntries(pick('fake-codex', ['review-passed', 'hold-skipped']).excluded.map((x) => [x.id, x.why]))
      expect(why['review-passed']).toMatch(/runs on fake only .*--provider fake/)
      expect(why['hold-skipped']).toMatch(/model trials only/)
      expect(pick('codex', ['tool-sweep']).excluded[0].why).toMatch(/model trials leave it out/)
    })

    it('leaves nothing to run when every one asked for is left out (the runner then exits without a result)', () => {
      expect(pick('fake-copilot', ['hold-skipped', 'review-passed']).run).toEqual([])
    })
  })

  it('splits them as the ownership matrix does (HI-2663, HI-2915, HI-2913, HI-2944): 94 on the fake Claude Code, 16 model trials only, the rest on every fake', () => {
    expect(FAKE_CLAUDE_ONLY).toHaveLength(94)
    expect(MODEL_TRIALS_ONLY).toHaveLength(16)
    expect(NOT_A_TRIAL).toEqual(['tool-sweep'])
    expect(ids.filter((id: string) => fakesFor(id).length === FAKES.length)).toHaveLength(ids.length - 94 - 16)
  })
})
