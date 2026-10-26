// What a view keeps after a load finishes: results and errors belong to the scope (project, workspace, search) they
// were loaded for. A failed refresh of the same scope keeps the last results; a failure for a new scope has none.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { settle, type Scoped } from '../src/shared/scoped'
import { oneAtATime, withinTime } from '../src/shared/coalesce'

const empty: Scoped<string[]> = { scope: 'alpha', data: null, error: null, at: 0 }

describe('settle', () => {
  it('a load sets the results for its scope and clears an error', () => {
    const failed = { ...empty, error: 'boom' }
    expect(settle(failed, 'alpha', { data: ['a'] }, 100)).toEqual({ scope: 'alpha', data: ['a'], error: null, at: 100 })
  })

  it('a failed refresh of the same scope keeps the last results, from when they were loaded', () => {
    const loaded = settle(empty, 'alpha', { data: ['a'] }, 100)
    expect(settle(loaded, 'alpha', { error: 'boom' }, 200)).toEqual({ scope: 'alpha', data: ['a'], error: 'boom', at: 100 })
  })

  it("a failure for another scope has no results: the last scope's aren't its own", () => {
    const loaded = settle(empty, 'alpha', { data: ['alpha-only'] }, 100)
    expect(settle(loaded, 'beta', { error: 'boom' }, 200)).toEqual({ scope: 'beta', data: null, error: 'boom', at: 0 })
  })

  it("a load for another scope replaces the last scope's results", () => {
    const loaded = settle(empty, 'alpha', { data: ['alpha-only'] }, 100)
    expect(settle(loaded, 'beta', { data: ['b'] }, 200)).toEqual({ scope: 'beta', data: ['b'], error: null, at: 200 })
  })
})

/** Loads the test settles itself, each with its scope. */
function held() {
  const loads: { scope: string; resolve: () => void; reject: (e: Error) => void }[] = []
  const start = (scope: string) => (): Promise<void> => new Promise<void>((resolve, reject) => loads.push({ scope, resolve, reject }))
  return { loads, start }
}
/** Runs what the loads' endings queued (their callbacks and the zero-delay reruns), on controlled timers. */
const settled = async (): Promise<void> => {
  await vi.runAllTimersAsync()
}

describe('one load at a time (#1646)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('asked again while a load runs, loads once more after it ends, however many times it was asked', async () => {
    const serial = oneAtATime()
    const h = held()
    let reruns = 0
    const ask = (): void => serial.run('hive', h.start('hive'), () => {
      reruns++
      ask()
    })
    ask()
    ask()
    ask()
    ask()
    await settled()
    expect(h.loads).toHaveLength(1)
    expect(reruns).toBe(0)
    h.loads[0].resolve()
    await settled()
    expect(reruns).toBe(1)
    expect(h.loads).toHaveLength(2)
    h.loads[1].resolve()
    await settled()
    expect(reruns).toBe(1)
    expect(h.loads).toHaveLength(2)
  })

  it('every load ends and is taken when asks come faster than loads finish (they never were with numbered loads)', async () => {
    const serial = oneAtATime()
    const h = held()
    const taken: number[] = []
    const ask = (): void => serial.run('hive', () => { const n = h.loads.length; return h.start('hive')().then(() => { taken.push(n) }) }, ask)
    for (let round = 0; round < 5; round++) {
      ask()
      ask()
      h.loads.at(-1)!.resolve()
      await settled()
    }
    expect(taken).toEqual([0, 1, 2, 3, 4])
  })

  it("A, then B, then A again while the first A runs: no second A until it ends, then one, so A's results come in order (HR6's round 1)", async () => {
    const serial = oneAtATime()
    const h = held()
    const results: string[] = []
    const ask = (scope: string, rerun: () => void): void => serial.run(scope, () => { const n = h.loads.filter((l) => l.scope === scope).length; return h.start(scope)().then(() => { results.push(`${scope}${n}`) }) }, rerun)
    const askA = (): void => ask('A', askA)
    askA()
    ask('B', () => undefined)
    askA()
    await settled()
    expect(h.loads.map((l) => l.scope)).toEqual(['A', 'B'])
    h.loads[1].resolve()
    await settled()
    expect(h.loads.map((l) => l.scope)).toEqual(['A', 'B'])
    h.loads[0].resolve()
    await settled()
    // The first A ended (taken), then the A asked meanwhile started: never two A at once.
    expect(h.loads.map((l) => l.scope)).toEqual(['A', 'B', 'A'])
    h.loads[2].resolve()
    await settled()
    expect(results).toEqual(['B0', 'A0', 'A1'])
  })

  it("another scope's load starts at once; a failed load lets the next one run", async () => {
    const serial = oneAtATime()
    const h = held()
    serial.run('alpha', h.start('alpha'), () => undefined)
    serial.run('beta', h.start('beta'), () => undefined)
    expect(h.loads.map((l) => l.scope)).toEqual(['alpha', 'beta'])
    h.loads[1].reject(new Error('boom'))
    await settled()
    serial.run('beta', h.start('beta'), () => undefined)
    expect(h.loads.map((l) => l.scope)).toEqual(['alpha', 'beta', 'beta'])
  })
})

describe('a load with a time limit (#1646)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('fails with its message once the limit passes without an answer', async () => {
    vi.useFakeTimers()
    const never = new Promise<string>(() => undefined)
    const bounded = withinTime(never, 60_000, () => 'no answer after 60 s')
    const outcome = bounded.then(() => 'answered', (e: Error) => e.message)
    await vi.advanceTimersByTimeAsync(59_999)
    let early: string | null = null
    void outcome.then((o) => (early = o))
    await Promise.resolve()
    expect(early).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(await outcome).toBe('no answer after 60 s')
  })

  it("an answer within the limit is the load's, and its timer is cleared", async () => {
    vi.useFakeTimers()
    expect(await withinTime(Promise.resolve('sessions'), 60_000, () => 'late')).toBe('sessions')
    expect(vi.getTimerCount()).toBe(0)
  })
})
