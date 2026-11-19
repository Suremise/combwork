// HI-3384, HR1's round 1: the e2e suites' bounded settling (lib.cjs within and steady). A call Playwright doesn't bound
// (a page.evaluate waiting for a frame, an IPC round trip) is raced against its deadline, and a read that never settles
// says so: neither is ever taken as done when its deadline passes. On simulated time, so nothing here waits.
import { createRequire } from 'module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { timing } from './timing.cjs'

const { within, steady, exitWithin } = createRequire(import.meta.url)('./e2e/lib.cjs') as {
  within: (p: Promise<unknown>, ms: number) => Promise<boolean>
  steady: (read: () => unknown, ms: number) => Promise<boolean>
  exitWithin: (proc: { kill: () => void }, exited: Promise<unknown>, ms: number, what: string) => Promise<void>
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

  it('steady: a first read that never answers is false at its deadline, not before (HR1, round 2)', async () => {
    let settled: boolean | null = null
    void steady(() => new Promise(() => undefined), DEADLINE).then((v) => (settled = v))
    await vi.advanceTimersByTimeAsync(DEADLINE - 1)
    expect(settled).toBe(null)
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('steady: a read that stalls after a first answer is false at its deadline, and no read starts after it (HR1, round 2)', async () => {
    let reads = 0
    let settled: boolean | null = null
    void steady(() => (++reads === 1 ? Promise.resolve([900, 600]) : new Promise(() => undefined)), DEADLINE).then((v) => (settled = v))
    await vi.advanceTimersByTimeAsync(DEADLINE)
    expect(settled).toBe(false)
    expect(reads).toBe(2)
    await vi.advanceTimersByTimeAsync(DEADLINE)
    expect(reads).toBe(2)
  })

  it("steady: a read's failure is thrown, the deadline's timer cleared", async () => {
    await expect(steady(() => Promise.reject(new Error('page closed')), DEADLINE)).rejects.toThrow('page closed')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('steady: geometry that never stabilises is false at its deadline, not taken as settled', async () => {
    let n = 0
    let settled: boolean | null = null
    void steady(() => ({ x: n++ }), DEADLINE).then((v) => (settled = v))
    await vi.advanceTimersByTimeAsync(DEADLINE - timing('poll.intervalMs'))
    expect(settled).toBe(null)
    await vi.advanceTimersByTimeAsync(timing('poll.intervalMs') * 2)
    expect(settled).toBe(false)
    // Past its deadline, no further read.
    const at = n
    await vi.advanceTimersByTimeAsync(DEADLINE)
    expect(n).toBe(at)
  })
  // HI-3397, HR1's round 1: a quit awaited (update.cjs's Restart and Update): the next launch never goes on as if it had quit.
  it('exitWithin: an exit in time returns, ending nothing', async () => {
    const proc = { kill: vi.fn() }
    await exitWithin(proc, Promise.resolve(0), DEADLINE, 'Restart and Update')
    expect(proc.kill).not.toHaveBeenCalled()
  })

  it("exitWithin: an exit that never comes ends that process by its handle and throws at its deadline, never a pass", async () => {
    const proc = { kill: vi.fn() }
    let out: string | null = null
    void exitWithin(proc, new Promise(() => undefined), DEADLINE, 'Restart and Update').then(
      () => (out = 'returned'),
      (e: Error) => (out = e.message)
    )
    await vi.advanceTimersByTimeAsync(DEADLINE - 1)
    expect(out).toBe(null)
    expect(proc.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(proc.kill).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(DEADLINE)
    expect(out).toMatch(/Restart and Update: the app didn't exit/)
  })

  it('exitWithin: ended by its handle and exiting then, it still throws (the quit itself never came)', async () => {
    let exit: (v: unknown) => void = () => undefined
    const exited = new Promise((r) => (exit = r))
    const proc = { kill: vi.fn(() => exit(1)) }
    const out = exitWithin(proc, exited, DEADLINE, 'Restart and Update')
    const caught = out.catch((e: Error) => e.message)
    await vi.advanceTimersByTimeAsync(DEADLINE)
    expect(await caught).toMatch(/didn't exit/)
    expect(proc.kill).toHaveBeenCalledTimes(1)
  })
})
