// Options → rulesets (#1118, SPEC §16.5): presets compile, rulesets are plain data with a stable content hash, an unknown
// piece refuses to load, a newer ruleset is read-only, and every refusal is three whole sentences.
import { describe, expect, it } from 'vitest'
import { allOff, preset } from '../../src/shared/workflow/options'
import { canonical, compile, loadRuleset, mustCompile, RULESET_VERSION } from '../../src/shared/workflow/compile'
import { REFUSALS, refusal } from '../../src/shared/workflow/refusals'
import { GUARDS } from '../../src/shared/workflow/pieces'
import { foldCard, type Fact } from '../../src/shared/workflow/facts'
import { parseCardRef } from '../../src/shared/workflow/cardRefs'
import { changeList, newLane, nextCard, type LaneList } from '../../src/shared/workflow/laneList'

describe('compilation', () => {
  it('compiles every preset on both platforms, with the stages §16.5.2 gives them', () => {
    const stages = (p: 'git' | 'none', id: 'solo' | 'pair' | 'team') => mustCompile(preset(p, id)).stages.map((s) => s.id)
    expect(stages('git', 'solo')).toEqual(['hold', 'todo', 'active', 'done'])
    expect(stages('git', 'pair')).toEqual(['hold', 'todo', 'active', 'review', 'approved', 'merging', 'done'])
    expect(stages('git', 'team')).toEqual(['hold', 'todo', 'active', 'review', 'approved', 'merging', 'done'])
    expect(stages('none', 'solo')).toEqual(['hold', 'todo', 'active', 'done'])
    expect(stages('none', 'team')).toEqual(['hold', 'todo', 'active', 'review', 'approved', 'done'])
  })

  it('all off holds no guard that can refuse an ordinary move (only submit.notDuplicate)', () => {
    for (const p of ['git', 'none'] as const) {
      const r = mustCompile(allOff(p))
      expect(Object.values(r.guards).flat()).toEqual(['submit.notDuplicate'])
    }
  })

  it('an unread decision holds a submit with any review or a merge step; all off and Solo stay free (HI-2275)', () => {
    const holds = (o: ReturnType<typeof allOff>) => mustCompile(o).guards.submit.includes('submit.decisionsReceived')
    const off = allOff('git')
    expect(holds(off)).toBe(false)
    expect(holds(allOff('none'))).toBe(false)
    expect(holds(preset('git', 'solo'))).toBe(false)
    expect(holds({ ...off, finish: 'committed' })).toBe(false)
    expect(holds({ ...off, finish: 'hiveMerges', folder: 'slots' })).toBe(true)
    expect(holds({ ...off, finish: 'agentMerges', folder: 'slots' })).toBe(true)
    expect(holds(preset('git', 'pair'))).toBe(true)
    expect(holds(preset('none', 'team'))).toBe(true)
  })

  it('None rulesets hold no guard that needs Git: no clean, ready or trailer', () => {
    const r = mustCompile(preset('none', 'team', { quick: ['lint'], tests: [] }))
    expect(r.guards.submit).not.toContain('submit.clean')
    expect(r.guards.submit).not.toContain('submit.trailer')
    expect(r.guards.submit).toContain('submit.checksPassed')
  })

  it('a ruleset\'s id is a hash of its content, whatever the order its options were written in', () => {
    const a = mustCompile(preset('git', 'pair'))
    const reordered = Object.fromEntries(Object.entries(preset('git', 'pair')).reverse()) as ReturnType<typeof preset>
    expect(mustCompile(reordered).id).toBe(a.id)
    expect(mustCompile({ ...preset('git', 'pair'), strict: true }).id).not.toBe(a.id)
    expect(canonical({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}')
  })

  it('refuses to load a ruleset with an unknown piece; one from a newer Combwork is read-only', () => {
    const r = mustCompile(preset('git', 'team'))
    expect(loadRuleset(JSON.parse(JSON.stringify(r)))).toMatchObject({ ok: true, readOnly: false })
    expect(loadRuleset({ ...r, guards: { ...r.guards, submit: ['submit.runAnything'] } })).toMatchObject({ ok: false, error: 'unknownPiece', piece: 'submit.runAnything' })
    expect(loadRuleset({ ...r, version: RULESET_VERSION + 1 })).toMatchObject({ ok: true, readOnly: true })
    expect(compile({ ...preset('git', 'pair'), noSelfReview: false })).toEqual({ ok: false, contradictions: ['selfReview'] })
    expect(compile({ ...preset('git', 'solo'), okBefore: { mode: 'every', labels: [] }, review: 'you' })).toEqual({ ok: false, contradictions: ['okWithReview'] })
  })

  it('every piece\'s refusal is three whole sentences from messages (the change sentence where a rule has one)', () => {
    for (const id of Object.keys(GUARDS)) expect(REFUSALS[id as keyof typeof REFUSALS], id).toBeDefined()
    for (const [rule, t] of Object.entries(REFUSALS)) {
      expect(t.message.id).toBe(`workflow.refused.${rule}.message`)
      expect(t.next.id).toBe(`workflow.refused.${rule}.next`)
      if (t.change) expect(t.change.id).toBe(`workflow.refused.${rule}.change`)
    }
    const r = refusal('requeue.allowed', { card: 'AM-12', revision: 'a3f2c1d', cause: 'requeueLimit', n: 2 })
    expect(r.message).toBe("AM-12 at a3f2c1d can't go back into the merge queue unchanged: it was sent back unchanged 2 times already.")
    expect(r.change).toBe('Retry merge on the merge queue retries it once.')
  })
})

describe('the fold, card references and lane lists', () => {
  it('derives the stage from Moved facts only; a new Started begins a new cycle', () => {
    const f = (seq: number, kind: Fact['kind'], data: object): Fact => ({ seq, card: 1, kind, at: '', actor: 'user', source: 'recorded', data: data as never })
    const s = foldCard([f(1, 'Started', { folder: 'project', line: 'main', base: 'b', target: 'main', builder: 'B1', cardKind: 'code' }), f(2, 'Moved', { from: 'todo', to: 'active', cause: 'intent' }), f(3, 'Submitted', { revision: 'r', base: 'b', head: 'r', key: 'k', files: [], round: 1, generation: 0, sameRevision: false, summary: '' }), f(4, 'Moved', { from: 'active', to: 'review', cause: 'intent' }), f(5, 'Verdict', { reviewer: 'R1', submission: 3, revision: 'r', pass: false, round: 1, generation: 0, comment: '' })])
    expect(s).toMatchObject({ stage: 'review', rounds: 1, cycle: 1 })
    const again = foldCard([...[1, 2, 3, 4, 5].map((n) => ({ ...f(n, 'Moved', { from: 'todo', to: 'todo', cause: 'user' }) })), f(6, 'Started', { folder: 'project', line: 'main', base: 'c', target: 'main', builder: 'B2', cardKind: 'code' })])
    expect(again).toMatchObject({ cycle: 6, submissions: [], builders: ['B2'] })
  })

  it('card references: a key or an alias; a plain number is refused', () => {
    expect(parseCardRef('am-12')).toEqual({ ok: true, ref: { key: 'AM-12', project: 'AM', n: 12 } })
    expect(parseCardRef('#1061')).toEqual({ ok: true, ref: { alias: 1061 } })
    expect(parseCardRef(1061)).toEqual({ ok: false, rule: 'card.plainNumber' })
    expect(parseCardRef('1061')).toEqual({ ok: false, rule: 'card.plainNumber' })
  })

  it('a lane\'s list change while a card is in flight waits for the boundary', () => {
    let l: LaneList = { ...newLane('L', [1, 2, 3], 'r'), current: 2 }
    l = changeList(l, [1, 2, 3, 4])
    expect(l.cards).toEqual([1, 2, 3])
    const done = new Set([1])
    expect(nextCard(l, (c) => done.has(c)).card).toBe(2)
    done.add(2)
    const n = nextCard(l, (c) => done.has(c))
    expect(n).toMatchObject({ card: 3, lane: { cards: [1, 2, 3, 4], pending: null } })
  })
})
