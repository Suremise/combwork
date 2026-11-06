// What a view keeps after a load finishes: results and errors belong to the scope (project, workspace, search) they
// were loaded for. A failed refresh of the same scope keeps the last results; a failure for a new scope has none.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { scopedLoads, settle, type Scoped } from '../src/shared/scoped'
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
    const ask = (): void => serial.run('alpha', h.start('alpha'), () => {
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
    const ask = (): void => serial.run('alpha', () => { const n = h.loads.length; return h.start('alpha')().then(() => { taken.push(n) }) }, ask)
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

/** A promise the test settles. */
function deferred<T>() {
  let resolve: (v: T) => void = () => undefined
  let reject: (e: Error) => void = () => undefined
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("a load with an early part (HI-1681: Combwork's sessions before the rest)", () => {
  /** A view's state and its loads, the scope fixed unless `scope.now` changes. */
  function view() {
    let state: Scoped<string[]> = { scope: 'alpha', data: null, error: null, at: 0 }
    const scope = { now: 'alpha' }
    let t = 0
    const load = scopedLoads<string[]>((next) => (state = next(state)), () => scope.now, () => ++t)
    return { load, scope, get: () => state }
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the early part while the load runs, then the whole', async () => {
    const v = view()
    const early = deferred<string[]>()
    const whole = deferred<string[]>()
    v.load('alpha', () => whole.promise, early.promise)
    early.resolve(['own'])
    await settled()
    expect(v.get()).toMatchObject({ data: ['own'], error: null })
    whole.resolve(['own', 'other'])
    await settled()
    expect(v.get()).toMatchObject({ data: ['own', 'other'], error: null })
  })

  it('an early part that never comes leaves the load to fail at its time limit, with the error shown', async () => {
    const v = view()
    const early = deferred<string[]>()
    const whole = deferred<string[]>()
    v.load('alpha', () => withinTime(whole.promise, 60_000, () => 'no answer after 60 s'), early.promise)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(v.get()).toMatchObject({ data: null, error: 'no answer after 60 s' })
  })

  it("an early part that comes after the load ended, or fails, changes nothing", async () => {
    const v = view()
    const early = deferred<string[]>()
    const whole = deferred<string[]>()
    v.load('alpha', () => whole.promise, early.promise)
    whole.resolve(['own', 'other'])
    await settled()
    early.resolve(['own'])
    await settled()
    expect(v.get().data).toEqual(['own', 'other'])
    // After a failed load: the error stays, with no stale early part as its results.
    const late = deferred<string[]>()
    const failing = deferred<string[]>()
    const w = view()
    w.load('alpha', () => failing.promise, late.promise)
    failing.reject(new Error('boom'))
    await settled()
    late.resolve(['own'])
    await settled()
    expect(w.get()).toMatchObject({ data: null, error: 'boom' })
    // A failing early part: the load's own result shows.
    const bad = deferred<string[]>()
    const good = deferred<string[]>()
    const x = view()
    x.load('alpha', () => good.promise, bad.promise)
    bad.reject(new Error('own failed'))
    good.resolve(['all'])
    await settled()
    expect(x.get()).toMatchObject({ data: ['all'], error: null })
  })

  it("an early part of an older load, or of another scope, isn't shown", async () => {
    const v = view()
    const early = deferred<string[]>()
    v.load('alpha', () => new Promise<string[]>(() => undefined), early.promise)
    const newer = deferred<string[]>()
    v.load('alpha', () => newer.promise)
    early.resolve(['old own'])
    await settled()
    expect(v.get().data).toBeNull()
    const other = deferred<string[]>()
    v.load('alpha', () => new Promise<string[]>(() => undefined), other.promise)
    v.scope.now = 'beta'
    other.resolve(['alpha own'])
    await settled()
    expect(v.get().data).toBeNull()
  })
})

describe("scopedLoads: answers out of order (HI-1841, HR5's round 1)", () => {
  /** A view's state, its scope and the loads it starts, each settled by the test. */
  function view(scope: string) {
    let state: Scoped<string[]> = { scope, data: null, error: null, at: 0 }
    let current = scope
    const pending: { resolve: (v: string[]) => void; reject: (e: Error) => void }[] = []
    const load = scopedLoads<string[]>((next) => (state = next(state)), () => current, () => 1)
    const start = (asked: string) => load(asked, () => new Promise<string[]>((resolve, reject) => pending.push({ resolve, reject })))
    return { start, pending, move: (to: string) => (current = to), state: () => state }
  }

  it("an older load of the last scope answering after the new scope's is dropped", async () => {
    const v = view('alpha')
    v.start('alpha')
    v.move('beta')
    v.start('beta')
    v.pending[1].resolve([])
    await Promise.resolve()
    v.pending[0].resolve(['alpha-card'])
    await Promise.resolve()
    expect(v.state()).toEqual({ scope: 'beta', data: [], error: null, at: 1 })
  })

  it("…and so is its failure: the new scope's results stay, with no error", async () => {
    const v = view('alpha')
    v.start('alpha')
    v.move('beta')
    v.start('beta')
    v.pending[1].resolve(['beta-card'])
    await Promise.resolve()
    v.pending[0].reject(new Error('alpha failed'))
    await Promise.resolve().then(() => undefined)
    expect(v.state()).toEqual({ scope: 'beta', data: ['beta-card'], error: null, at: 1 })
  })

  it('in one scope, an older load answering after a newer one is dropped, success or failure', async () => {
    const v = view('alpha')
    v.start('alpha')
    v.start('alpha')
    v.pending[1].resolve(['new'])
    await Promise.resolve()
    v.pending[0].resolve(['old'])
    await Promise.resolve()
    expect(v.state().data).toEqual(['new'])
    v.start('alpha')
    v.start('alpha')
    v.pending[3].resolve(['newer'])
    await Promise.resolve()
    v.pending[2].reject(new Error('older failed'))
    await Promise.resolve().then(() => undefined)
    expect(v.state()).toEqual({ scope: 'alpha', data: ['newer'], error: null, at: 1 })
  })
})
