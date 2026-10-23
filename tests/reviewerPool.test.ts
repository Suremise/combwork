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
  deliveries: [] as { id: string; agentId: string; source?: string; ref?: string; state: string; body: string }[],
  /** The next deliveries: given, or not (its agent got busy: cancelled). */
  next: [] as ('given' | 'notGiven')[],
  calls: [] as string[]
}))

vi.mock('../src/main/workflow/service', async (orig) => ({ ...(await orig<object>()), workflowEnforced: () => state.enforced, agentRunsGoing: () => [], workflowFor: async () => state.wf }))
vi.mock('../src/main/workflow/lineUpdates', async (orig) => ({ ...(await orig<object>()), agentBusy: (_p: string, a: string) => state.busy.has(a) }))
vi.mock('../src/main/lanes', async (orig) => ({ ...(await orig<object>()), rawLanes: async () => state.lanes }))
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
    const r = { id: `m${++seq}`, agentId: nd.agentId, source: nd.source, ref: nd.ref, state: state.next.shift() === 'notGiven' ? 'cancelled' : 'offered', body: nd.body }
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
  Object.assign(state, { enforced: true, wf: null, lanes: [], busy: new Set(), running: new Set(), deliveries: [], next: [], calls: [] })
})

const E1 = agentActor('E1')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000
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

/** Runs SQL on the workspace's hive.db on a connection of its own, as another Hive (or the slots' own writes) would. */
function onDb<T>(e: Env, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(boardFile(e.home))
  try {
    db.exec('PRAGMA foreign_keys = ON')
    return fn(db)
  } finally {
    db.close()
  }
}

let slotNo = 0
/** An agent's dispatch lease of the project's slots (a lane's), taken or ended, in hive.db's slot tables as #1429 keeps them. */
function lease(e: Env, agent: string, open: boolean): void {
  onDb(e, (db) => {
    const at = new Date().toISOString()
    if (!open) return void db.prepare('UPDATE slot_leases SET ended_at = ?, why = ? WHERE project = ? AND agent = ? AND ended_at IS NULL').run(at, 'test', 'project', agent)
    const name = `slot-${++slotNo}`
    db.prepare("INSERT INTO slots (project, name, folder, state, port_base, created_at, used_at) VALUES (?, ?, ?, 'lent', ?, ?, ?)").run('project', name, join(e.home, 'slots', name), 50000 + slotNo * 10, at, at)
    db.prepare("INSERT INTO slot_leases (id, project, slot, kind, lane, agent, from_at) VALUES (?, ?, ?, 'lane', ?, ?, ?)").run(`lease-${slotNo}`, 'project', name, `lane-${agent}`, agent, at)
  })
}

/**
 * The runtime the pass is given, with `before` run once just before its next write (an assignment's, or a release's):
 * another connection's change landing between the pass's reading and its write.
 */
function withBoundary(e: Env, before: () => void | Promise<void>): unknown {
  let once: (() => void | Promise<void>) | null = before
  const wf = Object.create(e.wf) as typeof e.wf
  wf.write = (async (...args: Parameters<typeof e.wf.write>) => {
    const hook = once
    once = null
    await hook?.()
    return e.wf.write(...args)
  }) as typeof e.wf.write
  return wf
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
const optionsFor = (reviewers: 1 | 2, reviewerMode: 'lane' | 'pool', folder: 'slots' | 'project'): WorkflowOptions => ({ ...preset('git', 'pair'), preChecks: [], mergeChecks: [], target: 'main', reviewers, reviewerMode, folder, slotsUpToDate: folder === 'slots', finish: folder === 'slots' ? 'hiveMerges' : 'committed', identity: null, stopOwnRuns: false })

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
    lease(e, 'E1', true)
    await submitted(e, theirs, B1)
    await pass(e, agents)
    expect(assignedTo(e, theirs.id)).toEqual([])
    lease(e, 'E1', false)
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

  it("an agent's review started on another connection just before the assignment's write: not given that card too (HR3's round 1)", async () => {
    const e = (env = setup({ ...optionsFor(1, 'pool', 'project'), platform: 'git' }, { autoRun: false }))
    const agents = AGENTS.filter((a) => a.id !== 'R2')
    const [a, b] = ['First', 'Second'].map((t) => e.wf.createCard({ title: t }))
    lane(e, 'L1', [a.id], 'B1', null)
    lane(e, 'L2', [b.id], 'B2', null)
    await submitted(e, a, B1)
    await submitted(e, b, B2)
    // The pass plans A for R1 (the only reviewer, free as it reads); R1 starts B's review on another connection first.
    const other = e.another()
    state.wf = withBoundary(e, async () => void moved(await other.startReview(b.key, R1)))
    await pass(e, agents)
    expect(assignedTo(e, a.id)).toEqual([])
    expect(state.calls).toEqual([])
    // Its verdict frees it: A is given to R1 then.
    state.wf = e.wf
    moved(await e.wf.verdict(b.key, R1, { pass: true, comment: 'ok' }))
    await pass(e, agents)
    expect(assignedTo(e, a.id)).toEqual(['R1'])
  })

  it("a dispatch lease taken just before the assignment's write, or one that can't be read: never given (HR3's round 1)", async () => {
    const e = (env = setup({ ...optionsFor(1, 'pool', 'project'), platform: 'git' }, { autoRun: false }))
    const agents = [{ id: 'B1', name: 'B1', workflowRole: 'builder' }, { id: 'E1', name: 'E1', workflowRole: 'either' }] as AgentDef[]
    const a = e.wf.createCard({ title: 'Raced' })
    lane(e, 'L1', [a.id], 'B1', null)
    await submitted(e, a, B1)
    state.wf = withBoundary(e, () => lease(e, 'E1', true))
    await pass(e, agents)
    expect(assignedTo(e, a.id)).toEqual([])
    lease(e, 'E1', false)
    // The slots' table unreadable: nobody counts as free.
    const unreadable = Object.create(e.wf) as typeof e.wf
    Object.defineProperty(unreadable, 'store', { value: Object.assign(Object.create(e.store), { dispatchLeased: () => null }) })
    state.wf = unreadable
    await pass(e, agents)
    expect(assignedTo(e, a.id)).toEqual([])
    state.wf = e.wf
    await pass(e, agents)
    expect(assignedTo(e, a.id)).toEqual(['E1'])
  })

  it("a review outside any lane, or in a lane that has ended, keeps its reviewer from the pool (HR3's round 1)", async () => {
    const e = (env = setup({ ...optionsFor(1, 'pool', 'project'), platform: 'git' }, { autoRun: false }))
    state.wf = e.wf
    const agents = AGENTS.filter((a) => a.id !== 'R2')
    state.running = new Set(['R1'])
    const [loose, ended, pooled] = ['Loose', 'Ended lane', 'Pooled'].map((t) => e.wf.createCard({ title: t }))
    await submitted(e, loose, B2)
    moved(await e.wf.startReview(loose.key, R1))
    lane(e, 'L1', [pooled.id], 'B1', null)
    await submitted(e, pooled, B1)
    await pass(e, agents)
    expect(assignedTo(e, pooled.id)).toEqual([])
    moved(await e.wf.verdict(loose.key, R1, { pass: true, comment: 'ok' }))
    // Now one in a lane that has ended: R1 on its card, still not free.
    lane(e, 'L0', [ended.id], 'B2', 'R1')
    await submitted(e, ended, B2)
    moved(await e.wf.startReview(ended.key, R1))
    state.lanes = state.lanes.filter((l) => l.id !== 'L0')
    onDb(e, (db) => db.prepare("UPDATE lanes SET state = 'ended', ended_at = ? WHERE id = 'L0'").run(new Date().toISOString()))
    await pass(e, agents)
    expect(assignedTo(e, pooled.id)).toEqual([])
    expect(state.calls).toEqual([])
    moved(await e.wf.verdict(ended.key, R1, { pass: true, comment: 'ok' }))
    await pass(e, agents)
    expect(assignedTo(e, pooled.id)).toEqual(['R1'])
  })

  it('an agent given a card that takes a dispatch lease before it is told is released, and the card given again', async () => {
    const e = (env = setup({ ...optionsFor(1, 'pool', 'project'), platform: 'git' }, { autoRun: false }))
    state.wf = e.wf
    const agents = [{ id: 'B1', name: 'B1', workflowRole: 'builder' }, { id: 'E1', name: 'E1', workflowRole: 'either' }, { id: 'R1', name: 'R1', workflowRole: 'reviewer' }] as AgentDef[]
    const a = e.wf.createCard({ title: 'Released' })
    lane(e, 'L1', [a.id], 'B1', null)
    await submitted(e, a, B1)
    // E1 (first in the project's order) is given it; its delivery isn't given (it got busy).
    state.running = new Set(['E1'])
    state.next = ['notGiven']
    await pass(e, agents)
    expect(assignedTo(e, a.id)).toEqual(['E1'])
    // E1 starts building in a slot before it is told: released, and R1 is given the card.
    lease(e, 'E1', true)
    await pass(e, agents)
    const sub = e.wf.state(e.store.card(a.id)).latest!.id
    expect(e.store.facts(a.id).filter((f) => f.kind === 'ReviewerReleased').map((f) => f.data)).toEqual([{ reviewer: 'E1', submission: sub, why: 'leased' }])
    await vi.waitFor(() => expect(assignedTo(e, a.id)).toEqual(['E1', 'R1']), { timeout: HUNG_MS })
    expect(poolReviewerOf(e.store.facts(a.id))).toBe('R1')
  })

  it.each([
    ['offered, its reviewer running', 'offered', true, 'typed to E1'],
    ['acked, its reviewer stopped since', 'acked', false, 'start E1 for review']
  ] as const)("a reviewer released and given the same submission again is told again, once (its first delivery %s: HR3's round 2)", async (_what, was, running, told) => {
    const e = (env = setup({ ...optionsFor(1, 'pool', 'project'), platform: 'git' }, { autoRun: false }))
    state.wf = e.wf
    const agents = [{ id: 'B1', name: 'B1', workflowRole: 'builder' }, { id: 'E1', name: 'E1', workflowRole: 'either' }] as AgentDef[]
    const a = e.wf.createCard({ title: 'Again' })
    lane(e, 'L1', [a.id], 'B1', null)
    await submitted(e, a, B1)
    state.running = new Set(['E1'])
    await pass(e, agents)
    expect([assignedTo(e, a.id), state.calls]).toEqual([['E1'], ['typed to E1']])
    state.deliveries[0].state = was
    // E1 takes a lease before it starts the review: released, and nobody else is free.
    lease(e, 'E1', true)
    await pass(e, agents)
    expect(e.store.facts(a.id).map((f) => f.kind).filter((k) => k.startsWith('Reviewer'))).toEqual(['ReviewerAssigned', 'ReviewerReleased'])
    // Its lease ends (and, with its delivery read, it has stopped): given again, and told again, once.
    lease(e, 'E1', false)
    if (!running) state.running = new Set()
    await pass(e, agents)
    await pass(e, agents)
    expect(assignedTo(e, a.id)).toEqual(['E1', 'E1'])
    expect(state.calls).toEqual(['typed to E1', told])
    expect(new Set(state.deliveries.map((d) => d.ref)).size).toBe(2)
  })
})
