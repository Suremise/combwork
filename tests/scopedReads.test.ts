// HI-3505 (HR2's round 1): Changes' status reads (renderer scopedReads.ts): one at a time per folder, one more after it
// for what was asked meanwhile; another folder's read starts at once, and the earlier folder's reads are over, never
// taken and never read again.
import { describe, expect, it } from 'vitest'
import { scopedReader } from '../src/renderer/src/scopedReads'

/** A read whose answers the test gives, in the order it chooses. */
function held() {
  const calls: { scope: string; answer: (v: string) => void; fail: (e: unknown) => void }[] = []
  const taken: string[] = []
  const reload = scopedReader<string>(
    (scope) => new Promise<string>((answer, fail) => calls.push({ scope, answer, fail })),
    (scope, a) => taken.push(a.ok ? `${scope}=${a.value}` : `${scope}!`)
  )
  return { calls, taken, reload }
}
/** Lets settled promises run their callbacks. */
const flush = (): Promise<void> => new Promise((r) => setImmediate(r))

describe('scopedReader', () => {
  it("a slow read of folder A, then folder B shown and an event for B while A is pending: B stays, A is never read again", async () => {
    const { calls, taken, reload } = held()
    reload('A')
    reload('A') // an event for A while its read is under way: one more after it, while A is still shown
    reload('B') // B shown
    expect(calls.map((c) => c.scope)).toEqual(['A', 'B'])
    calls[1].answer('b1')
    await flush()
    expect(taken).toEqual(['B=b1'])
    reload('B') // a file event or the focus, for B, with A still pending
    expect(calls.map((c) => c.scope)).toEqual(['A', 'B', 'B'])
    calls[0].answer('a1') // A's answer comes late
    await flush()
    calls[2].answer('b2')
    await flush()
    expect(taken).toEqual(['B=b1', 'B=b2'])
    expect(calls.map((c) => c.scope)).toEqual(['A', 'B', 'B'])
  })

  it('asked again while a read is under way: one more read after it, however many times', async () => {
    const { calls, taken, reload } = held()
    reload('A')
    reload('A')
    reload('A')
    expect(calls).toHaveLength(1)
    calls[0].answer('1')
    await flush()
    expect(calls.map((c) => c.scope)).toEqual(['A', 'A'])
    calls[1].answer('2')
    await flush()
    expect(taken).toEqual(['A=1', 'A=2'])
    expect(calls).toHaveLength(2)
  })

  it("a failed read is taken as a failure, and what was asked meanwhile still reads again", async () => {
    const { calls, taken, reload } = held()
    reload('A')
    reload('A')
    calls[0].fail(new Error('no'))
    await flush()
    expect(taken).toEqual(['A!'])
    calls[1].answer('ok')
    await flush()
    expect(taken).toEqual(['A!', 'A=ok'])
  })

  it("back to folder A after B: A's old read is still over; A's new one is taken", async () => {
    const { calls, taken, reload } = held()
    reload('A')
    reload('B')
    reload('A')
    expect(calls.map((c) => c.scope)).toEqual(['A', 'B', 'A'])
    calls[0].answer('old')
    calls[1].answer('b')
    await flush()
    expect(taken).toEqual([])
    calls[2].answer('new')
    await flush()
    expect(taken).toEqual(['A=new'])
  })
})
