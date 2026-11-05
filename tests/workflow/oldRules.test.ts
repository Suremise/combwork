// "Old rules" (#1421, §16.5.4, §16.6.5, S19): a card in flight, or a running lane, under a ruleset that isn't its
// project's current one. Each case of its lifecycle on the card's badge (`WorkBadge.oldRules`, from its facts) and the
// lane's view (`LaneInfo.oldRules`, from its recorded ruleset), against real rulesets compiled from the presets.
import { describe, expect, it } from 'vitest'
import { compile, mustCompile } from '../../src/shared/workflow/compile'
import { allOff, preset } from '../../src/shared/workflow/options'
import type { Actor, Fact, FactData, FactKind, StartedData } from '../../src/shared/workflow/facts'
import { APPLY_OPTIONS, ownRuleset, workBadge, workView } from '../../src/shared/workflow/workView'
import { foldCard } from '../../src/shared/workflow/facts'
import { laneOldRules, laneView, type LaneRecord } from '../../src/shared/lanes'
import type { TaskCard } from '../../src/shared/types'

const pair = mustCompile(preset('git', 'pair')).id
const team = mustCompile(preset('git', 'team')).id

let seq = 0
const fact = <K extends FactKind>(kind: K, data: FactData[K], ruleset?: string, actor: Actor = 'combwork'): Fact => ({ seq: ++seq, card: 7, kind, at: `2026-10-22T10:00:${String(seq).padStart(2, '0')}.000Z`, actor, source: 'recorded', ...(ruleset ? { ruleset } : {}), data })
const start = (over: Partial<StartedData> = {}): FactData['Started'] => ({ folder: 'project', line: 'cw/b1', base: 'base0000aaaa', target: 'main', builder: 'B1', cardKind: 'code', ...over })
const moved = (from: FactData['Moved']['from'], to: FactData['Moved']['to'], ruleset?: string): Fact => fact('Moved', { from, to, cause: 'intent' }, ruleset)

/** A card started under `ruleset` and moved to Active. */
function started(ruleset: string | undefined): Fact[] {
  seq = 0
  return [fact('Started', start(), ruleset, 'agent:B1'), moved('todo', 'active', ruleset)]
}

const badge = (facts: Fact[], current: string | null | undefined, stage: 'todo' | 'active' = 'todo') => workBadge(workView({ card: 7, stage, preWorkflow: false }, facts), current)

describe("a card's old rules mark (#1421)", () => {
  it('shows from the save that changed the rules: started under Pair, the project now Team', () => {
    const facts = started(pair)
    expect(badge(facts, pair).oldRules).toBe(false)
    expect(badge(facts, team).oldRules).toBe(true)
    expect(ownRuleset(facts, foldCard(facts))).toBe(pair)
  })

  it('Apply to cards in flight gives it the new options: the mark goes', () => {
    const facts = [...started(pair), fact('Override', { rules: ['option.review'], move: APPLY_OPTIONS, by: 'user', reason: '' }, team)]
    expect(badge(facts, team).oldRules).toBe(false)
    // Another move past its rules (not Apply) doesn't change its ruleset.
    const other = [...started(pair), fact('Override', { rules: ['integrate.approved'], move: 'merge', by: 'user', reason: '' }, team)]
    expect(badge(other, team).oldRules).toBe(true)
  })

  it('a card in Todo never has it (it takes the options in force when started), nor one Done', () => {
    seq = 0
    expect(badge([], team).oldRules).toBe(false)
    const put = [...started(pair), moved('active', 'todo', pair)]
    expect(badge(put, team).oldRules).toBe(false)
    const done = [...started(pair), moved('active', 'done', pair)]
    expect(badge(done, team).oldRules).toBe(false)
  })

  it("a lane's next card started after the change keeps the lane's old ruleset, and so its mark", () => {
    // The recorder starts a lane's card under the lane's ruleset (recorder.ts): its Started names Pair.
    expect(badge(started(pair), team).oldRules).toBe(true)
  })

  it('a change of stage names never sets it: names are left out of the ruleset (#1417)', () => {
    const renamed = compile({ ...preset('git', 'pair'), stageNames: { review: 'Checking' } })
    expect(renamed.ok && renamed.ruleset.id).toBe(pair)
    expect(badge(started(pair), renamed.ok ? renamed.ruleset.id : null).oldRules).toBe(false)
  })

  it('a platform switch (#1419) sets it for the Git cards in flight', () => {
    expect(badge(started(pair), mustCompile(allOff('none')).id).oldRules).toBe(true)
  })

  it('none recorded (a start from before 1.0, or rules not read), or no current ruleset known: no mark', () => {
    expect(badge(started(undefined), team).oldRules).toBe(false)
    expect(badge(started(pair), null).oldRules).toBe(false)
    expect(badge(started(pair), undefined).oldRules).toBe(false)
  })
})

describe("a lane's old rules mark (#1421)", () => {
  const rec = (over: Partial<LaneRecord> = {}): LaneRecord => ({ id: 'l1', project: 'alpha', name: null, builder: { id: 'b1', name: 'B1' }, reviewer: { id: 'r1', name: 'R1' }, cards: [1], state: 'active', rounds: 10, waitMinutes: 360, startedBy: 'You', startedAt: '2026-10-22T10:00:00.000Z', updatedAt: '2026-10-22T10:00:00.000Z', endedAt: null, mergeCommit: null, ruleset: pair, ...over }) as LaneRecord
  const card = { number: 1, title: 'One', column: 'doing', blocked: null, history: [], comments: [], project: 'alpha' } as unknown as TaskCard

  it('a running lane started under the options before a change', () => {
    expect(laneOldRules(rec(), team)).toBe(true)
    expect(laneView(rec(), new Map([[1, card]]), undefined, null, undefined, null, undefined, team).oldRules).toBe(true)
    expect(laneView(rec(), new Map([[1, card]]), undefined, null, undefined, null, undefined, pair).oldRules).toBe(false)
  })

  it('goes when the lane ends or is abandoned', () => {
    expect(laneOldRules(rec({ state: 'ended', endedAt: '2026-10-22T11:00:00.000Z' }), team)).toBe(false)
    expect(laneOldRules(rec({ state: 'abandoned', endedAt: '2026-10-22T11:00:00.000Z' }), team)).toBe(false)
  })

  it('a lane with no recorded ruleset (from before 1.0, or started while rules weren’t enforced) has none', () => {
    expect(laneOldRules(rec({ ruleset: undefined }), team)).toBe(false)
  })

  it('a rename never sets it, a platform switch does, and no current ruleset known shows none', () => {
    const renamed = compile({ ...preset('git', 'pair'), stageNames: { approved: 'Ready' } })
    expect(laneOldRules(rec(), renamed.ok ? renamed.ruleset.id : null)).toBe(false)
    expect(laneOldRules(rec(), mustCompile(allOff('none')).id)).toBe(true)
    expect(laneOldRules(rec(), undefined)).toBe(false)
  })
})

describe("the stages old rules keep (HR4's #1421 round 1)", () => {
  const pairStages = mustCompile(preset('git', 'pair')).stages.map((s) => s.id)
  const stagesOf = (id: string) => (id === pair ? pairStages : null)

  it("a card in flight carries its own ruleset's stages, whatever the project's are now; in Todo or Done none", () => {
    expect(workBadge(workView({ card: 7, stage: 'todo', preWorkflow: false }, started(pair)), team, stagesOf).stages).toEqual(pairStages)
    expect(pairStages).toContain('merging')
    seq = 0
    expect(workBadge(workView({ card: 7, stage: 'todo', preWorkflow: false }, []), team, stagesOf).stages).toBeNull()
    expect(workBadge(workView({ card: 7, stage: 'todo', preWorkflow: false }, [...started(pair), moved('active', 'done', pair)]), team, stagesOf).stages).toBeNull()
    // Its ruleset not stored (not read): none, the project's now stand in.
    expect(workBadge(workView({ card: 7, stage: 'todo', preWorkflow: false }, started(team)), team, stagesOf).stages).toBeNull()
  })

  it("a running lane carries its recorded ruleset's stages; an ended one, or one with none recorded, doesn't", () => {
    const rec = { id: 'l1', project: 'alpha', name: null, builder: { id: 'b1', name: 'B1' }, reviewer: null, cards: [1], state: 'active', rounds: 10, waitMinutes: 360, startedBy: 'You', startedAt: '2026-10-22T10:00:00.000Z', updatedAt: '2026-10-22T10:00:00.000Z', endedAt: null, mergeCommit: null, ruleset: pair } as unknown as LaneRecord
    const cards = new Map<number, TaskCard | null>([[1, null]])
    expect(laneView(rec, cards, undefined, null, undefined, null, undefined, team, pairStages).stages).toEqual(pairStages)
    expect(laneView({ ...rec, state: 'ended', endedAt: '2026-10-22T11:00:00.000Z' } as LaneRecord, cards, undefined, null, undefined, null, undefined, team, pairStages).stages).toBeNull()
    expect(laneView({ ...rec, ruleset: undefined } as LaneRecord, cards, undefined, null, undefined, null, undefined, team, pairStages).stages).toBeNull()
  })
})
