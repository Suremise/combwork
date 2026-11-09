// Which fake providers run each scenario (HI-2663, tests/scenarios/fakeScope.cjs): every name a scenario, the default all
// three fakes, and a run's selection for each provider: what it runs, and what it leaves out, said with where it runs.
import { describe, expect, it } from 'vitest'
// @ts-expect-error: plain CommonJS modules without types
import { SCENARIOS } from './scenarios/scenarios.cjs'
// @ts-expect-error: plain CommonJS modules without types
import { FAKES, FAKE_CLAUDE_ONLY, MODEL_TRIALS_ONLY, NOT_A_TRIAL, fakesFor, scopeProblems, selectFor } from './scenarios/fakeScope.cjs'

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
      // Every one left out until HI-2760 gives OpenCode agents their turn status (PROVIDER_WAITS, HI-2761).
      ['fake-opencode', [], ['work-on-card', 'review-passed', 'hold-skipped', 'tool-sweep']],
      // Model trials run every scenario but the fakes' plumbing check, whatever the fakes' lists say.
      ['claude-code', ['work-on-card', 'review-passed', 'hold-skipped'], ['tool-sweep']],
      ['codex', ['work-on-card', 'review-passed', 'hold-skipped'], ['tool-sweep']]
    ])('%s runs %j and leaves out %j', (provider, runs, left) => {
      const sel = pick(provider, sample)
      expect(runIds(sel)).toEqual(runs)
      expect(sel.excluded.map((x) => x.id)).toEqual(left)
    })

    it('says why a provider whose runs wait for a card leaves every scenario out', () => {
      expect(new Set(pick('fake-opencode', ['work-on-card', 'tool-sweep']).excluded.map((x) => x.why))).toEqual(new Set([expect.stringMatching(/waits for HI-2760/)]))
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

  it('splits them as the ownership matrix does (HI-2663): 87 on the fake Claude Code, 16 model trials only, the rest on every fake', () => {
    expect(FAKE_CLAUDE_ONLY).toHaveLength(87)
    expect(MODEL_TRIALS_ONLY).toHaveLength(16)
    expect(NOT_A_TRIAL).toEqual(['tool-sweep'])
    expect(ids.filter((id: string) => fakesFor(id).length === FAKES.length)).toHaveLength(ids.length - 87 - 16)
  })
})
