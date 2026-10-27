// Why and when an agent's session ended (HI-1881): the reason worked out as its CLI exits, and which end a window keeps.
import { describe, expect, it } from 'vitest'
import { endReason, newerEnd, type SessionEnd } from '../src/shared/sessionEnd'

const base = { failed: false, shuttingDown: false, stopRequested: false, code: 0 }

describe('endReason', () => {
  it('a failed launch has none: its failed bar says why', () => {
    expect(endReason({ ...base, failed: true, stopRequested: true, cause: 'you' })).toBeNull()
  })
  it('Hive quitting comes before any stop asked for', () => {
    expect(endReason({ ...base, shuttingDown: true, stopRequested: true, cause: 'you' })).toBe('quit')
  })
  it("a stop's cause, as its caller gave it", () => {
    for (const cause of ['you', 'assistant', 'agent', 'lane', 'closed'] as const) expect(endReason({ ...base, stopRequested: true, cause })).toBe(cause)
  })
  it('a stop asked without a cause is just stopped, never "by you"', () => {
    expect(endReason({ ...base, stopRequested: true, code: 1 })).toBe('stopped')
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
