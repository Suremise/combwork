// The reviewer pool (#1443, G17): the option (`reviewerMode`, never G1b's `reviewers`) and its ruleset, who the pool
// gives a card to (oldest first, never its builder, never an agent building in a slot, a second one with G1b = 2), and
// the app's pass: assigned in a write, told once, freed by a verdict, nothing with the rules off.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'path'
import { B1, B2, commit, moved, R1, R2, refusedBy, setup, sh, type Env } from './workflow/harness'
import { tempDir } from './tempDir'
import { boardFile } from '../src/main/boardStore'
import { attributeFolder } from '../src/main/workflow/reconcile'
import { compile, loadRuleset } from '../src/shared/workflow/compile'
import { agentActor } from '../src/shared/workflow/facts'
import { allOff, contradictions, preset, reviewerModeOf, takesOption, type WorkflowOptions } from '../src/shared/workflow/options'
import { designReviewer, heldOnUser, openDesign, poolAssignments, preferredReviewer, reviewingNow, reviewsInProgress, submissionReviewers, type PoolAgent, type PoolCard } from '../src/shared/workflow/reviewerPool'
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
  /** A running agent's status, where not its turn's (`busy`: working, else ready): a watch, a sign-in… (HI-2333). */
  status: new Map<string, string>(),
  /** Running agents with background tasks, and agents with runs going (HI-2333). */
  background: new Set<string>(),
  runs: new Set<string>(),
  /** Agents with a line typed or queued for them, at their prompt (`agentBusy`, HI-2333). */
  pending: new Set<string>(),
  /** Running agents whose hooks aren't arriving: `readyFor` refuses them a line (HI-2333). */
  hooksMissing: new Set<string>(),
  /** Running with its old side's tools (HI-2664: made a reviewer, not restarted since): sessions.sideAllows false. */
  oldTools: new Set<string>(),
  deliveries: [] as { id: string; agentId: string; source?: string; ref?: string; state: string; body: string }[],
  /** The next deliveries: given, or not (its agent got busy: cancelled). */
  next: [] as ('given' | 'notGiven')[],
  /** Agents whose every line is refused at the delivery's boundary until taken out (HI-2343: a persistent refusal). */
  refuse: new Set<string>(),
  /** Told of each refused line, as the real delivery's inbox change emits its agent's status (HI-2343). */
  onRefused: null as null | ((agentId: string) => void),
  calls: [] as string[],
  /** Awaited as a stopped agent's launch prepares, before its `allowed` (HI-2046: a change landing meanwhile). */
  beforeSpawn: null as null | (() => void | Promise<void>),
  /** The timer suite drives this board's changes explicitly; its stand-alone fact store also triggers the DB poll. */
  manualBoard: null as string | null
}))

vi.mock('../src/main/events', async (orig) => {
  const actual = await orig<typeof import('../src/main/events')>()
  return {
    ...actual,
    emit: (event: Parameters<typeof actual.emit>[0]) => {
      // HI-2455: the harness writes facts on another connection, unlike the app's board-owned runtime. Its poll is
      // an extra board change, not a retry. Only the clock suite supplies those changes itself (without a path).
      if (event.type === 'tasks-changed' && event.workspacePath === state.manualBoard) return
      actual.emit(event)
    }
  }
})

vi.mock('../src/main/workflow/service', async (orig) => ({ ...(await orig<object>()), workflowEnforced: () => state.enforced, agentRunsGoing: (_p: string, a: string) => (state.runs.has(a) ? [{}] : []), workflowFor: async () => state.wf }))
vi.mock('../src/main/workflow/lineUpdates', async (orig) => ({ ...(await orig<object>()), agentBusy: (_p: string, a: string) => state.busy.has(a) || state.pending.has(a) }))
vi.mock('../src/main/lanes', async (orig) => ({ ...(await orig<object>()), rawLanes: async () => state.lanes }))
vi.mock('../src/main/projectKeys', async (orig) => ({ ...(await orig<object>()), withCardNames: (_ws: unknown, fn: () => string) => fn() }))
vi.mock('../src/main/sessions', async (orig) => {
  const actual = await orig<typeof import('../src/main/sessions')>()
  const stub = {
    sideAllows: (_p: string, a: string) => !state.oldTools.has(a),
    liveFor: (_p: string, a: string) => (state.running.has(a) ? { status: state.status.get(a) ?? (state.busy.has(a) ? 'working' : 'ready'), sessionId: `s-${a}`, cwd: '', ...(state.hooksMissing.has(a) ? { hooksMissing: true } : {}) } : null),
    agentNow: (_p: string, a: string) => (state.running.has(a) ? { status: state.status.get(a) ?? (state.busy.has(a) ? 'working' : 'ready'), pending: false, backgroundTasks: state.background.has(a) ? 1 : 0 } : null),
    // As the real one: its `allowed` just before it spawns, after its own awaits (HI-2046).
    start: async (_p: string, o: { agentId: string; prompt?: string; purpose?: string; allowed?: () => void }) => {
      await state.beforeSpawn?.()
      o.allowed?.()
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
    const refused = state.next.shift() === 'notGiven' || state.refuse.has(nd.agentId)
    const r = { id: `m${++seq}`, agentId: nd.agentId, source: nd.source, ref: nd.ref, state: refused ? 'cancelled' : 'offered', body: nd.body }
    state.deliveries.push(r)
    if (refused) state.onRefused?.(nd.agentId)
    return r
  }
  return {
    ...actual,
    deliveriesOf: async (_h: string, a: string) => state.deliveries.filter((r) => r.agentId === a).map((r) => ({ ...r })),
    // Its producer's check (`holds`) asked, as the real one asks it before each key (HI-2046).
    deliverNow: async (_h: string, nd: { agentId: string; source?: string; ref?: string; body: string }, holds?: () => boolean) => {
      if (holds && !holds()) return null
      state.calls.push(`typed to ${nd.agentId}`)
      return make(nd)
    },
    launchWith: async (_h: string, nd: { agentId: string; source?: string; ref?: string; body: string }, start: (line: string) => Promise<unknown>) => ({ record: make(nd), launched: await start(nd.body) })
  }
})

const { settleReviewerPool, poolStateKey, poolTestHooks, startReviewerPool, stopReviewerPool } = await import('../src/main/reviewerPool')
const { emit } = await import('../src/main/events')
const { createWorkspaceService } = await import('../src/main/workspace')
const { poolReviewerOf } = await import('../src/main/loopReviewer')
const { resolveOptions } = await import('../src/main/workflow/rulesets')

let env: Env | null = null
afterEach(() => {
  for (const life of lives) life.abort()
  lives.clear()
  env?.close()
  env = null
  Object.assign(state, { enforced: true, wf: null, lanes: [], busy: new Set(), running: new Set(), status: new Map(), background: new Set(), runs: new Set(), pending: new Set(), hooksMissing: new Set(), oldTools: new Set(), deliveries: [], next: [], refuse: new Set(), onRefused: null, calls: [], beforeSpawn: null, manualBoard: null })
  // Nothing armed by this test outlives it (HI-2360).
  expect(poolTestHooks.retriesPending()).toBe(0)
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
const wsOf = (e: Env, agents: AgentDef[] = AGENTS, life = new AbortController()) => (lives.add(life), { path: e.home, lifetime: life.signal, projectConfig: async () => ({ agents }) }) as never
/**
 * Every lifetime `wsOf` gave a pass, ended after its test (HI-2360): a retry a refused line armed (HI-2333) belongs to
 * its workspace's lifetime, and one left armed would fire into a later test, whose runtime `workflowFor` hands it.
 */
const lives = new Set<AbortController>()

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

/** Runs SQL on the workspace's combwork.db on a connection of its own, as another Combwork (or the slots' own writes) would. */
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
/** An agent's dispatch lease of the project's slots (a lane's), taken or ended, in combwork.db's slot tables as #1429 keeps them. */
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
    sh(e.project, 'worktree', 'add', '-q', '-b', `cw/am/am-${card.id}`, slot, 'main')
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

/** Pair's options with these, made to hold together: Combwork merges in slots, Committed is done in the project folder. */
const optionsFor = (reviewers: 1 | 2, reviewerMode: 'lane' | 'pool', folder: 'slots' | 'project'): WorkflowOptions => ({ ...preset('git', 'pair'), preChecks: [], mergeChecks: [], target: 'main', reviewers, reviewerMode, folder, slotsUpToDate: folder === 'slots', finish: folder === 'slots' ? 'combworkMerges' : 'committed', identity: null, stopOwnRuns: false })

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

  it("a submission's reviews in progress (HI-2487): started with no verdict, by an agent still here, oldest first and since its first start", () => {
    const f = (seq: number, kind: string, reviewer: string, at: string, submission = 5) => ({ seq, kind, at, data: { reviewer, submission } })
    const here = (id: string) => id !== 'gone'
    const facts = [f(6, 'ReviewerAssigned', 'R1', 't6'), f(7, 'ReviewStarted', 'R1', 't7'), f(8, 'ReviewStarted', 'R2', 't8'), f(9, 'ReviewStarted', 'R1', 't9'), f(10, 'ReviewStarted', 'gone', 't10'), f(11, 'ReviewStarted', 'user', 't11'), f(12, 'ReviewStarted', 'R3', 't12', 4)]
    // The user's counts, always present (HR1's round 1: a review the user took is the user's until its verdict).
    expect(reviewsInProgress(facts, 5, here)).toEqual([{ reviewer: 'R1', since: 't7' }, { reviewer: 'R2', since: 't8' }, { reviewer: 'user', since: 't11' }])
    // A verdict ends its reviewer's; one only given (not started) isn't in progress.
    expect(reviewsInProgress([...facts, f(13, 'Verdict', 'R1', 't13'), f(14, 'Verdict', 'user', 't14')], 5, here)).toEqual([{ reviewer: 'R2', since: 't8' }])
    expect(reviewsInProgress([f(6, 'ReviewerAssigned', 'R1', 't6')], 5, here)).toEqual([])
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

describe('a card in Review outside a lane (HI-2046): given to a free reviewer by the same pass', { timeout: 60_000 }, () => {
  const loose = (reviewers: 1 | 2 = 1, loopWakes = true) => {
    const e = (env = setup({ ...optionsFor(reviewers, 'lane', 'project'), loopWakes, platform: 'git' }, { autoRun: false }))
    state.wf = e.wf
    return e
  }

  it('submitted with no lane: the pass is asked (no reviewer to wake), and gives it to a free reviewer, a running one first, told once that it is outside a lane', async () => {
    const e = loose()
    const a = e.wf.createCard({ title: 'Loose' })
    await submitted(e, a, B1)
    expect(pending(e).map((x) => x.kind)).toContain('assignReviewer')
    expect(pending(e).filter((x) => x.kind === 'wake')).toEqual([])
    // R2 runs, R1 doesn't: R2 is given it, though R1 comes first in the project's order.
    state.running = new Set(['R2'])
    await pass(e)
    await pass(e)
    expect(assignedTo(e, a.id)).toEqual(['R2'])
    expect(state.calls).toEqual(['typed to R2'])
    expect(state.deliveries.map((d) => d.body)).toEqual([expect.stringMatching(/is in Review, outside a lane: you review it/)])
  })

  it.each([true, false])('no reviewer running: a stopped one is started for its review, whatever Wake reviewers and builders says (loopWakes %s)', async (loopWakes) => {
    const e = loose(1, loopWakes)
    const a = e.wf.createCard({ title: `Stopped ${loopWakes}` })
    await submitted(e, a, B1)
    await pass(e)
    expect(assignedTo(e, a.id)).toEqual(['R1'])
    expect(state.calls).toEqual(['start R1 for review'])
  })

  it('never its builder; with G1b = 2, the second reviewer is another agent; oldest first, and a card nobody can take holds up none after it', async () => {
    const e = loose(2)
    const agents = [{ id: 'B1', name: 'B1', workflowRole: 'builder' }, { id: 'E1', name: 'E1', workflowRole: 'either' }, { id: 'R1', name: 'R1', workflowRole: 'reviewer' }, { id: 'R2', name: 'R2', workflowRole: 'reviewer' }] as AgentDef[]
    const [mine, theirs] = ['Mine', 'Theirs'].map((t) => e.wf.createCard({ title: t }))
    await submitted(e, mine, E1)
    await submitted(e, theirs, B1)
    await pass(e, agents.filter((x) => x.id !== 'R1' && x.id !== 'R2'))
    // Only E1 reviews here, and it built Mine: Theirs (later) is given to it all the same.
    expect([assignedTo(e, mine.id), assignedTo(e, theirs.id)]).toEqual([[], ['E1']])
    moved(await e.wf.verdict(theirs.key, E1, { pass: true, comment: 'ok', startReview: true }))
    await pass(e, agents)
    // Oldest first: Mine (submitted first) takes R1; G1b = 2: Theirs' second is another agent, R2.
    expect(assignedTo(e, mine.id)).toEqual(['R1'])
    expect(assignedTo(e, theirs.id)).toEqual(['E1', 'R2'])
  })

  it("a running lane's card isn't taken (its lane's reviewer reviews it); one whose lane has ended is", async () => {
    const e = loose()
    const [held, after] = ['Held', 'After'].map((t) => e.wf.createCard({ title: t }))
    lane(e, 'L1', [held.id], 'B1', 'R2')
    await submitted(e, held, B1)
    await pass(e)
    expect(assignedTo(e, held.id)).toEqual([])
    lane(e, 'L2', [after.id], 'B2', 'R2')
    await submitted(e, after, B2)
    state.lanes = state.lanes.filter((l) => l.id !== 'L2')
    onDb(e, (db) => db.prepare("UPDATE lanes SET state = 'ended', ended_at = ? WHERE id = 'L2'").run(new Date().toISOString()))
    await pass(e)
    expect(assignedTo(e, after.id)).toEqual(['R1'])
  })

  it('with workflow rules off, nothing is given or told', async () => {
    const e = loose()
    const a = e.wf.createCard({ title: 'Off' })
    await submitted(e, a, B1)
    state.enforced = false
    await pass(e)
    expect([assignedTo(e, a.id), state.calls]).toEqual([[], []])
  })

  it("a lane claiming it between the pass's look and its write: not given (its lane's reviewer reviews it)", async () => {
    const e = loose()
    const a = e.wf.createCard({ title: 'Claimed' })
    await submitted(e, a, B1)
    state.wf = withBoundary(e, () => lane(e, 'L1', [a.id], 'B1', 'R2'))
    await pass(e)
    expect(assignedTo(e, a.id)).toEqual([])
    expect(state.calls).toEqual([])
  })

  it("its reviewer taking a builder's lease, or a lane claiming the card, while its launch prepares: nothing spawned for it, and it is given again", async () => {
    const e = loose()
    const agents = [{ id: 'B1', name: 'B1', workflowRole: 'builder' }, { id: 'E1', name: 'E1', workflowRole: 'either' }, { id: 'R1', name: 'R1', workflowRole: 'reviewer' }] as AgentDef[]
    const a = e.wf.createCard({ title: 'Launch raced' })
    await submitted(e, a, B1)
    // E1 (stopped, first in order) is given it; as its launch prepares it starts building in a slot.
    state.beforeSpawn = () => lease(e, 'E1', true)
    await pass(e, agents)
    expect(assignedTo(e, a.id)[0]).toBe('E1')
    expect(state.calls).toEqual([])
    // The next pass releases E1 (leased) and gives the card to R1, launched for it.
    state.beforeSpawn = null
    await pass(e, agents)
    await vi.waitFor(() => expect(assignedTo(e, a.id)).toEqual(['E1', 'R1']), { timeout: HUNG_MS })
    await pass(e, agents)
    expect(state.calls).toEqual(['start R1 for review'])
  })

  it("a lane claiming it while its stopped reviewer's launch prepares: nothing spawned, and nothing given again (the lane's reviewer has it)", async () => {
    const e = loose()
    const a = e.wf.createCard({ title: 'Claimed in launch' })
    await submitted(e, a, B1)
    state.beforeSpawn = () => lane(e, 'L1', [a.id], 'B1', 'R2')
    await pass(e)
    expect(assignedTo(e, a.id)).toEqual(['R1'])
    expect(state.calls).toEqual([])
    state.beforeSpawn = null
    await pass(e)
    expect(state.calls).toEqual([])
  })

  // HR1's round 1: the launch for a delivery still on its way (a retry) carries the same guard as a first one.
  it.each(['lease', 'lane'] as const)("a retry's launch for a delivery still on its way, with a %s taken as it prepares: nothing spawned", async (what) => {
    const e = loose()
    const a = e.wf.createCard({ title: `Retry ${what}` })
    await submitted(e, a, B1)
    await pass(e)
    expect(state.calls).toEqual(['start R1 for review'])
    // R1 stopped before it took the line, which is still on its way: the next pass starts it again for it.
    state.running.clear()
    state.calls = []
    state.deliveries[0].state = 'uncertain'
    state.beforeSpawn = what === 'lease' ? () => lease(e, 'R1', true) : () => lane(e, 'L1', [a.id], 'B1', 'R2')
    await pass(e)
    expect(state.calls).toEqual([])
    // With nothing changed, a retry starts it.
    if (what === 'lease') {
      lease(e, 'R1', false)
      state.beforeSpawn = null
      await pass(e)
      expect(state.calls).toEqual(['start R1 for review'])
    }
  })

  // HR1's round 1: a follow-up keeps the reviewer it had, carried onto the new submission in the submit's own write.
  it('a follow-up keeps its reviewer: carried onto the new submission, given to nobody else, and told once, as a follow-up, when free', async () => {
    const e = loose()
    const a = e.wf.createCard({ title: 'Follow-up' })
    await submitted(e, a, B1)
    await pass(e)
    moved(await e.wf.startReview(a.key, R1))
    // R1 is busy (in its review's turn) and R2 free when the builder submits a follow-up.
    state.running = new Set(['R1', 'R2'])
    state.busy.add('R1')
    state.calls = []
    commit(e.project, { 'followup.txt': 'follow-up\n' }, 'Follow-up', { trailer: a.key })
    await attributeFolder(e.wf)
    moved(await e.wf.submit(a.key, B1, { summary: 'Follow-up ready', followUp: true }))
    const sub = e.wf.state(e.store.card(a.id)!).latest!.id
    expect(submissionReviewers(e.store.facts(a.id), sub, () => true).reviewing).toBe('R1')
    expect(pending(e).filter((x) => x.kind === 'wake')).toEqual([])
    await pass(e)
    await pass(e)
    expect(submissionReviewers(e.store.facts(a.id), sub, () => true)).toEqual({ seen: ['R1'], reviewing: 'R1' })
    expect(state.calls).toEqual([])
    // Free again: told once, to start its review again.
    state.busy.delete('R1')
    await pass(e)
    await pass(e)
    expect(state.calls).toEqual(['typed to R1'])
    expect(state.deliveries.at(-1)?.body).toMatch(/follow-up submitted for review .*Start your review again/)
  })
})

describe("a pool lane's design step (HI-2310): given out by the pool, its answerer preferred for the review", { timeout: 60_000 }, () => {
  const card = (n: number, at: string, o: Partial<PoolCard> = {}): PoolCard => ({ card: n, submission: 1, submittedAt: at, pool: true, builders: ['B1'], seen: [], reviewing: null, quorum: 1, passes: 0, ...o })
  const agent = (id: string, o: Partial<PoolAgent> = {}): PoolAgent => ({ id, role: 'reviewer', leased: false, idle: true, ...o })
  const f = (seq: number, kind: string, data: Record<string, unknown>, actor = 'combwork') => ({ seq, kind, at: `t${seq}`, actor, data })

  it('in its turn, oldest first, a card takes its preferred reviewer if free and allowed; busy or not allowed, the next free one', () => {
    // R1 listed last: the younger card still gets it, the older one the first free.
    expect(poolAssignments([card(1, 'a'), card(2, 'b', { preferred: 'R1' })], [agent('R2'), agent('R3'), agent('R1')])).toEqual([
      { card: 1, submission: 1, reviewer: 'R2' },
      { card: 2, submission: 1, reviewer: 'R1' }
    ])
    // HR1's round 1: one free reviewer, the younger card's preferred one: the older card is served first, and the younger waits.
    expect(poolAssignments([card(1, 'a'), card(2, 'b', { preferred: 'R1' })], [agent('R1')])).toEqual([{ card: 1, submission: 1, reviewer: 'R1' }])
    // The older card prefers R1 too: it takes R1, the younger the next free one.
    expect(poolAssignments([card(1, 'a', { preferred: 'R1' }), card(2, 'b', { preferred: 'R1' })], [agent('R2'), agent('R1')])).toEqual([
      { card: 1, submission: 1, reviewer: 'R1' },
      { card: 2, submission: 1, reviewer: 'R2' }
    ])
    expect(poolAssignments([card(2, 'b', { preferred: 'R1' })], [agent('R1', { idle: false }), agent('R2')])).toEqual([{ card: 2, submission: 1, reviewer: 'R2' }])
    expect(poolAssignments([card(2, 'b', { preferred: 'R1' })], [agent('R1'), agent('R2')], ['R1'])).toEqual([{ card: 2, submission: 1, reviewer: 'R2' }])
    // G1b = 2: the first reviewer, preferred, isn't the second.
    expect(poolAssignments([card(2, 'b', { preferred: 'R1', quorum: 2, passes: 1, seen: ['R1'] })], [agent('R1'), agent('R2')])).toEqual([{ card: 2, submission: 1, reviewer: 'R2' }])
  })

  it("reads a card's open design, its reviewer and the card's preferred reviewer from its facts", () => {
    const design = f(5, 'LoopStep', { step: 'design', text: 'Plan', design: 'AM-1/s5' }, B1)
    expect(openDesign([design])).toEqual({ seq: 5, at: 't5' })
    expect(designReviewer([design], () => true)).toBeNull()
    const given = [design, f(6, 'ReviewerAssigned', { reviewer: 'R2', submission: 5, design: true })]
    expect(designReviewer(given, () => true)).toBe('R2')
    // Answered, moved, submitted or replaced: no longer open.
    const answered = [...given, f(7, 'LoopStep', { step: 'gaps', text: 'x', design: 'AM-1/s5', of: 'design' }, agentActor('R2'))]
    expect(openDesign(answered)).toBeNull()
    expect(openDesign([design, f(6, 'Submitted', {})])).toBeNull()
    // Its answerer is preferred over the last verdict's reviewer; the user's answer prefers nobody by it.
    expect(preferredReviewer([...answered, f(9, 'Verdict', { reviewer: 'R1', pass: false })])).toBe('R2')
    expect(preferredReviewer([f(9, 'Verdict', { reviewer: 'R1', pass: false })])).toBe('R1')
    expect(preferredReviewer([f(9, 'Verdict', { reviewer: 'user', pass: false })])).toBeNull()
  })

  /** A pool lane's card started by B1, with its design posted: the step's id. */
  async function designed(e: Env, c: { id: number; key: string }): Promise<string> {
    moved(await e.wf.start(c.key, B1))
    const posted = await e.wf.loopStep(c.key, B1, 'design', 'The plan', { waitMinutes: 30, reviewer: async () => designReviewer(e.store.facts(c.id), () => true) })
    moved(posted)
    return (posted as { data?: Record<string, unknown> }).data?.design as string
  }

  it('posted with no reviewer yet: the pool gives it to a free one and tells it; its answer frees it; at submission it reviews the build', async () => {
    const e = (env = setup({ ...optionsFor(1, 'pool', 'project'), platform: 'git' }, { autoRun: false }))
    state.wf = e.wf
    state.running = new Set(['R1', 'R2'])
    const a = e.wf.createCard({ title: 'Designed' })
    lane(e, 'L', [a.id], 'B1', null)
    // R1 busy: R2 takes the design.
    state.busy = new Set(['R1'])
    const id = await designed(e, a)
    expect(pending(e).filter((x) => x.kind === 'wake')).toEqual([])
    expect(pending(e).map((x) => x.kind)).toContain('assignReviewer')
    await pass(e)
    await pass(e)
    expect(designReviewer(e.store.facts(a.id), () => true)).toBe('R2')
    expect(state.calls).toEqual(['typed to R2'])
    expect(state.deliveries.at(-1)?.body).toMatch(new RegExp(`posted a design for a check \\(${id}\\).*cw_loop_step`))
    // Checking the design, R2 isn't free for a card in Review meanwhile.
    const other = e.wf.createCard({ title: 'Other' })
    lane(e, 'L2', [other.id], 'B2', null)
    await submitted(e, other, B2)
    state.busy = new Set()
    await pass(e)
    expect(assignedTo(e, other.id)).toEqual(['R1'])
    // Only the design's reviewer answers it; its answer closes it.
    refusedBy(await e.wf.loopStep(a.key, R1, 'ok', 'Fine', { waitMinutes: 30, design: id, reviewer: async () => designReviewer(e.store.facts(a.id), () => true) }), 'loop.stepNotYours')
    moved(await e.wf.loopStep(a.key, R2, 'ok', 'Fine', { waitMinutes: 30, design: id, reviewer: async () => designReviewer(e.store.facts(a.id), () => true) }))
    expect(openDesign(e.store.facts(a.id))).toBeNull()
    // Submitted with R1 free too (and first among the agents): R2, its design's reviewer, reviews the build.
    moved(await e.wf.verdict(other.key, R1, { pass: true, comment: 'ok', startReview: true }))
    commit(e.project, { [`${a.id}.txt`]: 'built\n' }, 'Built', { trailer: a.key })
    await attributeFolder(e.wf)
    moved(await e.wf.submit(a.key, B1, { summary: 'Built' }))
    await pass(e)
    expect(assignedTo(e, a.id)).toEqual(['R2', 'R2'])
    expect(e.store.facts(a.id).filter((x) => x.kind === 'ReviewerAssigned').map((x) => (x.data as { design?: boolean }).design ?? false)).toEqual([true, false])
  })

  it('its preferred reviewer busy at submission: the next free one takes the build', async () => {
    const e = (env = setup({ ...optionsFor(1, 'pool', 'project'), platform: 'git' }, { autoRun: false }))
    state.wf = e.wf
    state.running = new Set(['R1', 'R2'])
    const a = e.wf.createCard({ title: 'Designed' })
    lane(e, 'L', [a.id], 'B1', null)
    state.busy = new Set(['R1'])
    const id = await designed(e, a)
    await pass(e)
    moved(await e.wf.loopStep(a.key, R2, 'ok', 'Fine', { waitMinutes: 30, design: id, reviewer: async () => designReviewer(e.store.facts(a.id), () => true) }))
    state.busy = new Set(['R2'])
    commit(e.project, { [`${a.id}.txt`]: 'built\n' }, 'Built', { trailer: a.key })
    await attributeFolder(e.wf)
    moved(await e.wf.submit(a.key, B1, { summary: 'Built' }))
    await pass(e)
    expect(assignedTo(e, a.id)).toEqual(['R2', 'R1'])
  })

  it('nobody free: the design waits for a reviewer; the builder going ahead unchecked wakes nobody and the design is never given', async () => {
    const e = (env = setup({ ...optionsFor(1, 'pool', 'project'), platform: 'git' }, { autoRun: false }))
    state.wf = e.wf
    state.running = new Set(['R1', 'R2'])
    state.busy = new Set(['R1', 'R2'])
    const a = e.wf.createCard({ title: 'Designed' })
    lane(e, 'L', [a.id], 'B1', null)
    const id = await designed(e, a)
    await pass(e)
    expect(assignedTo(e, a.id)).toEqual([])
    const before = pending(e).length
    moved(await e.wf.loopStep(a.key, B1, 'proceed', 'Building', { waitMinutes: 30, design: id, now: Date.now() + 31 * 60_000, reviewer: async () => designReviewer(e.store.facts(a.id), () => true) }))
    expect(pending(e).slice(before).filter((x) => x.kind === 'wake')).toEqual([])
    state.busy = new Set()
    await pass(e)
    expect(assignedTo(e, a.id)).toEqual([])
    expect(state.calls).toEqual([])
  })

  it("a lane with its own reviewer is unchanged: the design wakes it, and the pool isn't asked", async () => {
    const e = (env = setup({ ...optionsFor(1, 'lane', 'project'), platform: 'git' }, { autoRun: false }))
    state.wf = e.wf
    const a = e.wf.createCard({ title: 'Own reviewer' })
    lane(e, 'L', [a.id], 'B1', 'R1')
    moved(await e.wf.start(a.key, B1))
    moved(await e.wf.loopStep(a.key, B1, 'design', 'The plan', { waitMinutes: 30, reviewer: async () => 'R1' }))
    expect(pending(e)).toContainEqual({ kind: 'wake', agent: 'R1' })
    expect(pending(e).map((x) => x.kind)).not.toContain('assignReviewer')
    // With no reviewer at all (no lane reviewer, not the pool's), still refused.
    const b = e.wf.createCard({ title: 'No reviewer' })
    moved(await e.wf.start(b.key, B1))
    refusedBy(await e.wf.loopStep(b.key, B1, 'design', 'The plan', { waitMinutes: 30, reviewer: async () => null }), 'loop.noReviewer')
  })
})

describe("a reviewer whose card waits on its own question to the user is free for the pool's other cards (HI-2559)", { timeout: 60_000 }, () => {
  const card = (n: number, at: string, o: Partial<PoolCard> = {}): PoolCard => ({ card: n, submission: 1, submittedAt: at, pool: true, builders: ['B1'], seen: [], reviewing: null, quorum: 1, passes: 0, ...o })
  const agent = (id: string, o: Partial<PoolAgent> = {}): PoolAgent => ({ id, role: 'reviewer', leased: false, idle: true, ...o })

  it("the choice: a held card's reviewer is free for others, and the held card is given to nobody else", () => {
    expect(poolAssignments([card(1, 'a', { reviewing: 'R1', held: true }), card(2, 'b', { builders: ['B2'] })], [agent('R1'), agent('R2')])).toEqual([{ card: 2, submission: 1, reviewer: 'R1' }])
    // Not held: R1 is busy with card 1, so card 2 waits for another.
    expect(poolAssignments([card(1, 'a', { reviewing: 'R1' }), card(2, 'b', { builders: ['B2'] })], [agent('R1')])).toEqual([])
  })

  it("held only by an open request its reviewer asked: not another asker's, an asker-less one, or none", () => {
    expect(heldOnUser([{ asker: 'R1' }], 'R1')).toBe(true)
    expect(heldOnUser([{ asker: 'B1' }, {}], 'R1')).toBe(false)
    expect(heldOnUser([], 'R1')).toBe(false)
    expect(heldOnUser([{ asker: 'R1' }], null)).toBe(false)
    expect(heldOnUser([{ asker: 'user' }], 'user')).toBe(false)
  })

  /** One pooled reviewer R1, two pool lanes: A (B1's) in Review, R1 reviewing it; B (B2's) started. */
  async function twoLanes() {
    const e = (env = setup({ ...optionsFor(1, 'pool', 'project'), platform: 'git' }, { autoRun: false }))
    state.wf = e.wf
    state.running = new Set(['R1'])
    const agents = AGENTS.filter((x) => x.id !== 'R2')
    const a = e.wf.createCard({ title: 'Held A' })
    const b = e.wf.createCard({ title: 'Waiting B' })
    lane(e, 'LA', [a.id], 'B1', null)
    lane(e, 'LB', [b.id], 'B2', null)
    await submitted(e, a, B1)
    await pass(e, agents)
    expect(assignedTo(e, a.id)).toEqual(['R1'])
    moved(await e.wf.startReview(a.key, R1))
    moved(await e.wf.start(b.key, B2))
    const design = async () => {
      const posted = await e.wf.loopStep(b.key, B2, 'design', 'The plan', { waitMinutes: 30, reviewer: async () => designReviewer(e.store.facts(b.id), () => true) })
      moved(posted)
      return (posted as { data?: Record<string, unknown> }).data?.design as string
    }
    const designsOf = () => e.store.facts(b.id).filter((f) => f.kind === 'ReviewerAssigned' && (f.data as { design?: boolean }).design).map((f) => (f.data as { reviewer: string }).reviewer)
    const toldR1 = (re: RegExp) => state.deliveries.filter((d) => d.agentId === 'R1' && re.test(d.body))
    return { e, a, b, agents, design, designsOf, toldR1 }
  }

  it("A held on R1's open question: B's design, then B's submission, go to R1, each told once; A stays R1's throughout", async () => {
    const { e, a, b, agents, design, designsOf, toldR1 } = await twoLanes()
    const asked = await e.wf.askTheUser(a.key, R1, { kind: 'decide', text: 'Do you accept the bounded "not reproduced" conclusion?' })
    moved(asked)
    const id = await design()
    await pass(e, agents)
    await pass(e, agents)
    expect(designsOf()).toEqual(['R1'])
    expect(toldR1(new RegExp(`posted a design for a check \\(${id}\\)`))).toHaveLength(1)
    moved(await e.wf.loopStep(b.key, R1, 'ok', 'Fine', { waitMinutes: 30, design: id, reviewer: async () => designReviewer(e.store.facts(b.id), () => true) }))
    commit(e.project, { [`${b.id}.txt`]: 'built\n' }, 'Built', { trailer: b.key })
    await attributeFolder(e.wf)
    moved(await e.wf.submit(b.key, B2, { summary: 'Built' }))
    await pass(e, agents)
    await pass(e, agents)
    expect(assignedTo(e, b.id)).toEqual(['R1', 'R1'])
    expect(toldR1(new RegExp(`^#${b.id}\\b.*is in Review: you review it from the pool`))).toHaveLength(1)
    // A's question is still open, and A is still R1's: never released or given again.
    expect(e.wf.state(e.store.card(a.id)).requests.map((r) => r.asker)).toEqual(['R1'])
    expect(reviewingNow(e.store.facts(a.id), () => true)?.reviewing).toBe('R1')
    expect(assignedTo(e, a.id)).toEqual(['R1'])
    expect(e.store.facts(a.id).some((f) => f.kind === 'ReviewerReleased')).toBe(false)
    expect(toldR1(new RegExp(`^#${a.id}\\b`)).filter((d) => d.state !== 'cancelled')).toHaveLength(1)
  })

  it("controls: a question the builder asked on A, or R1's question answered, leaves R1 busy with A, and B's design waits", async () => {
    const { e, a, agents, design, designsOf } = await twoLanes()
    // R1's own question, answered: no longer open, so it holds nothing.
    moved(await e.wf.askTheUser(a.key, R1, { kind: 'decide', text: "The reviewer's question" }))
    for (const r of e.wf.state(e.store.card(a.id)).requests) moved(await e.wf.answer(a.key, r.request, 'answered', { note: 'Yes' }))
    expect(e.wf.state(e.store.card(a.id)).requests).toEqual([])
    // The builder's question on A, still open: not R1's, so it holds nothing either.
    moved(await e.wf.askTheUser(a.key, B1, { kind: 'decide', text: "The builder's question" }))
    await design()
    await pass(e, agents)
    expect(designsOf()).toEqual([])
    expect(state.deliveries.filter((d) => d.agentId === 'R1' && /posted a design/.test(d.body))).toEqual([])
    // R1 asks again, still open: held, so the waiting design goes to it.
    moved(await e.wf.askTheUser(a.key, R1, { kind: 'decide', text: "The reviewer's question, again" }))
    await pass(e, agents)
    expect(designsOf()).toEqual(['R1'])
  })
})

describe('a reviewer watching a card is free for the pool (HI-2333): only what it reviews, checks or runs holds it', { timeout: 60_000 }, () => {
  /** One reviewer, R1, as in the cli project's pool that stalled. */
  const ONE = AGENTS.filter((a) => a.id !== 'R2')
  const reviewer = (e: Env, id: number) => async () => designReviewer(e.store.facts(id), () => true)
  const poolDesign = async (e: Env, c: { id: number; key: string }) => {
    const posted = await e.wf.loopStep(c.key, B1, 'design', 'The plan', { waitMinutes: 30, reviewer: reviewer(e, c.id) })
    moved(posted)
    return (posted as { data?: Record<string, unknown> }).data?.design as string
  }
  const pooled = (e: Env, title: string, builder = 'B1') => {
    const c = e.wf.createCard({ title })
    lane(e, `L-${c.id}`, [c.id], builder, null)
    return c
  }

  it('a watching reviewer is given a submission and told once, typed at its prompt', async () => {
    const e = (env = setup({ ...optionsFor(1, 'pool', 'project'), platform: 'git' }, { autoRun: false }))
    state.wf = e.wf
    state.running = new Set(['R1'])
    state.status.set('R1', 'watching')
    const a = pooled(e, 'Watched')
    await submitted(e, a)
    await pass(e, ONE)
    await pass(e, ONE)
    expect(assignedTo(e, a.id)).toEqual(['R1'])
    expect(state.calls).toEqual(['typed to R1'])
    expect(state.deliveries.map((d) => d.body)).toEqual([expect.stringMatching(/you review it from the pool/)])
  })

  it('a watching reviewer that answered a design with gaps is given its revision, and told of it once', async () => {
    const e = (env = setup({ ...optionsFor(1, 'pool', 'project'), platform: 'git' }, { autoRun: false }))
    state.wf = e.wf
    state.running = new Set(['R1'])
    const a = pooled(e, 'Designed')
    moved(await e.wf.start(a.key, B1))
    const first = await poolDesign(e, a)
    await pass(e, ONE)
    expect(assignedTo(e, a.id)).toEqual(['R1'])
    // It watches the card (its loop's watch), then answers: still watching.
    state.status.set('R1', 'watching')
    moved(await e.wf.loopStep(a.key, R1, 'gaps', 'More, please', { waitMinutes: 30, design: first, reviewer: reviewer(e, a.id) }))
    const second = await poolDesign(e, a)
    await pass(e, ONE)
    await pass(e, ONE)
    expect(assignedTo(e, a.id)).toEqual(['R1', 'R1'])
    expect(designReviewer(e.store.facts(a.id), () => true)).toBe('R1')
    expect(state.calls).toEqual(['typed to R1', 'typed to R1'])
    expect(state.deliveries.at(-1)?.body).toContain(second)
    // Its answer to the revision is taken (CL-8's s23 was refused: nobody had been given it).
    moved(await e.wf.loopStep(a.key, R1, 'ok', 'Fine', { waitMinutes: 30, design: second, reviewer: reviewer(e, a.id) }))
  })

  it("a watching reviewer given another card's submission or open design isn't given a second", async () => {
    const e = (env = setup({ ...optionsFor(1, 'pool', 'project'), platform: 'git' }, { autoRun: false }))
    state.wf = e.wf
    state.running = new Set(['R1'])
    state.status.set('R1', 'watching')
    const [a, b] = [pooled(e, 'First'), pooled(e, 'Second', 'B2')]
    await submitted(e, a)
    await pass(e, ONE)
    await submitted(e, b, B2)
    await pass(e, ONE)
    expect([assignedTo(e, a.id), assignedTo(e, b.id)]).toEqual([['R1'], []])
    // Its verdict frees it: the second is its now.
    moved(await e.wf.verdict(a.key, R1, { pass: true, comment: 'ok', startReview: true }))
    await pass(e, ONE)
    expect(assignedTo(e, b.id)).toEqual(['R1'])
    moved(await e.wf.verdict(b.key, R1, { pass: true, comment: 'ok', startReview: true }))
    // An open design given to it holds it too.
    const d = pooled(e, 'Design')
    moved(await e.wf.start(d.key, B1))
    await poolDesign(e, d)
    await pass(e, ONE)
    expect(assignedTo(e, d.id)).toEqual(['R1'])
    const c = pooled(e, 'Third', 'B2')
    await submitted(e, c, B2)
    await pass(e, ONE)
    expect(assignedTo(e, c.id)).toEqual([])
  })

  it.each([
    ['in a turn', () => state.status.set('R1', 'working')],
    ['waiting for the user', () => state.status.set('R1', 'waiting')],
    ['with background work its status says', () => state.status.set('R1', 'background')],
    ['starting', () => state.status.set('R1', 'starting')],
    ['at a sign-in', () => state.status.set('R1', 'signin')],
    ['watching, with a line typed or queued for it', () => (state.status.set('R1', 'watching'), state.pending.add('R1'))],
    ['watching, with background tasks', () => (state.status.set('R1', 'watching'), state.background.add('R1'))],
    ['watching, with a run going', () => (state.status.set('R1', 'watching'), state.runs.add('R1'))],
    // The delivery would refuse it a line (readyFor): never given, so no pass tries again at once (HI-2333's e2e loop).
    ['watching, its hooks not arriving', () => (state.status.set('R1', 'watching'), state.hooksMissing.add('R1'))],
    // Made a reviewer while it ran and not restarted since (HI-2664, HR3's round 1: Later): no reviewer's tools yet.
    ['made a reviewer while running, its builder tools still loaded', () => (state.status.set('R1', 'watching'), state.oldTools.add('R1'))]
  ])('a reviewer %s is still not free: given the card once that ends', async (_what, hold) => {
    const e = (env = setup({ ...optionsFor(1, 'pool', 'project'), platform: 'git' }, { autoRun: false }))
    state.wf = e.wf
    state.running = new Set(['R1'])
    hold()
    const a = pooled(e, 'Held')
    await submitted(e, a)
    await pass(e, ONE)
    expect(assignedTo(e, a.id)).toEqual([])
    expect(state.calls).toEqual([])
    Object.assign(state, { status: new Map([['R1', 'watching']]), pending: new Set(), background: new Set(), runs: new Set(), hooksMissing: new Set(), oldTools: new Set() })
    await pass(e, ONE)
    await pass(e, ONE)
    expect(assignedTo(e, a.id)).toEqual(['R1'])
    expect(state.calls).toEqual(['typed to R1'])
  })

  it("a line refused at the delivery's boundary is tried once more by a pass of its own, not at once, and given once", async () => {
    const e = (env = setup({ ...optionsFor(1, 'pool', 'project'), platform: 'git' }, { autoRun: false }))
    state.wf = e.wf
    state.running = new Set(['R1'])
    state.status.set('R1', 'watching')
    // Refused once (a watch's wake going first, the user typing: nothing its state reports), then given.
    state.next = ['notGiven']
    const was = poolTestHooks.retryMs
    poolTestHooks.retryMs = 0
    try {
      const a = pooled(e, 'Refused once')
      await submitted(e, a)
      await pass(e, ONE)
      expect(assignedTo(e, a.id)).toEqual(['R1'])
      // Its retry pass, which no event asked for, tells it again: given this time, and never a third.
      await vi.waitFor(() => expect(state.deliveries.map((d) => d.state)).toEqual(['cancelled', 'offered']), { timeout: HUNG_MS })
      await pass(e, ONE)
      expect(state.calls).toEqual(['typed to R1', 'typed to R1'])
    } finally {
      poolTestHooks.retryMs = was
    }
  })

  it('a retry armed by a workspace that has closed since is cleared with its lifetime; the workspace opened again gives the line', async () => {
    const e = (env = setup({ ...optionsFor(1, 'pool', 'project'), platform: 'git' }, { autoRun: false }))
    state.wf = e.wf
    state.running = new Set(['R1'])
    state.status.set('R1', 'watching')
    state.next = ['notGiven']
    const was = poolTestHooks.retryMs
    poolTestHooks.retryMs = 60_000
    try {
      const a = pooled(e, 'Closed meanwhile')
      await submitted(e, a)
      const life = new AbortController()
      const fired = poolTestHooks.retriesFired
      await settleReviewerPool(wsOf(e, ONE, life), e.project)
      expect(state.deliveries.map((d) => d.state)).toEqual(['cancelled'])
      expect(poolTestHooks.retriesPending()).toBe(1)
      // Closed before its retry fires: the retry goes with it, and never fires (HI-2343).
      life.abort()
      expect(poolTestHooks.retriesPending()).toBe(0)
      expect(poolTestHooks.retriesFired).toBe(fired)
      expect(state.deliveries.map((d) => d.state)).toEqual(['cancelled'])
      expect(state.calls).toEqual(['typed to R1'])
      // Opened again (another service at the same path): its pass tells the assignment still owed, once.
      await pass(e, ONE)
      expect(state.deliveries.map((d) => d.state)).toEqual(['cancelled', 'offered'])
      expect(assignedTo(e, a.id)).toEqual(['R1'])
    } finally {
      poolTestHooks.retryMs = was
    }
  })

  it("asks a pass for an agent's status event only when what its freedom reads has changed, never its inbox alone", () => {
    const base = { status: 'watching', watch: { label: 'x' }, inbox: { unread: 0 } } as never
    const key = (st: Record<string, unknown>, now: { pending?: boolean; backgroundTasks?: number } | null = { pending: false, backgroundTasks: 0 }) => poolStateKey({ ...(base as object), ...st } as never, now)
    // A refused line's own event: only its inbox differs.
    expect(key({ inbox: { unread: 1 } })).toBe(key({}))
    expect(key({ status: 'finished', watch: undefined })).not.toBe(key({}))
    expect(key({ watch: undefined })).not.toBe(key({}))
    expect(key({ hooksMissing: { since: 't' } })).not.toBe(key({}))
    expect(key({}, { pending: true, backgroundTasks: 0 })).not.toBe(key({}))
    expect(key({}, { pending: false, backgroundTasks: 1 })).not.toBe(key({}))
  })
})

/**
 * HI-2343: the refused line's retry as the app runs it: the pool started, its passes asked by the events it listens to
 * (each refusal emitting its agent's status, as the delivery's inbox change does), a real WorkspaceService (whose close
 * aborts its lifetime and gives the same service a new one), and fake timers for the retry's deadline and the board's
 * debounce. What it waits for are the pool's own counts (its passes run and going, its retries pending and fired).
 */
describe("a refused pool line's retry through the pool's events (HI-2343)", { timeout: 60_000 }, () => {
  const ONE = AGENTS.filter((a) => a.id !== 'R2')
  const RETRY = 5000
  /** Polled on the event loop's check phase, which fake timers leave alone; bounded for a hung run. */
  const until = async (what: string, cond: () => boolean): Promise<void> => {
    const t0 = performance.now()
    while (!cond()) {
      if (performance.now() - t0 > HUNG_MS) throw new Error(`still waiting for ${what}`)
      await new Promise((r) => setImmediate(r))
    }
  }
  /** Every pass asked has finished, and at least `n` have run since `from`. */
  const settled = (from: number, n = 1) => until(`${n} pass(es) settled`, () => poolTestHooks.passesRun >= from + n && poolTestHooks.passesGoing() === 0)
  const attempts = () => state.calls.filter((c) => c === 'typed to R1').length
  const given = (agent = 'R1') => state.deliveries.filter((d) => d.agentId === agent && d.state === 'offered').length
  let inbox = 0
  /** An agent's status event, as sessions emit it: its status as the stand-ins have it, its inbox counted on. */
  const status = (e: Env, agent = 'R1') => emit({ type: 'session-status', state: { projectPath: e.project, agentId: agent, status: state.status.get(agent) ?? 'ready', watch: { label: 'watch' }, inbox: { unread: inbox } } } as never)

  let ws: ReturnType<typeof createWorkspaceService> | null = null
  /** The workspace as a window opens it: its path, its project, its agents (the same service each time it opens). */
  const open = (e: Env, path = e.home, agents: AgentDef[] = ONE) => {
    const w = (ws ??= createWorkspaceService())
    w.path = path
    Object.assign(w, { projectConfig: async () => ({ agents }), info: () => ({ projects: path === e.home ? [{ name: 'project', path: e.project }] : [] }) })
    return w
  }
  const was = poolTestHooks.retryMs
  afterEach(async () => {
    stopReviewerPool()
    vi.useRealTimers()
    poolTestHooks.retryMs = was
    inbox = 0
    await ws?.close()
    ws = null
  })

  /** A pool card submitted with R1 watching and its line refused until told otherwise, the pool started and given it once. */
  const refusedOnce = async (agents: AgentDef[] = ONE) => {
    // Own the board poll's clock too (HI-2455): setup opens it, so installing timers afterward leaves that event source
    // on real time. A loaded test must not gain board events while only its fake retry clock advances.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const e = (env = setup({ ...optionsFor(1, 'pool', 'project'), platform: 'git' }, { autoRun: false }))
    state.manualBoard = e.home
    state.wf = e.wf
    state.running = new Set(['R1'])
    state.status.set('R1', 'watching')
    state.refuse = new Set(['R1'])
    // Each refusal changes R1's inbox, and so emits its status: the same state otherwise (HI-2333's loop at the boundary).
    state.onRefused = (a) => {
      inbox++
      status(e, a)
    }
    poolTestHooks.retryMs = RETRY
    open(e, e.home, agents)
    startReviewerPool()
    // R1's status as the pool first sees it (an agent's events start with its session), before anything is owed.
    let from = poolTestHooks.passesRun
    status(e)
    await settled(from)
    const c = e.wf.createCard({ title: 'Refused' })
    lane(e, 'L', [c.id], 'B1', null)
    await submitted(e, c)
    // The board changed: looked at once its debounce ends, and the line refused.
    from = poolTestHooks.passesRun
    emit({ type: 'tasks-changed' } as never)
    await vi.advanceTimersByTimeAsync(1000)
    await settled(from)
    expect(assignedTo(e, c.id)).toEqual(['R1'])
    expect(attempts()).toBe(1)
    expect(poolTestHooks.retriesPending()).toBe(1)
    return { e, c }
  }
  /** Time up to just before the retry's deadline, then to it: nothing until then, one attempt at it. */
  const toDeadline = async (): Promise<void> => {
    const [n, fired, from] = [attempts(), poolTestHooks.retriesFired, poolTestHooks.passesRun]
    await vi.advanceTimersByTimeAsync(RETRY - 1)
    expect(poolTestHooks.passesGoing()).toBe(0)
    expect([attempts(), poolTestHooks.retriesFired, poolTestHooks.passesRun]).toEqual([n, fired, from])
    await vi.advanceTimersByTimeAsync(1)
    expect(poolTestHooks.retriesFired).toBe(fired + 1)
    await settled(from)
    expect(attempts()).toBe(n + 1)
  }

  it('a persistent refusal: one attempt at each deadline, none between, one retry pending; cleared, given once and no more retries', async () => {
    const { e } = await refusedOnce()
    for (let i = 0; i < 3; i++) {
      await toDeadline()
      // Refused again: one retry pending, its status event (an inbox change only) asks no pass.
      expect(poolTestHooks.retriesPending()).toBe(1)
      expect(given()).toBe(0)
    }
    // Board and status passes meanwhile: each tries the owed line (a pass tells what it owes), but never arms a second
    // retry, nor moves the deadline the first set.
    const timers = vi.getTimerCount()
    const from = poolTestHooks.passesRun
    emit({ type: 'tasks-changed' } as never)
    await vi.advanceTimersByTimeAsync(1000)
    await settled(from)
    state.status.set('R1', 'ready')
    status(e)
    await settled(from, 2)
    state.status.set('R1', 'watching')
    status(e)
    await settled(from, 3)
    expect(attempts()).toBe(1 + 3 + 3)
    expect(poolTestHooks.retriesPending()).toBe(1)
    expect(vi.getTimerCount()).toBeLessThanOrEqual(timers)
    // The blocker cleared: the retry still pending (armed by the last deadline's refusal) gives the line at its deadline.
    state.refuse.clear()
    const fired = poolTestHooks.retriesFired
    const at = poolTestHooks.passesRun
    await vi.advanceTimersByTimeAsync(RETRY - 1000)
    expect(poolTestHooks.retriesFired).toBe(fired + 1)
    await settled(at)
    expect(given()).toBe(1)
    expect(state.deliveries.at(-1)?.body).toMatch(/you review it from the pool/)
    // And no more: nothing pending, nothing fired, nothing typed however long it waits.
    expect(poolTestHooks.retriesPending()).toBe(0)
    const total = attempts()
    await vi.advanceTimersByTimeAsync(RETRY * 3)
    expect([poolTestHooks.retriesFired, poolTestHooks.passesGoing(), attempts(), given()]).toEqual([fired + 1, 0, total, 1])
  })

  it('an eligibility change while the retry waits gives the line; the retry then finds it given, and nothing is typed twice', async () => {
    const { e } = await refusedOnce()
    state.refuse.clear()
    // Its turn ended (a real change of what the pool reads): the event's pass gives it before the deadline.
    const from = poolTestHooks.passesRun
    state.status.set('R1', 'ready')
    status(e)
    await settled(from)
    expect([attempts(), given()]).toEqual([2, 1])
    // The retry fires at its deadline and runs a pass, which sees the delivery made: nothing typed.
    const fired = poolTestHooks.retriesFired
    await vi.advanceTimersByTimeAsync(RETRY)
    expect(poolTestHooks.retriesFired).toBe(fired + 1)
    await settled(from, 2)
    expect([attempts(), given(), poolTestHooks.retriesPending()]).toEqual([2, 1, 0])
  })

  it('an eligibility change at the deadline itself: the event and the retry share one pass, and the line is given once', async () => {
    const { e } = await refusedOnce()
    state.refuse.clear()
    await vi.advanceTimersByTimeAsync(RETRY - 1)
    const from = poolTestHooks.passesRun
    state.status.set('R1', 'ready')
    status(e)
    await vi.advanceTimersByTimeAsync(1)
    await settled(from)
    expect([attempts(), given(), poolTestHooks.retriesPending()]).toEqual([2, 1, 0])
    await vi.advanceTimersByTimeAsync(RETRY * 2)
    expect([attempts(), given(), poolTestHooks.passesGoing()]).toEqual([2, 1, 0])
  })

  it('superseded while the retry waits (R1 took a builder lease): released, given to R2 once, and R1 told nothing more', async () => {
    const { e, c } = await refusedOnce(AGENTS)
    lease(e, 'R1', true)
    const from = poolTestHooks.passesRun
    await vi.advanceTimersByTimeAsync(RETRY)
    await settled(from)
    expect(assignedTo(e, c.id)).toEqual(['R1', 'R2'])
    expect([attempts(), given('R1'), given('R2')]).toEqual([1, 0, 1])
    expect(state.calls).toContain('start R2 for review')
    await vi.advanceTimersByTimeAsync(RETRY * 3)
    expect([attempts(), given('R1'), given('R2'), poolTestHooks.retriesPending()]).toEqual([1, 0, 1, 0])
  })

  it('the pool stopped while the retry waits: cleared, nothing later; started again, it gives the line once', async () => {
    const { e } = await refusedOnce()
    stopReviewerPool()
    expect(poolTestHooks.retriesPending()).toBe(0)
    state.refuse.clear()
    const fired = poolTestHooks.retriesFired
    await vi.advanceTimersByTimeAsync(RETRY * 3)
    expect([poolTestHooks.retriesFired, poolTestHooks.passesGoing(), attempts(), given()]).toEqual([fired, 0, 1, 0])
    // Its events no longer ask passes.
    status(e)
    expect(poolTestHooks.passesGoing()).toBe(0)
    // A fresh start: the board's next change gives the line owed, once.
    startReviewerPool()
    const from = poolTestHooks.passesRun
    emit({ type: 'tasks-changed' } as never)
    await vi.advanceTimersByTimeAsync(1000)
    await settled(from)
    expect([attempts(), given()]).toEqual([2, 1])
    await vi.advanceTimersByTimeAsync(RETRY * 3)
    expect([attempts(), given(), poolTestHooks.retriesPending()]).toEqual([2, 1, 0])
  })

  it('the workspace closed while the retry waits and opened again on the same service: the old retry never fires into the new lifetime', async () => {
    const { e } = await refusedOnce()
    const fired = poolTestHooks.retriesFired
    await ws!.close()
    expect(ws!.lifetime.aborted).toBe(false) // the same service's new lifetime (workspace.ts close)
    expect(poolTestHooks.retriesPending()).toBe(0)
    // Opened again, the refusal gone: the old deadline passes with nothing (HR2's note: before HI-2343 it ran a pass).
    open(e)
    state.refuse.clear()
    await vi.advanceTimersByTimeAsync(RETRY * 3)
    expect([poolTestHooks.retriesFired, poolTestHooks.passesGoing(), attempts(), given()]).toEqual([fired, 0, 1, 0])
    // The opening's own event: the line still owed, given once.
    const from = poolTestHooks.passesRun
    emit({ type: 'workspace-changed' } as never)
    await vi.advanceTimersByTimeAsync(1000)
    await settled(from)
    expect([attempts(), given(), poolTestHooks.retriesPending()]).toEqual([2, 1, 0])
  })

  it('the service switched to another workspace while the retry waits: no pass for the old project there, nor a delivery', async () => {
    const { e } = await refusedOnce()
    const fired = poolTestHooks.retriesFired
    await ws!.close()
    open(e, tempDir('other-ws-'))
    state.refuse.clear()
    const from = poolTestHooks.passesRun
    await vi.advanceTimersByTimeAsync(RETRY * 3)
    expect([poolTestHooks.retriesFired, poolTestHooks.passesRun, poolTestHooks.passesGoing(), attempts(), given()]).toEqual([fired, from, 0, 1, 0])
    // The first workspace opened again (the same service): the line owed there is given once.
    open(e)
    emit({ type: 'workspace-changed' } as never)
    await vi.advanceTimersByTimeAsync(1000)
    await settled(from)
    expect([attempts(), given()]).toEqual([2, 1])
  })
})
