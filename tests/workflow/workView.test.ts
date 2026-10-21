// A card's work view (#1223): the fold of its facts as the window and the Agent API read it. Each kind of fact in its
// place, a card with no facts (before 1.0), a revision rewritten after a pass (stale) and one kept (carried over), the
// integration and the marks, and the badges the board reads of every live card.
import { describe, expect, it } from 'vitest'
import type { Actor, Fact, FactData, FactKind, StartedData, SubmittedData } from '../../src/shared/workflow/facts'
import { checksOn, currentRevision, workBadge, workView } from '../../src/shared/workflow/workView'

let seq = 0
const fact = <K extends FactKind>(kind: K, data: FactData[K], actor: Actor = 'hive', source: Fact['source'] = 'recorded'): Fact => ({ seq: ++seq, card: 7, kind, at: `2026-10-20T10:00:${String(seq).padStart(2, '0')}.000Z`, actor, source, data })
const start = (over: Partial<StartedData> = {}): FactData['Started'] => ({ folder: 'project', line: 'hive/b1', base: 'base0000aaaa', target: 'main', builder: 'B1', cardKind: 'code', ...over })
const submit = (revision: string, round: number, over: Partial<SubmittedData> = {}): FactData['Submitted'] => ({ revision, base: 'base0000aaaa', head: revision, key: `key-${revision}`, files: [{ path: 'a.ts', status: 'M' }], round, generation: 0, sameRevision: false, summary: 'Did it', ...over })
const verdict = (submission: number, revision: string, pass: boolean, round: number, generation = 0): FactData['Verdict'] => ({ reviewer: 'R1', submission, revision, pass, round, generation, comment: 'c1' })
const check = (revision: string, result: FactData['CheckRan']['result'], counted = true, name = 'unit'): FactData['CheckRan'] => ({ name, command: 'npm test', revision, tested: revision, result, run: `run-${seq + 1}`, durationMs: 1200, by: 'B1', counted, ...(counted ? {} : { whyNot: 'dirty' as const }) })
const moved = (from: FactData['Moved']['from'], to: FactData['Moved']['to']): FactData['Moved'] => ({ from, to, cause: 'intent' })

const card = { card: 7, stage: 'review' as const, preWorkflow: false }

/** Started, round 1 submitted and failed, round 2 submitted with checks, reviewed and passed. */
function reviewed(): { facts: Fact[]; s1: number; s2: number } {
  seq = 0
  const facts: Fact[] = [fact('Started', start(), 'agent:B1'), fact('Moved', moved('todo', 'active'))]
  const s1 = facts.push(fact('Submitted', submit('rev1111aaaa', 1), 'agent:B1')) && seq
  facts.push(fact('Moved', moved('active', 'review')), fact('ReviewStarted', { reviewer: 'R1', submission: s1, revision: 'rev1111aaaa' }, 'agent:R1'))
  facts.push(fact('Verdict', verdict(s1, 'rev1111aaaa', false, 1), 'agent:R1'), fact('Moved', moved('review', 'active')))
  facts.push(fact('CheckRan', check('rev2222bbbb', 'failed')), fact('CheckRan', check('rev2222bbbb', 'passed')), fact('CheckRan', check('rev2222bbbb', 'passed', false, 'lint')))
  const s2 = facts.push(fact('Submitted', submit('rev2222bbbb', 2, { files: [{ path: 'a.ts', status: 'M' }, { path: 'b.ts', status: 'A' }] }), 'agent:B1')) && seq
  facts.push(fact('Moved', moved('active', 'review')), fact('Verdict', verdict(s2, 'rev2222bbbb', true, 2), 'agent:R1'))
  return { facts, s1, s2 }
}

describe("a card's work view (#1223)", () => {
  it('a card with no facts (before 1.0): its stage and nothing invented', () => {
    const v = workView({ card: 3, stage: 'done', preWorkflow: true }, [])
    expect(v).toMatchObject({ card: 3, stage: 'done', preWorkflow: true, adopted: false, kind: null, folder: null, line: null, base: null, target: null, revisions: [], verdicts: [], checks: [], integration: null, queue: null, rounds: 0, forYou: 0, lastSeq: 0 })
    expect(v.marks).toEqual({ carriedOver: [], stale: null, outsideRules: [], mergedInPart: null, leftTarget: null, overridden: false })
    expect(workBadge(v)).toMatchObject({ card: 3, preWorkflow: true, revision: null, verdict: null, checks: { passed: 0, failed: 0, notCounted: 0 }, stale: false, decisionSince: false })
  })

  it('the line, base, folder and target of its start; each revision with its round, files, time and builder', () => {
    const { facts, s1, s2 } = reviewed()
    const v = workView(card, facts)
    expect(v).toMatchObject({ folder: 'project', line: 'hive/b1', base: 'base0000aaaa', target: 'main', builder: 'B1', kind: 'code', adopted: false, rounds: 1 })
    expect(v.revisions.map((r) => [r.submission, r.revision, r.round, r.files.length, r.by])).toEqual([
      [s1, 'rev1111aaaa', 1, 1, 'B1'],
      [s2, 'rev2222bbbb', 2, 2, 'B1']
    ])
    expect(v.revisions[1].at).toBe(facts.find((f) => f.seq === s2)!.at)
    expect(currentRevision(v)).toBe('rev2222bbbb')
  })

  it('what couldn’t be read, and why, when the work started and when it was submitted: kept, never read as none (#1224 round 1)', () => {
    seq = 0
    const facts = [
      fact('Started', start({ line: null, base: null, platform: { unknown: { line: 'cannot read repository HEAD', base: 'cannot read repository HEAD' } } }), 'agent:B1'),
      fact('Submitted', submit(null as unknown as string, 1, { revision: null, head: null, files: [], platform: { unknown: { revision: 'cannot read repository HEAD', files: 'cannot read repository diff' } } }), 'agent:B1'),
      fact('Submitted', submit('rev3333cccc', 2), 'agent:B1')
    ]
    const v = workView(card, facts)
    expect(v.unknown).toEqual({ line: 'cannot read repository HEAD', base: 'cannot read repository HEAD' })
    expect(v.revisions.map((r) => r.unknown)).toEqual([{ revision: 'cannot read repository HEAD', files: 'cannot read repository diff' }, {}])
    // A later submission read in full keeps the earlier one's record as it was.
    expect(v.revisions[0]).toMatchObject({ revision: null, files: [] })
  })

  it('verdicts tied to their submission, revision and round; only the latest submission at this generation counts', () => {
    const { facts, s1, s2 } = reviewed()
    const v = workView(card, facts)
    expect(v.verdicts.map((x) => [x.submission, x.revision, x.round, x.pass, x.current])).toEqual([
      [s1, 'rev1111aaaa', 1, false, false],
      [s2, 'rev2222bbbb', 2, true, true]
    ])
    // A decision since makes the pass one that no longer counts, and the latest submission was made before it.
    const later = workView(card, [...facts, fact('Decision', { decision: 'd1', generation: 1, text: 'Keep it' }, 'user')])
    expect(later.verdicts.at(-1)!.current).toBe(false)
    expect(later.decisions.generation).toBe(1)
    expect(workBadge(later)).toMatchObject({ decisionSince: true, verdict: { pass: true, current: false } })
  })

  it('checks per revision, counted or not; the badge counts the newest counted run of each', () => {
    const { facts } = reviewed()
    const v = workView(card, facts)
    expect(checksOn(v, 'rev2222bbbb').map((c) => [c.name, c.result, c.counted, c.whyNot])).toEqual([
      ['unit', 'failed', true, undefined],
      ['unit', 'passed', true, undefined],
      ['lint', 'passed', false, 'dirty']
    ])
    expect(checksOn(v, 'rev1111aaaa')).toEqual([])
    expect(workBadge(v)).toMatchObject({ revision: 'rev2222bbbb', verdict: { pass: true, revision: 'rev2222bbbb', current: true }, checks: { passed: 1, failed: 0, notCounted: 1 } })
  })

  it('a revision rewritten after the pass (another change): stale until the builder submits again', () => {
    const { facts } = reviewed()
    const stale = [...facts, fact('HeadMoved', { line: 'hive/b1', from: 'rev2222bbbb', to: 'rev3333cccc' }, 'outside', 'observed'), fact('Stale', { approved: 'rev2222bbbb', current: 'rev3333cccc', why: 'change' })]
    const v = workView(card, stale)
    expect(v.marks.stale).toEqual({ approved: 'rev2222bbbb', current: 'rev3333cccc', why: 'change' })
    expect(v.head).toBe('rev3333cccc')
    // The pass stays in its history, on its revision, but no longer counts (HR5's round 1 finding 2).
    expect(v.verdicts.at(-1)).toMatchObject({ pass: true, revision: 'rev2222bbbb', current: false })
    expect(workBadge(v)).toMatchObject({ stale: true, verdict: { pass: true, current: false } })
    const again = workView(card, [...stale, fact('Submitted', submit('rev3333cccc', 3), 'agent:B1')])
    expect(again.marks.stale).toBeNull()
    expect(again.revisions.map((r) => r.round)).toEqual([1, 2, 3])
  })

  it('a revision rewritten as the same change: the pass carried over to it, and the checks read on it', () => {
    const { facts } = reviewed()
    const v = workView(card, [...facts, fact('CarriedOver', { from: 'rev2222bbbb', to: 'rev4444dddd', toBase: 'base1111bbbb', how: 'replay' }), fact('CheckRan', check('rev4444dddd', 'failed'))])
    expect(v.marks.carriedOver).toEqual([{ from: 'rev2222bbbb', to: 'rev4444dddd', how: 'replay', at: expect.any(String) }])
    expect(v.approved).toEqual({ revision: 'rev4444dddd', base: 'base1111bbbb' })
    expect(v.marks.stale).toBeNull()
    expect(v.verdicts.at(-1)).toMatchObject({ pass: true, current: true })
    expect(workBadge(v)).toMatchObject({ revision: 'rev4444dddd', stale: false, verdict: { current: true }, checks: { passed: 0, failed: 1, notCounted: 0 } })
  })

  it('the integration: the queue entry, its method, result revision and merge commit; outside the rules', () => {
    const { facts } = reviewed()
    const queued = [...facts, fact('Moved', moved('review', 'approved')), fact('IntegrationRequested', { entry: 'e1', revision: 'rev2222bbbb', key: null, target: 'main', style: 'merge' }), fact('IntegrationStarted', { entry: 'e1', expected: 'main0000', result: 'merge5555' })]
    expect(workView(card, queued).queue).toEqual({ entry: 'e1', revision: 'rev2222bbbb', target: 'main', state: 'started' })
    const v = workView({ ...card, stage: 'done' }, [...queued, fact('Integrated', { entry: 'e1', revision: 'rev2222bbbb', target: 'main', result: 'merge5555', method: 'merge', by: 'hive' })])
    expect(v.integration).toEqual({ revision: 'rev2222bbbb', target: 'main', result: 'merge5555', method: 'merge', by: 'hive', mergeCommit: 'merge5555', at: expect.any(String) })
    expect(v.queue!.state).toBe('integrated')
    const failed = workView(card, [...queued, fact('IntegrationFailed', { entry: 'e1', revision: 'rev2222bbbb', target: 'main', reason: 'conflict', transient: false })])
    expect(failed.queue).toMatchObject({ state: 'failed', failure: 'conflict' })
    // Merged by hand before its rules passed: a squash has no merge commit, and the mark says which rules.
    const outside = workView({ ...card, stage: 'done' }, [...facts, fact('Integrated', { revision: 'rev2222bbbb', target: 'main', result: 'sq6666', method: 'squash', by: 'outside', outsideRules: ['review.passed'] }, 'outside', 'observed')])
    expect(outside.integration).toMatchObject({ method: 'squash', by: 'outside', mergeCommit: null })
    expect(outside.marks.outsideRules).toEqual(['review.passed'])
    expect(workBadge(outside).outsideRules).toBe(true)
  })

  it('the marks of a card merged in part and of one whose revision left its target', () => {
    const { facts } = reviewed()
    const part = workView(card, [...facts, fact('MergedInPart', { revision: 'rev1111aaaa', target: 'main' }, 'outside', 'observed')])
    expect(part.marks.mergedInPart).toEqual({ revision: 'rev1111aaaa', target: 'main' })
    expect(workBadge(part).mergedInPart).toBe(true)
    const done = [...facts, fact('Integrated', { revision: 'rev2222bbbb', target: 'main', result: 'm7777', method: 'merge', by: 'hive' })]
    const left = workView({ ...card, stage: 'done' }, [...done, fact('LeftTarget', { revision: 'rev2222bbbb', target: 'main' }, 'outside', 'observed')])
    expect(workBadge(left)).toMatchObject({ leftTarget: true })
    // Integrated again: the mark goes.
    expect(workView(card, [...done, fact('LeftTarget', { revision: 'rev2222bbbb', target: 'main' }), fact('Integrated', { revision: 'rev2222bbbb', target: 'main', result: 'm8888', method: 'merge', by: 'outside' })]).marks.leftTarget).toBeNull()
  })

  it('an adopted card: the column it was in, its adopted submission', () => {
    seq = 0
    const facts = [fact('Adopted', start({ adoptedFrom: 'review' }), 'hive', 'observed'), fact('Moved', { from: 'todo', to: 'review', cause: 'derived' }), fact('Submitted', submit('rev9999eeee', 1, { adopted: true }), 'hive', 'observed')]
    const v = workView(card, facts)
    expect(v).toMatchObject({ adopted: true, adoptedFrom: 'review', preWorkflow: false })
    expect(v.revisions).toMatchObject([{ revision: 'rev9999eeee', adopted: true, by: null }])
    expect(workBadge(v)).toMatchObject({ adopted: true, revision: 'rev9999eeee' })
  })

  it("a new cycle starts the card's work again: the earlier revisions and verdicts are history, its rounds kept", () => {
    const { facts } = reviewed()
    const v = workView({ ...card, stage: 'active' }, [...facts, fact('Moved', moved('review', 'todo')), fact('Started', start({ line: 'hive/b2', builder: 'B2' }), 'agent:B2')])
    expect(v).toMatchObject({ line: 'hive/b2', builder: 'B2', revisions: [], verdicts: [], checks: [], rounds: 1 })
  })

  it("its stage is the fold's: the last Moved, else the cached stage it starts from (HR5's round 1 finding 3)", () => {
    const { facts } = reviewed()
    expect(workView({ ...card, stage: 'active' }, facts).stage).toBe('review')
    expect(workBadge(workView({ ...card, stage: 'active' }, facts)).stage).toBe('review')
    expect(workView({ ...card, stage: 'approved' }, facts.filter((f) => f.kind !== 'Moved')).stage).toBe('approved')
    expect(workView({ card: 3, stage: 'hold', preWorkflow: true }, []).stage).toBe('hold')
  })

  it("None's acceptance by revision, a no-code card's by submission; a new cycle clears it (HR5's round 1 finding 1)", () => {
    seq = 0
    const none = [
      fact('Started', start({ line: null, target: null, base: 'hash0000', manifest: { 'a.md': 'h1' } }), 'agent:B1'),
      fact('Submitted', submit('hash1111', 1, { base: 'hash0000', head: null, key: null }), 'agent:B1'),
      fact('Verdict', verdict(2, 'hash1111', true, 1), 'agent:R1'),
      fact('Accepted', { revision: 'hash1111' }, 'user'),
      fact('Moved', moved('approved', 'done'))
    ]
    const v = workView(card, none)
    expect(v).toMatchObject({ stage: 'done', line: null, integration: null, accepted: { revision: 'hash1111', submission: null, at: none[3].at, actor: 'user' } })
    expect(workBadge(v).accepted).toBe(true)
    seq = 0
    const noCode = [fact('Started', start({ cardKind: 'no-code' }), 'agent:B1'), fact('Submitted', submit('', 1, { revision: null, base: null, head: null, key: null, files: [] }), 'agent:B1'), fact('Accepted', { submission: 2 }, 'user')]
    expect(workView(card, noCode)).toMatchObject({ kind: 'no-code', revisions: [{ revision: null }], accepted: { revision: null, submission: 2 } })
    expect(workView(card, [...noCode, fact('Moved', moved('done', 'todo')), fact('Started', start(), 'agent:B1')]).accepted).toBeNull()
  })

  it('requests to the user and an override past review', () => {
    const { facts, s2 } = reviewed()
    const v = workView(card, [...facts, fact('ApprovalRequested', { request: 'q1', kind: 'approve', gate: 'okBefore', submission: s2, text: 'OK to merge?' }), fact('Override', { rules: ['integrate.approved'], move: 'merge', by: 'user', reason: 'urgent' }, 'user')])
    expect(v.forYou).toBe(1)
    expect(v.marks.overridden).toBe(true)
    expect(workBadge(v)).toMatchObject({ forYou: 1, overridden: true })
  })
})
