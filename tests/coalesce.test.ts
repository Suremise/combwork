// The window's repeated reads, never two of the same at once (#1629): queue:list's coalesced calls and the work badges'
// one read at a time, driven with promises the test settles itself, in the orders that went wrong (HR6's round 1).
import { describe, expect, it, vi } from 'vitest'
import { boundedQueue, coalesced, joined, latestOnly } from '../src/shared/coalesce'
import { makeBadgeSource } from '../src/shared/workflow/badgeSource'
import type { WorkBadge } from '../src/shared/workflow/workView'

/** A bound for a hung run only: the waits are for promises the test settles itself. */
const HUNG_MS = 10_000

/** A call the test settles: each one made, with what it was for. */
function held<T>() {
  const calls: { for: string; resolve: (v: T) => void; reject: (e: Error) => void }[] = []
  const fetch = (what: string): Promise<T> => new Promise<T>((resolve, reject) => calls.push({ for: what, resolve, reject }))
  return { calls, fetch }
}
/** Lets the promise callbacks queued so far run. */
const settled = (): Promise<void> => new Promise((r) => setImmediate(r))

describe('coalesced calls (queue:list)', () => {
  it('never runs two calls of one key at once: those asked meanwhile share one more, made after it', async () => {
    const call = coalesced<string>()
    const h = held<string>()
    // A board change and a queue change for one project while its read is under way, then a view's own read.
    const first = call('p', () => h.fetch('p'))
    const second = call('p', () => h.fetch('p'))
    const third = call('p', () => h.fetch('p'))
    expect(h.calls).toHaveLength(1)
    expect(second).toBe(third)
    h.calls[0].resolve('old')
    expect(await first).toBe('old')
    await settled()
    // The shared one starts once the first has settled: read after they asked.
    expect(h.calls).toHaveLength(2)
    h.calls[1].resolve('new')
    expect(await second).toBe('new')
    // Nothing under way: the next call is a call of its own.
    const fourth = call('p', () => h.fetch('p'))
    expect(h.calls).toHaveLength(3)
    h.calls[2].resolve('later')
    expect(await fourth).toBe('later')
  })

  it('keeps keys apart (a target, another project), and goes on after a failure', async () => {
    const call = coalesced<string>()
    const h = held<string>()
    const a = call('p', () => h.fetch('p'))
    const b = call('p\nmain', () => h.fetch('p\nmain'))
    expect(h.calls.map((c) => c.for)).toEqual(['p', 'p\nmain'])
    const again = call('p', () => h.fetch('p'))
    h.calls[0].reject(new Error('gone'))
    await expect(a).rejects.toThrow('gone')
    await settled()
    expect(h.calls.map((c) => c.for)).toEqual(['p', 'p\nmain', 'p'])
    h.calls[2].resolve('back')
    h.calls[1].resolve('target')
    expect(await again).toBe('back')
    expect(await b).toBe('target')
  })
})

describe('joined calls (HI-1681: the other sessions of a session list)', () => {
  it('shares the call in flight with those asked meanwhile, and starts a new one once it has settled', async () => {
    const call = joined<string>()
    const h = held<string>()
    const first = call('p', () => h.fetch('p'))
    const second = call('p', () => h.fetch('p'))
    // Another key is its own call.
    const other = call('q', () => h.fetch('q'))
    expect(h.calls.map((c) => c.for)).toEqual(['p', 'q'])
    expect(second).toBe(first)
    h.calls[0].resolve('one')
    h.calls[1].resolve('other')
    expect(await second).toBe('one')
    expect(await other).toBe('other')
    const third = call('p', () => h.fetch('p'))
    expect(h.calls).toHaveLength(3)
    h.calls[2].resolve('two')
    expect(await third).toBe('two')
  })

  it('a failed call fails those that joined it, and the next ask starts afresh', async () => {
    const call = joined<string>()
    const h = held<string>()
    const first = call('p', () => h.fetch('p'))
    const second = call('p', () => h.fetch('p'))
    h.calls[0].reject(new Error('busy'))
    await expect(first).rejects.toThrow('busy')
    await expect(second).rejects.toThrow('busy')
    const again = call('p', () => h.fetch('p'))
    expect(h.calls).toHaveLength(2)
    h.calls[1].resolve('ok')
    expect(await again).toBe('ok')
    // A load that throws as it starts fails its caller, and holds nothing up.
    await expect(call('p', () => { throw new Error('at once') })).rejects.toThrow('at once')
    const after = call('p', () => h.fetch('p'))
    h.calls[2].resolve('after')
    expect(await after).toBe('after')
  })
})

describe("the work badges' one source", () => {
  const badge = (card: number, stage: WorkBadge['stage']): WorkBadge => ({ card, stage }) as WorkBadge
  const source = () => {
    const h = held<WorkBadge[]>()
    const s = makeBadgeSource((ws) => h.fetch(ws))
    return { h, s, shown: () => [s.get().ws, [...s.get().badges.values()].map((b) => b.stage)] }
  }

  it('A, B, then A again: one read at a time, and what shows is the latest read of A', async () => {
    const { h, s, shown } = source()
    s.ask('A', [1])
    s.ask('B', [1])
    s.ask('A', [2])
    expect(h.calls.map((c) => c.for)).toEqual(['A'])
    h.calls[0].resolve([badge(1, 'active')])
    await settled()
    // The read of A asked last starts once the first has settled.
    expect(h.calls.map((c) => c.for)).toEqual(['A', 'A'])
    h.calls[1].resolve([badge(1, 'done')])
    await settled()
    expect(shown()).toEqual(['A', ['done']])
  })

  it("drops a read for a workspace the window has left, and reads the one it's in", async () => {
    const { h, s, shown } = source()
    s.ask('A', [1])
    s.ask('B', [1])
    h.calls[0].resolve([badge(1, 'active')])
    await settled()
    expect(shown()).toEqual(['', []])
    expect(h.calls.map((c) => c.for)).toEqual(['A', 'B'])
    h.calls[1].resolve([badge(2, 'review')])
    await settled()
    expect(shown()).toEqual(['B', ['review']])
  })

  it('reads once for the same reasons from several views, and once more for a burst of changes during a read', async () => {
    const { h, s } = source()
    const tasks = {}
    for (let i = 0; i < 5; i++) s.ask('A', [tasks, 1])
    expect(h.calls).toHaveLength(1)
    for (let i = 0; i < 4; i++) s.ask('A', [{}, 1])
    h.calls[0].resolve([badge(1, 'active')])
    await settled()
    expect(h.calls).toHaveLength(2)
    h.calls[1].resolve([badge(1, 'active')])
    await settled()
    expect(h.calls).toHaveLength(2)
  })

  it('keeps what it shows after a failed read, and reads again on the next change', async () => {
    const { h, s, shown } = source()
    s.ask('A', [1])
    h.calls[0].resolve([badge(1, 'active')])
    await settled()
    s.ask('A', [2])
    h.calls[1].reject(new Error('board closed'))
    await settled()
    expect(shown()).toEqual(['A', ['active']])
    s.ask('A', [3])
    expect(h.calls).toHaveLength(3)
    h.calls[2].resolve([badge(1, 'review')])
    await settled()
    expect(shown()).toEqual(['A', ['review']])
  })

  it('keeps an unchanged badge, and what it shows, the same objects', async () => {
    const { h, s } = source()
    s.ask('A', [1])
    h.calls[0].resolve([badge(1, 'active'), badge(2, 'todo')])
    await settled()
    const first = s.get()
    s.ask('A', [2])
    h.calls[1].resolve([badge(1, 'active'), badge(2, 'todo')])
    await settled()
    expect(s.get()).toBe(first)
    s.ask('A', [3])
    h.calls[2].resolve([badge(1, 'active'), badge(2, 'review')])
    await settled()
    expect(s.get()).not.toBe(first)
    expect(s.get().badges.get(1)).toBe(first.badges.get(1))
  })
})

/**
 * Waits until these reads have settled and what the helpers chained on them has run: their own callbacks, then what
 * those started (a queue's next read). Promise callbacks run in order, so this waits for nothing else, and no timer.
 */
const drained = async (reads: Promise<unknown>[]): Promise<void> => {
  await Promise.allSettled(reads)
  await Promise.resolve()
  await Promise.resolve()
}

describe("a view's reads (#1254 round 3)", () => {
  it('latestOnly: only the newest read applies, an older one finishing after it changes nothing (A delayed, B current)', async () => {
    const reads = latestOnly()
    const h = held<string>()
    const applied: string[] = []
    const a = h.fetch('alpha')
    reads.run(a, (v) => applied.push(v))
    const b = h.fetch('beta')
    reads.run(b, (v) => applied.push(v))
    h.calls[1].resolve('beta list')
    await drained([b])
    expect(applied).toEqual(['beta list'])
    h.calls[0].resolve('alpha list')
    await drained([a])
    expect(applied).toEqual(['beta list'])
  })

  it('latestOnly: nothing applies once cancelled (the view hidden or gone)', async () => {
    const reads = latestOnly()
    const h = held<string>()
    const seen: string[] = []
    const a = h.fetch('a')
    reads.run(a, (v) => seen.push(v), () => seen.push('failed'))
    reads.cancel()
    h.calls[0].reject(new Error('late'))
    await drained([a])
    expect(seen).toEqual([])
  })

  it('boundedQueue: at most n at once, each key once; cancelled, what waits never starts and what runs applies nothing', async () => {
    const q = boundedQueue(2)
    const h = held<string>()
    const applied: string[] = []
    const started: string[] = []
    const reads: Promise<string>[] = []
    for (const id of ['s1', 's2', 's3', 's4', 's1']) {
      q.add(
        id,
        () => {
          started.push(id)
          const p = h.fetch(id)
          reads.push(p)
          return p
        },
        (v) => applied.push(v)
      )
    }
    expect(started).toEqual(['s1', 's2'])
    // The tab hidden before the first reads come back.
    q.cancel()
    h.calls[0].resolve('one')
    h.calls[1].resolve('two')
    await drained(reads)
    expect(started).toEqual(['s1', 's2'])
    expect(applied).toEqual([])
    // Shown again: the queue takes new reads.
    q.add('s3', () => (started.push('s3'), Promise.resolve('three')), (v) => applied.push(v))
    await vi.waitFor(() => expect(applied).toEqual(['three']), { timeout: HUNG_MS })
  })

  it('boundedQueue: a read that finishes starts the next waiting one, and applies its result', async () => {
    const q = boundedQueue(1)
    const h = held<string>()
    const applied: string[] = []
    for (const id of ['a', 'b']) q.add(id, () => h.fetch(id), (v) => applied.push(v))
    expect(h.calls.map((c) => c.for)).toEqual(['a'])
    h.calls[0].resolve('A')
    await vi.waitFor(() => expect(h.calls.map((c) => c.for)).toEqual(['a', 'b']), { timeout: HUNG_MS })
    h.calls[1].resolve('B')
    await vi.waitFor(() => expect(applied).toEqual(['A', 'B']), { timeout: HUNG_MS })
  })
})
