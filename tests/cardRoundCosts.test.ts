// A card's cost per round and role (#1226, #820 item 2): its rounds from its facts, and in each what its builder's and
// reviewers' sessions used while they held the card then, shared with the live cards they held at the same time.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { writeCard } from './boardDb'
import { roundSpans } from '../src/shared/cardCosts'
import { TimelineBuilder } from '../src/shared/usageTimeline'
import type { Fact, FactKind } from '../src/shared/workflow/facts'
import { preset } from '../src/shared/workflow/options'
import { B1, R1, R2, commit, moved, setup, type Env } from './workflow/harness'

const base = tempDir('hive-round-costs-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService } = await import('../src/main/workspace')
const store = await import('../src/main/boardStore')
const { FactStore } = await import('../src/main/workflow/factStore')
const { usageHistory } = await import('../src/main/usageHistory')
const { cardRoundCosts } = await import('../src/main/cardCosts')

const T0 = Date.parse('2026-10-12T10:00:00.000Z')
const MIN = 60_000
const t = (m: number): number => T0 + m * MIN
const iso = (m: number): string => new Date(t(m)).toISOString()
const NOW = t(100)

let seq = 0
const fact = (kind: FactKind, m: number, data: Record<string, unknown> = {}, actor = 'hive'): Fact => ({ card: 1, seq: ++seq, kind, at: iso(m), actor, source: 'recorded', data }) as unknown as Fact
const started = (m: number, kind: 'Started' | 'Adopted' = 'Started', adoptedFrom?: string): Fact => fact(kind, m, { folder: 'project', line: 'main', base: 'b0', target: 'main', builder: 'b1', cardKind: 'code', ...(adoptedFrom ? { adoptedFrom } : {}) })
const submitted = (m: number, round: number): Fact => fact('Submitted', m, { revision: `r${round}`, base: 'b0', head: `r${round}`, key: null, files: [], round, generation: 0, sameRevision: false, summary: '' }, 'agent:b1')
/** A verdict on the submission whose fact is `submission` (its seq); its own round is the runtime's count of failures, never read. */
const verdict = (m: number, pass: boolean, submission: number, reviewer: string): Fact => fact('Verdict', m, { reviewer: reviewer.replace(/^agent:/, ''), submission, revision: null, pass, round: 99, generation: 0, comment: '' }, reviewer)
const movedAt = (m: number, from: string, to: string): Fact => fact('Moved', m, { from, to, cause: 'intent' })

describe('roundSpans on the facts the runtime writes (#1226)', () => {
  let env: Env | null = null
  afterEach(() => {
    env?.close()
    env = null
  })
  const pair = (more: Record<string, unknown> = {}): Env => (env = setup({ ...preset('git', 'pair'), preChecks: [], mergeChecks: [], finish: 'agentMerges', ...more } as never))
  async function startedCard(e: Env) {
    const card = e.wf.createCard({ title: 'Costed', reviewer: 'R1' })
    const s = await e.wf.start(card.key, B1)
    moved(s)
    const folder = s.data!.folder as string
    commit(folder, { 'src/a.txt': 'one\n' }, 'one')
    return { card, folder }
  }
  const rounds = (e: Env, id: number) => roundSpans(e.store.facts(id), Date.now() + 60_000)
  const lastAt = (e: Env, id: number, kind: FactKind): number => Date.parse(e.store.facts(id).findLast((f) => f.kind === kind)!.at)

  it('a fail then a pass: rounds 1 and 2 (a verdict counts for its submission, not by its own round)', async () => {
    const e = pair()
    const { card, folder } = await startedCard(e)
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
    moved(await e.wf.startReview(card.key, R1))
    moved(await e.wf.verdict(card.key, R1, { pass: false, comment: 'no' }))
    commit(folder, { 'src/a.txt': 'two\n' }, 'two')
    moved(await e.wf.submit(card.key, B1, { summary: 'y' }))
    moved(await e.wf.startReview(card.key, R1))
    moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
    // As the runtime numbers them: the pass's own round is 1, its submission's 2.
    expect(e.store.facts(card.id).filter((f) => f.kind === 'Verdict').map((f) => (f.data as { round: number }).round)).toEqual([1, 1])
    expect(rounds(e, card.id).map((r) => [r.round, r.verdict, r.reviewers])).toEqual([
      [1, 'failed', ['R1']],
      [2, 'passed', ['R1']]
    ])
  })

  it('two reviewers: the first pass ends nothing; the round runs to the second, and on to Approved', async () => {
    const e = pair({ reviewers: 2 })
    const { card } = await startedCard(e)
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
    moved(await e.wf.startReview(card.key, R1))
    moved(await e.wf.verdict(card.key, R1, { pass: true, comment: '1' }))
    moved(await e.wf.startReview(card.key, R2))
    moved(await e.wf.verdict(card.key, R2, { pass: true, comment: '2' }))
    expect(e.wf.state(card).stage).toBe('approved')
    const [r] = rounds(e, card.id)
    expect(rounds(e, card.id)).toHaveLength(1)
    expect(r).toMatchObject({ round: 1, verdict: 'passed', reviewers: ['R1', 'R2'] })
    expect(r.to).toBeGreaterThanOrEqual(lastAt(e, card.id, 'Verdict'))
  })

  it('a pass then a fail by the second reviewer: the round failed, and the fixes are round 2', async () => {
    const e = pair({ reviewers: 2 })
    const { card, folder } = await startedCard(e)
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
    moved(await e.wf.startReview(card.key, R1))
    moved(await e.wf.verdict(card.key, R1, { pass: true, comment: '1' }))
    moved(await e.wf.startReview(card.key, R2))
    moved(await e.wf.verdict(card.key, R2, { pass: false, comment: 'no' }))
    commit(folder, { 'src/a.txt': 'two\n' }, 'two')
    moved(await e.wf.submit(card.key, B1, { summary: 'y' }))
    expect(rounds(e, card.id).map((r) => [r.round, r.verdict, r.reviewers])).toEqual([
      [1, 'failed', ['R1', 'R2']],
      [2, null, []]
    ])
  })
})

describe('roundSpans in time (#1226)', () => {
  it('rounds follow submissions; a round under way runs to now; a reopened card starts again; work pauses outside Active and Review', () => {
    seq = 0
    const log = [started(0), submitted(10, 1), verdict(20, false, 2, 'agent:r1'), submitted(30, 2), verdict(40, true, 4, 'agent:r2'), movedAt(40, 'review', 'approved')]
    expect(roundSpans(log, NOW)).toEqual([
      { cycle: 1, round: 1, spans: [[t(0), t(20)]], from: t(0), to: t(20), submitted: t(10), verdict: 'failed', reviewers: ['r1'] },
      { cycle: 1, round: 2, spans: [[t(20), t(40)]], from: t(20), to: t(40), submitted: t(30), verdict: 'passed', reviewers: ['r2'] }
    ])
    seq = 0
    expect(roundSpans([started(0), submitted(10, 1)], NOW)).toMatchObject([{ round: 1, spans: [[t(0), NOW]], submitted: t(10), verdict: null }])
    seq = 0
    const reopened = roundSpans([started(0), submitted(5, 1), verdict(10, true, 2, 'agent:r1'), movedAt(10, 'review', 'done'), started(50), submitted(60, 1)], NOW)
    expect(reopened.map((r) => [r.cycle, r.round, r.spans])).toEqual([
      [1, 1, [[t(0), t(10)]]],
      [5, 1, [[t(50), NOW]]]
    ])
    // On Hold for a while: not worked then.
    seq = 0
    expect(roundSpans([started(0), movedAt(10, 'active', 'hold'), movedAt(30, 'hold', 'active'), submitted(40, 1)], NOW)[0].spans).toEqual([[t(0), t(10)], [t(30), NOW]])
  })

  it('a pass made stale and sent back: the later work counts, in its round', () => {
    seq = 0
    const log = [started(0), submitted(10, 1), verdict(20, true, 2, 'agent:r1'), movedAt(20, 'review', 'approved'), movedAt(50, 'approved', 'active'), submitted(60, 2), verdict(70, true, 7, 'agent:r1'), movedAt(70, 'review', 'approved')]
    expect(roundSpans(log, NOW).map((r) => [r.round, r.spans, r.verdict])).toEqual([
      [1, [[t(0), t(20)], [t(50), t(60)]], 'passed'],
      [2, [[t(60), t(70)]], 'passed']
    ])
  })

  it('an adopted card in Passed is worked only once it comes back; an adopted cycle counts as a start', () => {
    seq = 0
    expect(roundSpans([started(0, 'Adopted', 'passed')], NOW)).toEqual([])
    seq = 0
    expect(roundSpans([started(0, 'Adopted', 'review'), submitted(0, 1)], NOW)).toMatchObject([{ cycle: 1, round: 1, spans: [[t(0), NOW]] }])
  })

  it('no cycle, no rounds: a card from before 1.0, or one never started (a Submitted alone is no round)', () => {
    seq = 0
    expect(roundSpans([], NOW)).toEqual([])
    expect(roundSpans([submitted(10, 1), verdict(20, true, 1, 'agent:r1')], NOW)).toEqual([])
  })
})

describe('cardRoundCosts (#1226)', () => {
  type WS = ReturnType<typeof createWorkspaceService>
  const opened: WS[] = []
  afterAll(async () => {
    vi.restoreAllMocks()
    for (const w of opened) await disposeWorkspaceService(w)
    store.closeAllBoards()
  })

  /** A session's usage over time: output tokens at minutes. */
  const session = (agentId: string, at: [number, number][]) => {
    const b = new TimelineBuilder()
    for (const [m, out] of at) b.add(t(m), { outputTokens: out }, 1)
    return { scope: 'p', session: `s-${agentId}`, provider: 'claude-code' as const, agentId, agentName: agentId, summary: { provider: 'claude-code', model: 'claude-sonnet-5-5' } as never, timeline: b.timeline([]), firstActivity: iso(0), lastActivity: iso(45) }
  }
  const hold = (agent: string, role: 'build' | 'review', from: number, to: number) => ({ agent, name: agent.toUpperCase(), role, from: iso(from), to: iso(to) })
  const doc = (number: number, held: unknown[], more: Record<string, unknown> = {}): Record<string, unknown> => ({ number, title: `Card ${number}`, description: '', project: 'p', agent: 'b1', column: 'passed', order: number, labels: [], blocked: null, blockedBy: [], links: [], comments: [], history: [], archived: false, createdAt: iso(0), createdBy: 'You', updatedAt: iso(0), held, ...more })

  async function world(): Promise<WS> {
    const ws = join(base, `ws-${opened.length + 1}`)
    mkdirSync(join(ws, 'p', '.hive'), { recursive: true })
    writeFileSync(join(ws, 'p', '.hive', 'project.json'), JSON.stringify({ version: 2, agents: ['b1', 'r1', 'r2'].map((id) => ({ id, name: id.toUpperCase() })) }))
    const w = createWorkspaceService()
    await w.open(ws)
    opened.push(w)
    // B1 builds rounds 1 and 2; R1 reviews round 1 and R2 round 2 (a reviewer swap).
    await writeCard(w, 1, doc(1, [hold('b1', 'build', 0, 10), hold('r1', 'review', 10, 20), hold('b1', 'build', 20, 30), hold('r2', 'review', 30, 40)]))
    // B1 also held a live card in round 2's last five minutes of building (shared 1/2), and an archived one in round 1 (not read).
    await writeCard(w, 2, doc(2, [hold('b1', 'build', 25, 30)], { column: 'doing' }))
    await writeCard(w, 3, doc(3, [hold('b1', 'build', 0, 10)], { archived: true }))
    // Another project's live card held by its own B1 (an older hold, named only) during round 1: another agent, not shared (HR1's round 1).
    await writeCard(w, 4, doc(4, [{ name: 'B1', role: 'build', from: iso(0), to: iso(10) }], { project: 'q', agent: null, column: 'doing' }))
    // Card 1's facts, at their times.
    const fs = FactStore.forBoard(w, { project: 'p', key: 'p' })
    seq = 0
    const log = [started(0), submitted(10, 1), verdict(20, false, 2, 'agent:r1'), submitted(30, 2), verdict(40, true, 4, 'agent:r2'), movedAt(40, 'review', 'approved')]
    await store.boardWrite(w, async () => {
      fs.tx((tx) => {
        for (const f of log) tx.append(1, { kind: f.kind, actor: f.actor, source: 'recorded', data: f.data } as never)
      })
      store.boardWriteOp(w, (db) => {
        const set = db.prepare('UPDATE card_facts SET at = ? WHERE card = 1 AND seq = ?')
        for (const f of log) set.run(f.at, f.seq)
      })
    })
    vi.spyOn(usageHistory, 'freshen').mockResolvedValue(undefined as never)
    vi.spyOn(usageHistory, 'timelines').mockResolvedValue([session('b1', [[5, 100], [27, 50]]), session('r1', [[15, 30]]), session('r2', [[35, 40]])] as never)
    return w
  }

  it('splits a card by round and role, a reviewer swap and shared time included', async () => {
    const w = await world()
    const c = (await cardRoundCosts(w, 1))!
    expect(c.preWorkflow).toBe(false)
    expect(c.rounds.map((r) => [r.round, r.verdict, r.reviewers, r.build.outputTokens, r.review.outputTokens])).toEqual([
      [1, 'failed', ['r1'], 100, 30],
      [2, 'passed', ['r2'], 25, 40]
    ])
    expect(c.rounds[0].agents.map((a) => [a.agent, a.role, a.part.outputTokens])).toEqual([['b1', 'build', 100], ['r1', 'review', 30]])
    expect(c.rounds[1].agents.map((a) => [a.agent, a.role, a.part.outputTokens])).toEqual([['b1', 'build', 25], ['r2', 'review', 40]])
    // Shared time is Hive's share: ≈.
    expect(c.rounds[1].build.tokensEstimated).toBe(true)
    expect(c.rounds[0]).toMatchObject({ from: iso(0), to: iso(20), submitted: iso(10) })
  })

  it('a card from before 1.0 reports no rounds; a card that isn’t there, null', async () => {
    const w = opened[0] ?? (await world())
    await store.boardWrite(w, async () => store.boardWriteOp(w, (db) => db.prepare('UPDATE cards SET pre_workflow = 1 WHERE number = 2').run()))
    expect(await cardRoundCosts(w, 2)).toEqual({ number: 2, preWorkflow: true, rounds: [] })
    expect(await cardRoundCosts(w, 999)).toBeNull()
  })
})
