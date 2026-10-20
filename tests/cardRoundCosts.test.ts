// A card's cost per round and role (#1226, #820 item 2): its rounds from its facts, and in each what its builder's and
// reviewers' sessions used while they held the card then, shared with the live cards they held at the same time.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { writeCard } from './boardDb'
import { roundSpans } from '../src/shared/cardCosts'
import { TimelineBuilder } from '../src/shared/usageTimeline'
import type { Fact, FactKind } from '../src/shared/workflow/facts'

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
const started = (m: number, kind: 'Started' | 'Adopted' = 'Started'): Fact => fact(kind, m, { folder: 'project', line: 'main', base: 'b0', target: 'main', builder: 'b1', cardKind: 'code' })
const submitted = (m: number, round: number): Fact => fact('Submitted', m, { revision: `r${round}`, base: 'b0', head: `r${round}`, key: null, files: [], round, generation: 0, sameRevision: false, summary: '' }, 'agent:b1')
const verdict = (m: number, round: number, pass: boolean, reviewer: string): Fact => fact('Verdict', m, { reviewer, submission: 0, revision: `r${round}`, pass, round, generation: 0, comment: '' }, reviewer)

describe('roundSpans (#1226)', () => {
  it('two rounds: a fail ends round 1 and starts round 2, a pass ends the rounds; each with its reviewer', () => {
    expect(roundSpans([started(0), submitted(10, 1), verdict(20, 1, false, 'agent:r1'), submitted(30, 2), verdict(40, 2, true, 'agent:r2')], NOW)).toEqual([
      { cycle: 1, round: 1, from: t(0), to: t(20), submitted: t(10), verdict: 'failed', reviewer: 'agent:r1' },
      { cycle: 1, round: 2, from: t(20), to: t(40), submitted: t(30), verdict: 'passed', reviewer: 'agent:r2' }
    ])
  })

  it('a round under way runs to now; a reopened card starts its rounds again; an adopted cycle counts as a start', () => {
    seq = 0
    expect(roundSpans([started(0), submitted(10, 1)], NOW)).toMatchObject([{ round: 1, from: t(0), to: NOW, submitted: t(10), verdict: null }])
    seq = 0
    const reopened = roundSpans([started(0), submitted(5, 1), verdict(10, 1, true, 'agent:r1'), started(50), submitted(60, 1)], NOW)
    expect(reopened.map((r) => [r.cycle, r.round, r.from, r.to, r.verdict])).toEqual([
      [1, 1, t(0), t(10), 'passed'],
      [4, 1, t(50), NOW, null]
    ])
    seq = 0
    expect(roundSpans([started(0, 'Adopted'), submitted(0, 1)], NOW)).toMatchObject([{ cycle: 1, round: 1, from: t(0) }])
  })

  it('no cycle, no rounds: a card from before 1.0, or one never started (a Submitted alone is no round)', () => {
    seq = 0
    expect(roundSpans([], NOW)).toEqual([])
    expect(roundSpans([submitted(10, 1), verdict(20, 1, true, 'agent:r1')], NOW)).toEqual([])
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
    // Card 1's facts, at their times.
    const fs = FactStore.forBoard(w, { project: 'p', key: 'p' })
    seq = 0
    const log = [started(0), submitted(10, 1), verdict(20, 1, false, 'agent:r1'), submitted(30, 2), verdict(40, 2, true, 'agent:r2')]
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
    expect(c.rounds.map((r) => [r.round, r.verdict, r.reviewer, r.build.outputTokens, r.review.outputTokens])).toEqual([
      [1, 'failed', 'agent:r1', 100, 30],
      [2, 'passed', 'agent:r2', 25, 40]
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
