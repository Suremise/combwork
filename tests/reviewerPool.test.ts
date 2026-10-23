// The reviewer pool (#1443, G17): the option (`reviewerMode`, never G1b's `reviewers`) and its ruleset, who the pool
// gives a card to (oldest first, never its builder, never an agent building in a slot, a second one with G1b = 2), and
// the app's pass: assigned in a write, told once, freed by a verdict, nothing with the rules off.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'path'
import { B1, B2, commit, moved, R1, R2, setup, sh, type Env } from './workflow/harness'
import { tempDir } from './tempDir'
import { boardFile } from '../src/main/boardStore'
import { attributeFolder } from '../src/main/workflow/reconcile'
import { compile, loadRuleset } from '../src/shared/workflow/compile'
import { agentActor } from '../src/shared/workflow/facts'
import { allOff, contradictions, preset, reviewerModeOf, takesOption, type WorkflowOptions } from '../src/shared/workflow/options'
import { poolAssignments, submissionReviewers, type PoolAgent, type PoolCard } from '../src/shared/workflow/reviewerPool'
import type { LaneRecord } from '../src/shared/lanes'
import type { AgentDef } from '../src/shared/types'

/** What the stand-ins do: the switch, the lanes, the agents' sessions, the slots' leases and the deliveries. */
const state = vi.hoisted(() => ({
  enforced: true,
  wf: null as unknown,
  lanes: [] as LaneRecord[],
  /** Agents in a turn (not idle). */
  busy: new Set<string>(),
  /** Agents running (typed into); the rest are launched. */
  running: new Set<string>(),
  /** Agents holding an open dispatch lease (building in a slot). */
  leased: new Set<string>(),
  deliveries: [] as { id: string; agentId: string; source?: string; ref?: string; state: string; body: string }[],
  calls: [] as string[]
}))

vi.mock('../src/main/workflow/service', async (orig) => ({ ...(await orig<object>()), workflowEnforced: () => state.enforced, agentRunsGoing: () => [], workflowFor: async () => state.wf }))
vi.mock('../src/main/workflow/lineUpdates', async (orig) => ({ ...(await orig<object>()), agentBusy: (_p: string, a: string) => state.busy.has(a) }))
vi.mock('../src/main/lanes', async (orig) => ({ ...(await orig<object>()), rawLanes: async () => state.lanes }))
vi.mock('../src/main/slotsApp', async (orig) => ({ ...(await orig<object>()), poolFor: async () => ({ leasesOf: (a: string) => (state.leased.has(a) ? [{ id: `l-${a}`, kind: 'card', agent: a }] : []) }) }))
vi.mock('../src/main/projectKeys', async (orig) => ({ ...(await orig<object>()), withCardNames: (_ws: unknown, fn: () => string) => fn() }))
vi.mock('../src/main/sessions', async (orig) => {
  const actual = await orig<typeof import('../src/main/sessions')>()
  const stub = {
    liveFor: (_p: string, a: string) => (state.running.has(a) ? { status: 'ready', sessionId: `s-${a}`, cwd: '' } : null),
    agentNow: (_p: string, a: string) => (state.running.has(a) ? { status: state.busy.has(a) ? 'working' : 'ready', pending: false, backgroundTasks: 0 } : null),
    start: async (_p: string, o: { agentId: string; prompt?: string; purpose?: string }) => {
      state.calls.push(`start ${o.agentId} for ${o.purpose}`)
      state.running.add(o.agentId)
      return { runId: 'r' }
    }
  }
  return { ...actual, sessions: stub }
})
vi.mock('../src/main/deliveries', async (orig) => {
  const actual = await orig<typeof import('../src/main/deliveries')>()
  let seq = 0
  const make = (nd: { agentId: string; source?: string; ref?: string; body: string }) => {
    const r = { id: `m${++seq}`, agentId: nd.agentId, source: nd.source, ref: nd.ref, state: 'offered', body: nd.body }
    state.deliveries.push(r)
    return r
  }
  return {
    ...actual,
    deliveriesOf: async (_h: string, a: string) => state.deliveries.filter((r) => r.agentId === a).map((r) => ({ ...r })),
    deliverNow: async (_h: string, nd: { agentId: string; source?: string; ref?: string; body: string }) => {
      state.calls.push(`typed to ${nd.agentId}`)
      return make(nd)
    },
    launchWith: async (_h: string, nd: { agentId: string; source?: string; ref?: string; body: string }, start: (line: string) => Promise<unknown>) => ({ record: make(nd), launched: await start(nd.body) })
  }
})

const { settleReviewerPool } = await import('../src/main/reviewerPool')
const { poolReviewerOf } = await import('../src/main/loopReviewer')
const { resolveOptions } = await import('../src/main/workflow/rulesets')

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
  Object.assign(state, { enforced: true, wf: null, lanes: [], busy: new Set(), running: new Set(), leased: new Set(), deliveries: [], calls: [] })
})

const E1 = agentActor('E1')
const AGENTS: AgentDef[] = [
  { id: 'B1', name: 'B1', workflowRole: 'builder' },
  { id: 'B2', name: 'B2', workflowRole: 'builder' },
  { id: 'R1', name: 'R1', workflowRole: 'reviewer' },
  { id: 'R2', name: 'R2', workflowRole: 'reviewer' }
] as AgentDef[]

/** The workspace the pass is given: its folder, its project's agents. */
const wsOf = (e: Env, agents: AgentDef[] = AGENTS) => ({ path: e.home, lifetime: { aborted: false }, projectConfig: async () => ({ agents }) }) as never

/** A lane of the store, reviewed by the pool (its `extra`, as lanes.ts keeps it) or by its own reviewer; and the app's record of it. */
function lane(e: Env, id: string, cards: number[], builder: string, reviewer: string | null): void {
  e.wf.startLane(id, cards, reviewer ?? undefined)
  const db = new DatabaseSync(boardFile(e.home))
  try {
    db.prepare('UPDATE lanes SET builder_id = ?, builder_name = ?, extra = ? WHERE id = ?').run(builder, builder, reviewer ? null : '{"pool":true}', id)
  } finally {
    db.close()
  }
  const t = new Date().toISOString()
  state.lanes.push({ id, project: 'project', name: null, builder: { id: builder, name: builder }, reviewer: reviewer ? { id: reviewer, name: reviewer } : null, cards, rounds: 10, waitMinutes: 360, state: 'active', startedBy: 'the user', startedAt: t, updatedAt: t, endedAt: null, mergeCommit: null, ...(reviewer ? {} : { pool: true as const }) })
}

/** A card built by `by` and submitted: in a slot of its own (G11 = slots), or with a trailer in the project folder. */
async function submitted(e: Env, card: { id: number; key: string; title: string }, by = B1): Promise<void> {
  if (e.options.folder === 'slots') {
    const slot = join(tempDir('slot-'), 'slot')
    sh(e.project, 'worktree', 'add', '-q', '-b', `hive/am/am-${card.id}`, slot, 'main')
    e.wf.cfg.slotFor = async () => ({ slot: 'slot', folder: slot, lease: `l-${card.id}`, fresh: true })
    moved(await e.wf.start(card.key, by))
    commit(slot, { [`${card.id}.txt`]: `${card.title}\n` }, card.title)
  } else {
    moved(await e.wf.start(card.key, by))
    commit(e.project, { [`${card.id}.txt`]: `${card.title}\n` }, card.title, { trailer: card.key })
    await attributeFolder(e.wf)
  }
  moved(await e.wf.submit(card.key, by, { summary: card.title }))
}

const assignedTo = (e: Env, n: number): string[] => e.store.facts(n).filter((f) => f.kind === 'ReviewerAssigned').map((f) => (f.data as { reviewer: string }).reviewer)
const pass = (e: Env, agents?: AgentDef[]): Promise<void> => settleReviewerPool(wsOf(e, agents), e.project)
/** The wakes and pool asks a submission left to run (the harness doesn't run them: autoRun off). */
const pending = (e: Env): { kind: string; agent?: unknown }[] => e.store.pendingActions().map((a) => ({ kind: a.kind, agent: a.payload.agent }))

/** Pair's options with these, made to hold together: Hive merges in slots, Committed is done in the project folder. */
const optionsFor = (reviewers: 1 | 2, reviewerMode: 'lane' | 'pool', folder: 'slots' | 'project'): WorkflowOptions => ({ ...preset('git', 'pair'), preChecks: [], mergeChecks: [], target: 'main', reviewers, reviewerMode, folder, finish: folder === 'slots' ? 'hiveMerges' : 'committed', identity: null, stopOwnRuns: false })

describe('the option G17 (#1443)', () => {
  it('is reviewerMode, lane or pool: one per lane in every Git preset, none for None', () => {
    expect(takesOption('reviewerMode', 'lane')).toBe(true)
    expect(takesOption('reviewerMode', 'pool')).toBe(true)
    expect(takesOption('reviewerMode', 'pools')).toBe(false)
    for (const id of ['solo', 'pair', 'pairAgent', 'team'] as const) expect(preset('git', id).reviewerMode).toBe('lane')
    for (const id of ['solo', 'pair', 'team'] as const) expect(preset('none', id)).not.toHaveProperty('reviewerMode')
    // None has no G17: a level setting it there can't be read.
    expect(resolveOptions('none', { project: { reviewerMode: 'pool' } }).invalid).toMatch(/unknown option reviewerMode/)
    expect(resolveOptions('git', { project: { review: 'agent', noSelfReview: true, reviewerMode: 'pool' } })).toMatchObject({ invalid: null, options: { reviewerMode: 'pool' }, origins: { reviewerMode: 'project' } })
  })

  it('needs a reviewer agent', () => {
    expect(contradictions({ ...allOff('git'), reviewerMode: 'pool' })).toEqual(['poolNeedsAgent'])
    expect(contradictions({ ...allOff('git'), review: 'you', reviewerMode: 'pool' })).toEqual(['poolNeedsAgent'])
    expect(contradictions({ ...allOff('git'), review: 'agent', noSelfReview: true, reviewerMode: 'pool' })).toEqual([])
  })

  it("is in the ruleset: a pool changes its id, one per lane doesn't (a ruleset from before P7 has none and reads as lane)", () => {
    const pair = preset('git', 'pair')
    const { reviewerMode: _m, ...before } = pair
    const perLane = compile(pair)
    const old = compile(before as WorkflowOptions)
    const pool = compile({ ...pair, reviewerMode: 'pool' })
    if (!perLane.ok || !old.ok || !pool.ok) throw new Error('compiles')
    expect(perLane.ruleset.id).toBe(old.ruleset.id)
    expect(perLane.ruleset.options).not.toHaveProperty('reviewerMode')
    expect(pool.ruleset.id).not.toBe(perLane.ruleset.id)
    expect(pool.ruleset.options.reviewerMode).toBe('pool')
    const loaded = loadRuleset(JSON.parse(JSON.stringify(old.ruleset)))
    if (!loaded.ok) throw new Error('loads')
    expect(reviewerModeOf(loaded.ruleset.options)).toBe('lane')
  })

  it("leaves G1b's reviewers as they were: its key, values and saved data read the same", () => {
    for (const reviewers of [1, 2] as const) {
      const r = resolveOptions('git', { project: { review: 'agent', noSelfReview: true, reviewers } })
      expect(r).toMatchObject({ invalid: null, options: { reviewers, reviewerMode: 'lane' } })
    }
    expect(takesOption('reviewers', 2)).toBe(true)
    expect(takesOption('reviewers', 'pool')).toBe(false)
    expect(contradictions({ ...allOff('git'), reviewers: 2 })).toEqual(['quorumNeedsAgent'])
  })
})

describe("the pool's choice (#1443)", () => {
  const card = (n: number, at: string, o: Partial<PoolCard> = {}): PoolCard => ({ card: n, submission: 1, submittedAt: at, pool: true, builders: ['B1'], seen: [], reviewing: null, quorum: 1, passes: 0, ...o })
  const agent = (id: string, o: Partial<PoolAgent> = {}): PoolAgent => ({ id, role: 'reviewer', leased: false, idle: true, ...o })

  it('gives the oldest submission first, each to a different free reviewer, never its builder', () => {
    const got = poolAssignments([card(3, '2026-10-23T10:02:00Z'), card(1, '2026-10-23T10:00:00Z', { builders: ['B1', 'R1'] }), card(2, '2026-10-23T10:01:00Z')], [agent('R1'), agent('R2')])
    expect(got).toEqual([
      { card: 1, submission: 1, reviewer: 'R2' },
      { card: 2, submission: 1, reviewer: 'R1' }
    ])
  })

  it('none free: the card waits; one reviewing another card, busy, or a builder only, is never free', () => {
    expect(poolAssignments([card(1, 'a')], [agent('R1', { idle: false }), agent('B2', { role: 'builder' })])).toEqual([])
    expect(poolAssignments([card(1, 'a', { pool: false, reviewing: 'R1' }), card(2, 'b')], [agent('R1')])).toEqual([])
    expect(poolAssignments([card(1, 'a', { reviewing: 'R1' })], [agent('R2')])).toEqual([])
  })

  it('an either agent with an open dispatch lease is never given one, and is once its lease ends', () => {
    expect(poolAssignments([card(1, 'a')], [agent('E1', { role: 'either', leased: true })])).toEqual([])
    expect(poolAssignments([card(1, 'a')], [agent('E1', { role: 'either' })])).toEqual([{ card: 1, submission: 1, reviewer: 'E1' }])
  })

  it('with G1b = 2, the second reviewer is another agent, given once the first has passed', () => {
    expect(poolAssignments([card(1, 'a', { quorum: 2, passes: 1, seen: ['R1'] })], [agent('R1'), agent('R2')])).toEqual([{ card: 1, submission: 1, reviewer: 'R2' }])
    expect(poolAssignments([card(1, 'a', { quorum: 2, passes: 2, seen: ['R1', 'R2'] })], [agent('R1'), agent('R2')])).toEqual([])
  })

  it("reads a submission's reviewers from its facts: given or started, freed by a verdict", () => {
    const f = (seq: number, kind: string, reviewer: string, submission = 5) => ({ seq, kind, data: { reviewer, submission } })
    const known = (id: string) => id !== 'gone'
    expect(submissionReviewers([f(6, 'ReviewerAssigned', 'R1')], 5, known)).toEqual({ seen: ['R1'], reviewing: 'R1' })
    expect(submissionReviewers([f(6, 'ReviewerAssigned', 'R1'), f(7, 'ReviewStarted', 'R1'), f(8, 'Verdict', 'R1')], 5, known)).toEqual({ seen: ['R1'], reviewing: null })
    // An earlier submission's, or an agent removed since, doesn't hold the card.
    expect(submissionReviewers([f(3, 'ReviewerAssigned', 'R1', 2), f(6, 'ReviewerAssigned', 'gone')], 5, known)).toEqual({ seen: ['gone'], reviewing: null })
  })
})

describe("the pool's pass (#1443)", { timeout: 60_000 }, () => {
  it.each([1, 2] as const)('G1b %i × G17 × G11: every cell valid, each card reviewed by its lane reviewer or the pool', async (reviewers) => {
    for (const reviewerMode of ['lane', 'pool'] as const)
      for (const folder of ['slots', 'project'] as const) {
        const o = optionsFor(reviewers, reviewerMode, folder)
        const cell = `${reviewers} × ${reviewerMode} × ${folder}`
        expect(contradictions(o), cell).toEqual([])
        const e = (env = setup({ ...o, platform: 'git' }, { autoRun: false }))
        state.wf = e.wf
        state.lanes = []
        const card = e.wf.createCard({ title: `Cell ${cell}` })
        const n = card.id
        lane(e, 'L', [n], 'B1', reviewerMode === 'lane' ? 'R1' : null)
        await submitted(e, card)
        if (reviewerMode === 'lane') {
          expect(pending(e), cell).toContainEqual({ kind: 'wake', agent: 'R1' })
          expect(pending(e).map((a) => a.kind), cell).not.toContain('assignReviewer')
        } else {
          // No lane reviewer to wake: the pool's pass gives it to one.
          expect(pending(e).filter((a) => a.kind === 'wake'), cell).toEqual([])
          expect(pending(e).map((a) => a.kind), cell).toContain('assignReviewer')
          await pass(e)
          expect(assignedTo(e, n), cell).toEqual(['R1'])
          moved(await e.wf.verdict(e.store.card(n).key, R1, { pass: true, comment: 'ok', startReview: true }))
          await pass(e)
          // G1b = 2: a second, other reviewer; with one, the card has moved on.
          expect(assignedTo(e, n), cell).toEqual(reviewers === 2 ? ['R1', 'R2'] : ['R1'])
          if (reviewers === 2) {
            moved(await e.wf.verdict(e.store.card(n).key, R2, { pass: true, comment: 'ok', startReview: true }))
            expect(e.wf.state(e.store.card(n)).stage, cell).not.toBe('review')
          }
        }
        e.close()
        env = null
      }
  })

  it('two lanes on one pool: oldest first, a different reviewer each, told once; a third waits until a verdict frees one', async () => {
    const e = (env = setup({ ...optionsFor(1, 'pool', 'project'), platform: 'git' }, { autoRun: false }))
    state.wf = e.wf
    state.running = new Set(['R1'])
    const [a, b, c] = ['One', 'Two', 'Three'].map((t) => e.wf.createCard({ title: t }))
    lane(e, 'L1', [a.id, c.id], 'B1', null)
    lane(e, 'L2', [b.id], 'B2', null)
    await submitted(e, a, B1)
    await submitted(e, b, B2)
    await pass(e)
    expect([assignedTo(e, a.id), assignedTo(e, b.id)]).toEqual([['R1'], ['R2']])
    // R1 runs: typed into its conversation; R2 doesn't: launched for review. Each once, however often the pass runs.
    await pass(e)
    expect(state.calls).toEqual(['typed to R1', 'start R2 for review'])
    expect(state.deliveries.map((d) => d.body)).toEqual([expect.stringMatching(/is in Review: you review it from the pool/), expect.stringMatching(/is in Review: you review it from the pool/)])
    expect(poolReviewerOf(e.store.facts(a.id))).toBe('R1')
    // A third: nobody free.
    moved(await e.wf.verdict(a.key, R1, { pass: true, comment: 'ok', startReview: true }))
    await submitted(e, c, B1)
    state.busy = new Set(['R1'])
    await pass(e)
    expect(assignedTo(e, c.id)).toEqual([])
    // R1's verdict freed it; once its turn ends, it takes the third.
    state.busy = new Set()
    await pass(e)
    expect(assignedTo(e, c.id)).toEqual(['R1'])
  })

  it('never gives a reviewer its own card, nor one to an either agent building in a slot until its lease ends', async () => {
    const e = (env = setup({ ...optionsFor(1, 'pool', 'project'), platform: 'git' }, { autoRun: false }))
    state.wf = e.wf
    const agents = [{ id: 'B1', name: 'B1', workflowRole: 'builder' }, { id: 'E1', name: 'E1', workflowRole: 'either' }] as AgentDef[]
    const [mine, theirs] = ['Mine', 'Theirs'].map((t) => e.wf.createCard({ title: t }))
    lane(e, 'L1', [mine.id], 'E1', null)
    lane(e, 'L2', [theirs.id], 'B1', null)
    await submitted(e, mine, E1)
    await pass(e, agents)
    // E1 built it: nobody else reviews, so it waits.
    expect(assignedTo(e, mine.id)).toEqual([])
    state.leased = new Set(['E1'])
    await submitted(e, theirs, B1)
    await pass(e, agents)
    expect(assignedTo(e, theirs.id)).toEqual([])
    state.leased = new Set()
    await pass(e, agents)
    expect(assignedTo(e, theirs.id)).toEqual(['E1'])
    expect(assignedTo(e, mine.id)).toEqual([])
  })

  it('with workflow rules off, nothing is assigned or told', async () => {
    const e = (env = setup({ ...optionsFor(1, 'pool', 'project'), platform: 'git' }, { autoRun: false }))
    state.wf = e.wf
    const a = e.wf.createCard({ title: 'Off' })
    lane(e, 'L1', [a.id], 'B1', null)
    await submitted(e, a, B1)
    state.enforced = false
    await pass(e)
    expect(assignedTo(e, a.id)).toEqual([])
    expect(state.calls).toEqual([])
    state.enforced = true
    await pass(e)
    expect(assignedTo(e, a.id)).toEqual(['R1'])
  })

  it("a lane's own reviewer reviewing its card isn't free for the pool", async () => {
    const e = (env = setup({ ...optionsFor(1, 'pool', 'project'), platform: 'git' }, { autoRun: false }))
    state.wf = e.wf
    const [own, pooled] = ['Own', 'Pooled'].map((t) => e.wf.createCard({ title: t }))
    lane(e, 'L1', [own.id], 'B1', 'R1')
    lane(e, 'L2', [pooled.id], 'B2', null)
    await submitted(e, own, B1)
    moved(await e.wf.startReview(own.key, R1))
    await submitted(e, pooled, B2)
    await pass(e, AGENTS.filter((a) => a.id !== 'R2'))
    expect(assignedTo(e, pooled.id)).toEqual([])
  })
})
