// The merge queue's history for the Progress panel's Recent merges (HI-1924): how long the queue took over each entry
// (its merge checks naming the entry, else its merge), and the pause log written with the pause itself. Real
// repositories for the queue's own facts; the checks are stand-ins.
import { afterEach, describe, expect, it } from 'vitest'
import { B1, commit, moved, setup, sh, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'
import { entryTook, pauseLogged, pauseLogKey, pushesSettled, type PushSettled } from '../../src/main/workflow/queueLogs'
import { HIVE_RUNS } from '../../src/main/progress'
import { QUEUE_LOG_MAX, type QueuePauseLogged } from '../../src/shared/workflow/queue'
import type { Fact, FactData, FactKind } from '../../src/shared/workflow/facts'

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

/** Pair (Combwork merges) with one merge check, no review: a submitted card goes straight into the queue. */
function pairWithCheck(): Env {
  const e = (env = setup({ ...preset('git', 'pair'), review: 'none', noSelfReview: false, preChecks: [], mergeChecks: ['quick'], commands: { quick: 'npm run quick' } }))
  sh(e.project, 'checkout', '-q', '--detach')
  return e
}

async function queued(e: Env, title: string, files: Record<string, string>) {
  const card = e.wf.createCard({ title })
  const s = await e.wf.start(card.key, B1)
  moved(s)
  commit(s.data!.folder as string, files, title)
  moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
  return card
}

const recent = (e: Env) => e.store.facts.bind(e.store)
const entryOf = (facts: Fact[]): string => (facts.findLast((f) => f.kind === 'IntegrationRequested')!.data as FactData['IntegrationRequested']).entry

describe("the queue's time taken over an entry (HI-1924)", () => {
  it('its merge checks name the entry, and a merge takes from its first check to Integrated', async () => {
    const e = pairWithCheck()
    const a = await queued(e, 'A', { 'a.txt': 'A\n' })
    expect((await e.queue().drain('main')).map((o) => o.outcome)).toEqual(['integrated'])
    const facts = recent(e)(a.id)
    const entry = entryOf(facts)
    const check = facts.find((f) => f.kind === 'CheckRan' && (f.data as FactData['CheckRan']).by === HIVE_RUNS)!
    expect((check.data as FactData['CheckRan']).entry).toBe(entry)
    const end = facts.find((f) => f.kind === 'Integrated')!
    expect(entryTook(facts, entry)).toBe(Date.parse(end.at) - (Date.parse(check.at) - (check.data as FactData['CheckRan']).durationMs))
  })

  it('a red check returns the card with the time its checks took; its retry is a new entry and the older row keeps its time', async () => {
    const e = pairWithCheck()
    const a = await queued(e, 'A', { 'a.txt': 'A\n' })
    let red = true
    const q = e.queue({ runCheck: async () => (red ? { ok: false, output: 'failed' } : { ok: true, output: '' }) })
    expect((await q.drain('main')).map((o) => o.outcome)).toEqual(['returned'])
    const first = entryOf(recent(e)(a.id))
    const took = entryTook(recent(e)(a.id), first)
    expect(took).not.toBeNull()
    red = false
    moved(await e.wf.retryMerge(a.key, 'again'))
    expect((await q.drain('main')).map((o) => o.outcome)).toEqual(['integrated'])
    const facts = recent(e)(a.id)
    const second = entryOf(facts)
    expect(second).not.toBe(first)
    expect(entryTook(facts, first)).toBe(took)
    expect(entryTook(facts, second)).not.toBeNull()
  })

  it('a conflict at the test merge, before anything ran: no time', async () => {
    const e = pairWithCheck()
    const a = await queued(e, 'A', { 'same.txt': 'A\n' })
    const b = await queued(e, 'B', { 'same.txt': 'B\n' })
    expect((await e.queue().drain('main')).map((o) => o.outcome)).toEqual(['integrated', 'returned'])
    expect(entryTook(recent(e)(a.id), entryOf(recent(e)(a.id)))).not.toBeNull()
    expect(entryTook(recent(e)(b.id), entryOf(recent(e)(b.id)))).toBeNull()
  })
})

/** Facts as a card's store gives them, in order, a second apart (`at` in seconds from T0). */
const T0 = Date.parse('2026-10-28T09:00:00.000Z')
function factsOf(list: [FactKind, number, Record<string, unknown>][]): Fact[] {
  return list.map(([kind, s, data], i) => ({ seq: i + 1, card: 1, kind, at: new Date(T0 + s * 1000).toISOString(), actor: { kind: 'hive' }, source: 'recorded', data }) as unknown as Fact)
}
const check = (entry: string | undefined, durationS: number) => ({ name: 'quick', command: 'q', revision: 'r', tested: 'r', result: 'passed', run: 'x', durationMs: durationS * 1000, by: HIVE_RUNS, counted: true, ...(entry ? { entry } : {}) })

describe('entryTook from facts alone (HI-1924)', () => {
  it('two targets at once: each entry counts only the checks naming it', () => {
    const f = factsOf([
      ['IntegrationRequested', 0, { entry: 'm', target: 'main' }],
      ['IntegrationRequested', 1, { entry: 'r', target: 'release' }],
      ['CheckRan', 30, check('m', 20)],
      ['CheckRan', 100, check('r', 60)],
      ['Integrated', 40, { entry: 'm', target: 'main' }],
      ['IntegrationFailed', 110, { entry: 'r', target: 'release', reason: 'checks' }]
    ])
    expect(entryTook(f, 'm')).toBe(30_000)
    expect(entryTook(f, 'r')).toBe(70_000)
  })

  it('no merge checks: from its merge (IntegrationStarted) to Integrated', () => {
    const f = factsOf([
      ['IntegrationRequested', 0, { entry: 'e', target: 'main' }],
      ['IntegrationStarted', 50, { entry: 'e' }],
      ['Integrated', 53, { entry: 'e', target: 'main' }]
    ])
    expect(entryTook(f, 'e')).toBe(3_000)
  })

  it("old checks that don't name their entry: counted between its request and outcome, unless another entry of the card was open then", () => {
    const alone = factsOf([
      ['IntegrationRequested', 0, { entry: 'e', target: 'main' }],
      ['CheckRan', 30, check(undefined, 20)],
      ['Integrated', 35, { entry: 'e', target: 'main' }]
    ])
    expect(entryTook(alone, 'e')).toBe(25_000)
    const overlapping = factsOf([
      ['IntegrationRequested', 0, { entry: 'e', target: 'main' }],
      ['IntegrationRequested', 1, { entry: 'o', target: 'release' }],
      ['CheckRan', 30, check(undefined, 20)],
      ['Integrated', 35, { entry: 'e', target: 'main' }],
      ['Integrated', 36, { entry: 'o', target: 'release' }]
    ])
    expect(entryTook(overlapping, 'e')).toBeNull()
  })

  it('a cancel before anything ran, or an entry with no outcome yet: no time', () => {
    const f = factsOf([
      ['IntegrationRequested', 0, { entry: 'c', target: 'main' }],
      ['IntegrationCancelled', 5, { entry: 'c', reason: 'removed' }],
      ['IntegrationRequested', 6, { entry: 'open', target: 'main' }]
    ])
    expect(entryTook(f, 'c')).toBeNull()
    expect(entryTook(f, 'open')).toBeNull()
  })
})

describe("a queue's pause log (HI-1924)", () => {
  const at = (s: number): string => new Date(T0 + s * 1000).toISOString()

  it('a pause begins a row, lifted it ends; saved again as it was it carries on; another reason ends it and begins its own', () => {
    let log: QueuePauseLogged[] = []
    log = pauseLogged(log, null, { reason: 'user', card: '', by: 'user', at: at(0) }, at(0))
    expect(log).toEqual([{ reason: 'user', card: '', by: 'user', at: at(0) }])
    log = pauseLogged(log, { reason: 'user', card: '' }, { reason: 'user', card: '', at: at(5) }, at(5))
    expect(log).toHaveLength(1)
    log = pauseLogged(log, { reason: 'user', card: '' }, { reason: 'pushFailed', card: 'HI-1', at: at(9) }, at(9))
    expect(log).toEqual([{ reason: 'pushFailed', card: 'HI-1', at: at(9) }, { reason: 'user', card: '', by: 'user', at: at(0), ended: at(9) }])
    log = pauseLogged(log, { reason: 'pushFailed', card: 'HI-1' }, null, at(20))
    expect(log[0]).toEqual({ reason: 'pushFailed', card: 'HI-1', at: at(9), ended: at(20) })
  })

  it('keeps the newest QUEUE_LOG_MAX', () => {
    let log: QueuePauseLogged[] = []
    for (let i = 0; i < QUEUE_LOG_MAX + 5; i++) log = pauseLogged(log, null, { reason: 'user', card: '', at: at(i) }, at(i))
    expect(log).toHaveLength(QUEUE_LOG_MAX)
    expect(log[0].at).toBe(at(QUEUE_LOG_MAX + 4))
  })

  it("is written in the store's pause writes: Pause queue, Combwork's own pause kept in its place, a clear by reason, Resume", () => {
    const e = pairWithCheck()
    expect(e.store.setQueuePause('main', { reason: 'user', card: '', by: 'user' })).toBe(true)
    // Combwork's own pause never replaces one saved meanwhile, and logs nothing.
    expect(e.store.setQueuePause('main', { reason: 'pushFailed', card: 'HI-1' }, true)).toBe(false)
    expect(e.store.queuePauseLog('main').map((p) => [p.reason, !!p.ended])).toEqual([['user', false]])
    e.store.setQueuePause('main', null)
    expect(e.store.queuePauseLog('main').map((p) => [p.reason, !!p.ended])).toEqual([['user', true]])
    e.store.setQueuePause('main', { reason: 'focusedSkip', card: 'HI-2' })
    expect(e.store.clearQueuePause('main', 'other')).toBe(false)
    expect(e.store.clearQueuePause('main', 'focusedSkip')).toBe(true)
    expect(e.store.queuePauseLog('main').map((p) => [p.reason, p.card, !!p.ended])).toEqual([
      ['focusedSkip', 'HI-2', true],
      ['user', '', true]
    ])
    // Another target keeps its own log; an unreadable one reads as none.
    expect(e.store.queuePauseLog('release')).toEqual([])
    e.store.setMeta(pauseLogKey('release'), '{not json')
    expect(e.store.queuePauseLog('release')).toEqual([])
  })
})

describe('the settled pushes (HI-1924)', () => {
  it('newest first, bounded', () => {
    const one = (i: number): PushSettled => ({ entry: `e${i}`, state: 'pushed', at: String(i) })
    let log: PushSettled[] = []
    for (let i = 0; i < QUEUE_LOG_MAX; i++) log = pushesSettled(log, [one(i)])
    log = pushesSettled(log, [one(100), one(101)])
    expect(log).toHaveLength(QUEUE_LOG_MAX)
    expect(log.slice(0, 3).map((p) => p.entry)).toEqual(['e101', 'e100', `e${QUEUE_LOG_MAX - 1}`])
  })
})
