// A follow-up's pinned revision and the passes that cover it (HI-1763, facts.ts' passesCover): a pass counts for the
// revision only if it passed it, or its reviewer's ok of the follow-up pinned there binds it (that submission, that
// decision generation); the quorum is counted from those alone. And the stale pass's start, which nothing later moves.
import { describe, expect, it } from 'vitest'
import { foldCard, passesCover, type Actor, type Fact, type FactData, type FactKind } from '../../src/shared/workflow/facts'

let seq = 0
const fact = <K extends FactKind>(kind: K, data: FactData[K], actor: Actor = 'hive'): Fact => ({ seq: ++seq, card: 7, kind, at: `2026-10-26T21:${String(Math.floor(seq / 60)).padStart(2, '0')}:${String(seq % 60).padStart(2, '0')}.000Z`, actor, source: 'recorded', data })

/** A card submitted at e89, with a follow-up pinned at bd6 (posted in that round and generation), and its facts so far. */
function card(): { facts: Fact[]; sub: number; design: string } {
  seq = 0
  const facts: Fact[] = [fact('Started', { folder: 'project', line: 'hive/b1', base: 'base0', target: 'main', builder: 'B1', cardKind: 'code' }, 'agent:B1')]
  facts.push(fact('Submitted', { revision: 'e89aa2fc', base: 'base0', head: 'e89aa2fc', key: 'k', files: [{ path: 'a.ts', status: 'M' }], round: 1, generation: 0, sameRevision: false, summary: 'x' }, 'agent:B1'))
  const sub = seq
  facts.push(fact('LoopStep', { step: 'followUp', text: 'one more assertion', design: 'AM-1/s9', revision: 'bd6ff9da', base: 'base0', submission: sub, generation: 0 }, 'agent:B1'))
  return { facts, sub, design: 'AM-1/s9' }
}
const ok = (by: string, design: string, sub: number, generation = 0): Fact => fact('LoopStep', { step: 'ok', text: 'checked', design, of: 'followUp', revision: 'bd6ff9da', base: 'base0', submission: sub, generation }, `agent:${by}` as Actor)
const pass = (by: string, sub: number, revision: string): Fact => fact('Verdict', { reviewer: by, submission: sub, revision, pass: true, round: 1, generation: 0, comment: 'good' }, `agent:${by}` as Actor)

describe("the passes that cover a follow-up's revision (HI-1763)", () => {
  it("the verdict's reviewer's binding ok covers it, one reviewer to count", () => {
    const { facts, sub, design } = card()
    facts.push(ok('R1', design, sub))
    expect(passesCover(foldCard(facts), 'bd6ff9da', 1, 'R1')).toBe(true)
  })

  it("another reviewer's ok, no ok at all, an ok of another revision: not covered", () => {
    const { facts, sub, design } = card()
    expect(passesCover(foldCard(facts), 'bd6ff9da', 1, 'R1')).toBe(false)
    facts.push(ok('R2', design, sub))
    expect(passesCover(foldCard(facts), 'bd6ff9da', 1, 'R1')).toBe(false)
    expect(passesCover(foldCard(facts), 'ffffffff', 1, 'R2')).toBe(false)
  })

  it("an ok from an earlier round, or before a decision since, binds nothing", () => {
    const { facts, sub, design } = card()
    facts.push(ok('R1', design, sub - 1))
    expect(passesCover(foldCard(facts), 'bd6ff9da', 1, 'R1')).toBe(false)
    const decided = card()
    decided.facts.push(ok('R1', decided.design, decided.sub, 0))
    decided.facts.push(fact('Decision', { decision: 'd1', generation: 1, text: 'Use the other name' }, 'user'))
    const s = foldCard(decided.facts)
    expect(s.generation).toBe(1)
    expect(passesCover(s, 'bd6ff9da', 1, 'R1')).toBe(false)
  })

  it("two reviewers: A's pass of the submitted revision doesn't count; both covering it does", () => {
    const { facts, sub, design } = card()
    facts.push(pass('R1', sub, 'e89aa2fc'), ok('R2', design, sub))
    expect(passesCover(foldCard(facts), 'bd6ff9da', 2, 'R2')).toBe(false)
    // A passed the pinned revision itself: both cover it.
    const both = card()
    both.facts.push(pass('R1', both.sub, 'bd6ff9da'), ok('R2', both.design, both.sub))
    expect(passesCover(foldCard(both.facts), 'bd6ff9da', 2, 'R2')).toBe(true)
  })

  it("in Approved (no pass being given): the passing reviewers' own binding oks are what count", () => {
    const { facts, sub, design } = card()
    facts.push(pass('R1', sub, 'e89aa2fc'), ok('R1', design, sub))
    expect(passesCover(foldCard(facts), 'bd6ff9da', 1)).toBe(true)
    expect(passesCover(foldCard(facts), 'bd6ff9da', 2)).toBe(false)
  })
})

describe("a stale pass's start (HI-1763's stall)", () => {
  it('is its Stale fact, kept while the same stale pass stands; a new head starts again; a new submission clears it', () => {
    const { facts } = card()
    facts.push(fact('Stale', { approved: 'e89aa2fc', current: 'bd6ff9da', why: 'change' }))
    const first = foldCard(facts).staleSince
    expect(first).toBe(facts.at(-1)!.at)
    facts.push(fact('Stale', { approved: 'e89aa2fc', current: 'bd6ff9da', why: 'change' }))
    expect(foldCard(facts).staleSince).toBe(first)
    facts.push(fact('Stale', { approved: 'e89aa2fc', current: 'c0ffee00', why: 'change' }))
    expect(foldCard(facts).staleSince).toBe(facts.at(-1)!.at)
    facts.push(fact('Submitted', { revision: 'c0ffee00', base: 'base0', head: 'c0ffee00', key: 'k2', files: [{ path: 'a.ts', status: 'M' }], round: 2, generation: 0, sameRevision: false, summary: 'y' }, 'agent:B1'))
    expect(foldCard(facts)).toMatchObject({ stale: null, staleSince: null })
  })
})
