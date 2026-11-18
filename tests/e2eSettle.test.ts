// HI-3384, HR1's round 1: the e2e suites' bounded settling (lib.cjs within and steady). A call Playwright doesn't bound
// (a page.evaluate waiting for a frame, an IPC round trip) is raced against its deadline, and a read that never settles
// says so: neither is ever taken as done when its deadline passes. On simulated time, so nothing here waits.
import { createRequire } from 'module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { timing } from './timing.cjs'

const { within, steady } = createRequire(import.meta.url)('./e2e/lib.cjs') as {
  within: (p: Promise<unknown>, ms: number) => Promise<boolean>
  steady: (read: () => unknown, ms: number) => Promise<boolean>
}
const DEADLINE = timing('hang.ui')

describe("lib.cjs's bounded settling (HI-3384)", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('within: true once the call answers before its deadline', async () => {
    let answer: (v: unknown) => void = () => undefined
    const out = within(new Promise((r) => (answer = r)), DEADLINE)
    answer('drawn')
    expect(await out).toBe(true)
  })

  it('within: a frame that never arrives is false at its deadline, not before, and never taken as drawn', async () => {
    let done: boolean | null = null
    void within(new Promise(() => undefined), DEADLINE).then((v) => (done = v))
    await vi.advanceTimersByTimeAsync(DEADLINE - 1)
    expect(done).toBe(null)
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toBe(false)
  })

  it("within: a call's failure is thrown, not taken as an answer or as a missed deadline", async () => {
    await expect(within(Promise.reject(new Error('page closed')), DEADLINE)).rejects.toThrow('page closed')
  })

  it('within: needs its deadline', async () => {
    await expect(within(Promise.resolve(), undefined as unknown as number)).rejects.toThrow(/deadline/)
  })

  it('steady: a read the same twice a look apart settles', async () => {
    const out = steady(() => [900, 600], DEADLINE)
    await vi.advanceTimersByTimeAsync(timing('poll.intervalMs'))
    expect(await out).toBe(true)
  })

  it('steady: a read that changes for a while settles once it stops, never on its first look', async () => {
    let n = 0
    let settled: boolean | null = null
    void steady(() => Math.min(++n, 5), DEADLINE).then((v) => (settled = v))
    await vi.advanceTimersByTimeAsync(timing('poll.intervalMs') * 3)
    expect(settled).toBe(null)
    await vi.advanceTimersByTimeAsync(timing('poll.intervalMs') * 3)
    expect(settled).toBe(true)
    expect(n).toBeGreaterThanOrEqual(6)
  })

  it('steady: geometry that never stabilises is false at its deadline, not taken as settled', async () => {
    let n = 0
    let settled: boolean | null = null
    void steady(() => ({ x: n++ }), DEADLINE).then((v) => (settled = v))
    await vi.advanceTimersByTimeAsync(DEADLINE - timing('poll.intervalMs'))
    expect(settled).toBe(null)
    await vi.advanceTimersByTimeAsync(timing('poll.intervalMs') * 2)
    expect(settled).toBe(false)
  })
})
