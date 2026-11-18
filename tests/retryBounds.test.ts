// HI-3374: retries under a time bound with waits growing to a cap (retryBounds.ts): a rename held for 5 s goes through;
// only a transient error is retried; no attempt after the bound or once the guard refuses (the owner gone while waiting);
// the read bound's waits are exactly 50 to 1600 ms. Time is faked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { untilBound, retryWhile, retryWait, triesWithin, RENAME_RETRY, INDEX_BUSY, heldError } = await import('../src/main/retryBounds')
const { renameRetrying } = await import('../src/main/fsutil')

beforeEach(() => void vi.useFakeTimers())
afterEach(() => void vi.useRealTimers())

const held = (): Error => Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })

describe('the bounds (HI-3374)', () => {
  it('a rename: 15 s, waits from 15 ms growing by 10, capped at 250; a busy index: 30 s, 10 s, and a read of 3.2 s (50 to 1600 ms)', () => {
    expect(RENAME_RETRY.boundMs).toBe(15_000)
    expect([0, 1, 2, 30].map((n) => retryWait(RENAME_RETRY, n))).toEqual([15, 25, 35, 250])
    expect(INDEX_BUSY.take.boundMs).toBe(30_000)
    expect(INDEX_BUSY.publish.boundMs).toBe(10_000)
    expect([0, 1, 2, 3, 4, 5, 6].map((n) => retryWait(INDEX_BUSY.read, n))).toEqual([50, 100, 200, 400, 800, 1600, 1600])
    expect(INDEX_BUSY.read.boundMs).toBe(3200)
    expect(triesWithin(INDEX_BUSY.read)).toBe(7)
  })
})

describe('untilBound (HI-3374)', () => {
  it('a rename held for 5 s, then let through: done (renameRetrying)', async () => {
    const start = Date.now()
    const once = vi.fn(async () => {
      if (Date.now() - start < 5000) throw held()
    })
    let done = false
    void renameRetrying('a', 'b', RENAME_RETRY, undefined, once).then(() => (done = true))
    await vi.advanceTimersByTimeAsync(5300)
    expect(done).toBe(true)
    expect(once.mock.calls.length).toBeGreaterThan(10)
  })

  it('held past the bound: the last error thrown, told once, no attempt after the bound', async () => {
    const at: number[] = []
    const gaveUp = vi.fn()
    const start = Date.now()
    let err: unknown = null
    void untilBound(
      () => {
        at.push(Date.now() - start)
        throw held()
      },
      { bound: RENAME_RETRY, transient: heldError, onGaveUp: gaveUp }
    ).catch((e) => (err = e))
    await vi.advanceTimersByTimeAsync(RENAME_RETRY.boundMs + 1000)
    expect((err as { code?: string })?.code).toBe('EPERM')
    expect(gaveUp).toHaveBeenCalledTimes(1)
    expect(Math.max(...at)).toBeLessThan(RENAME_RETRY.boundMs)
  })

  it('an error that is not transient: thrown at once, no retry', async () => {
    const once = vi.fn(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    await expect(untilBound(once, { bound: RENAME_RETRY, transient: heldError })).rejects.toThrow('ENOENT')
    expect(once).toHaveBeenCalledTimes(1)
  })

  it('the owner gone while it waits (the guard refusing): no attempt after, and the guard\'s error thrown', async () => {
    let owner = true
    const once = vi.fn(() => {
      throw held()
    })
    let err: unknown = null
    void untilBound(once, {
      bound: RENAME_RETRY,
      transient: heldError,
      guard: () => {
        if (!owner) throw new Error('owner gone')
      }
    }).catch((e) => (err = e))
    await vi.advanceTimersByTimeAsync(100)
    const tries = once.mock.calls.length
    owner = false
    await vi.advanceTimersByTimeAsync(1000)
    expect((err as Error)?.message).toBe('owner gone')
    expect(once.mock.calls.length).toBe(tries)
  })

  it('a guard refusing at once: no attempt at all', async () => {
    const once = vi.fn()
    await expect(untilBound(once, { bound: RENAME_RETRY, transient: heldError, guard: () => Promise.reject(new Error('closed')) })).rejects.toThrow('closed')
    expect(once).not.toHaveBeenCalled()
  })
})

describe("the time left read after each awaited guard (HR3's round 1)", () => {
  const bound = { boundMs: 100, firstMs: 10, capMs: 10 }

  it('untilBound: a guard that takes the rest of the time leaves no attempt after it', async () => {
    let t = 0
    const attempt = vi.fn(() => {
      throw held()
    })
    let err: unknown = null
    void untilBound(attempt, {
      bound,
      transient: heldError,
      now: () => t,
      sleep: async () => undefined,
      // After the first attempt, the guard (an owner check, say) itself takes past the bound.
      guard: async () => void (attempt.mock.calls.length && (t += 200))
    }).catch((e) => (err = e))
    await vi.advanceTimersByTimeAsync(0)
    expect(attempt).toHaveBeenCalledTimes(1)
    expect((err as { code?: string })?.code).toBe('EPERM')
  })

  it('retryWhile: the same', async () => {
    let t = 0
    const attempt = vi.fn(() => 'busy')
    let got: string | null = null
    void retryWhile(attempt, (r) => r === 'busy', { bound, now: () => t, sleep: async () => undefined, guard: async () => void (attempt.mock.calls.length && (t += 200)) }).then((r) => (got = r))
    await vi.advanceTimersByTimeAsync(0)
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(got).toBe('busy')
  })
})

describe('retryWhile (HI-3374)', () => {
  it('a result busy for 1 s, then fine: the fine one; always busy: the last within 3.2 s, at most 7 tries', async () => {
    const start = Date.now()
    let got: string | null = null
    void retryWhile(() => (Date.now() - start < 1000 ? 'busy' : 'ok'), (r) => r === 'busy', { bound: INDEX_BUSY.read }).then((r) => (got = r))
    await vi.advanceTimersByTimeAsync(2000)
    expect(got).toBe('ok')
    const attempt = vi.fn(() => 'busy')
    let last: string | null = null
    void retryWhile(attempt, (r) => r === 'busy', { bound: INDEX_BUSY.read }).then((r) => (last = r))
    await vi.advanceTimersByTimeAsync(5000)
    expect(last).toBe('busy')
    expect(attempt.mock.calls.length).toBeLessThanOrEqual(triesWithin(INDEX_BUSY.read))
  })
})
