// Why and when an agent's session ended (HI-1881): the reason worked out as its CLI exits, and which end a window keeps.
import { describe, expect, it } from 'vitest'
import { endReason, newerEnd, sessionEndBook, type EndsChange, type SessionEnd } from '../src/shared/sessionEnd'

const base = { failed: false, shuttingDown: false, stopRequested: false, code: 0 }

describe('endReason', () => {
  it('a failed launch has none: its failed bar says why', () => {
    expect(endReason({ ...base, failed: true, stopRequested: true, cause: 'you' })).toBeNull()
  })
  it('Combwork quitting comes before any stop asked for', () => {
    expect(endReason({ ...base, shuttingDown: true, stopRequested: true, cause: 'you' })).toBe('quit')
  })
  it("a stop's cause, as its caller gave it", () => {
    for (const cause of ['you', 'assistant', 'agent', 'lane', 'closed'] as const) expect(endReason({ ...base, stopRequested: true, cause })).toBe(cause)
  })
  it('a stop asked without a cause is just stopped, never "by you"', () => {
    expect(endReason({ ...base, stopRequested: true, code: 1 })).toBe('stopped')
  })
  it('a cause left from a stop called off never names a later exit: the CLI crashing is crashed', () => {
    expect(endReason({ ...base, stopRequested: false, cause: 'lane', code: 1 })).toBe('crashed')
  })
  it('the CLI ending by itself: exited with 0, crashed otherwise', () => {
    expect(endReason({ ...base, code: 0 })).toBe('exited')
    expect(endReason({ ...base, code: 1 })).toBe('crashed')
  })
})

describe('newerEnd', () => {
  const end = (runId: string, startedAt: string, why: SessionEnd['why'] = 'you'): SessionEnd => ({ runId, startedAt, at: '2026-10-27T20:46:00Z', why })
  it('the first is kept', () => {
    expect(newerEnd(undefined, end('a', '1'))).toEqual(end('a', '1'))
  })
  it("a later run's end replaces an earlier one's", () => {
    expect(newerEnd(end('a', '2026-10-27T20:00:00Z'), end('b', '2026-10-27T20:30:00Z')).runId).toBe('b')
  })
  it("an older run's end arriving late doesn't replace the newer one's", () => {
    expect(newerEnd(end('b', '2026-10-27T20:30:00Z'), end('a', '2026-10-27T20:00:00Z')).runId).toBe('b')
  })
  it('the same run again leaves the one kept', () => {
    const kept = end('a', '1', 'you')
    expect(newerEnd(kept, end('a', '1', 'crashed'))).toBe(kept)
  })
})

// The window shows ends with the agents' states, a while after they come (HI-1862): the changes are queued in the order
// made and applied together, as flushLiveStates does.
describe('sessionEndBook', () => {
  const K = 'proj|agent'
  const ended = (runId: string, startedAt: string): SessionEnd => ({ runId, startedAt, at: '2026-10-28T02:00:00Z', why: 'you' })
  const apply = (changes: (EndsChange | null)[], ends: Record<string, SessionEnd> = {}) => changes.reduce((e, c) => (c ? c(e) : e), ends)

  it("an older run's end queued before a newer run starts is gone once both are shown, none visible before", () => {
    const book = sessionEndBook()
    const queued = [book.run(K, 'r1')]
    queued.push(book.end(K, ended('r1', '1')))
    // r2 starts before the batch is shown: no end is visible yet.
    queued.push(book.run(K, 'r2'))
    expect(apply(queued)[K]).toBeUndefined()
  })

  it("a run starting drops a kept end of another run, and keeps nothing when there is none", () => {
    const book = sessionEndBook()
    const kept = apply([book.run(K, 'r1'), book.end(K, ended('r1', '1'))])
    expect(kept[K]?.runId).toBe('r1')
    expect(apply([book.run(K, 'r2')], kept)[K]).toBeUndefined()
    // The same run again: no change at all.
    expect(book.run(K, 'r2')).toBeNull()
  })

  it("the current run's end is kept, and a late end of an older run is ignored, when made or when shown", () => {
    const book = sessionEndBook()
    const queued = [book.run(K, 'r1'), book.run(K, 'r2'), book.end(K, ended('r2', '2'))]
    // r1's exit arriving after r2 started: refused as it comes.
    expect(book.end(K, ended('r1', '1'))).toBeNull()
    expect(apply(queued)[K]?.runId).toBe('r2')
    // Accepted before r3 started, applied after: dropped as it is applied.
    const late = book.end(K, ended('r2', '2'))
    const start = book.run(K, 'r3')
    expect(apply([late, start], { [K]: ended('r2', '2') })[K]).toBeUndefined()
    expect(apply([start, late], { [K]: ended('r2', '2') })[K]).toBeUndefined()
  })

  it('forgets an agent gone: its next end is kept whatever run it is', () => {
    const book = sessionEndBook()
    book.run(K, 'r1')
    expect(book.end(K, ended('r0', '0'))).toBeNull()
    book.forget(K)
    expect(apply([book.end(K, ended('r0', '0'))])[K]?.runId).toBe('r0')
  })

  it('leaves the ends the same object when nothing changes, so the store changes nothing', () => {
    const book = sessionEndBook()
    const ends = { other: ended('x', '1') }
    expect(book.run(K, 'r1')!(ends)).toBe(ends)
  })
})
