// The Sessions tab's Clean Up… (#895): which sessions archive or delete takes by age, and which it always leaves alone.
import { describe, expect, it } from 'vitest'
import { CLEANUP_AGE_MS, cleanupPlan, lastActive, type CleanupAction, type CleanupAge } from '../src/shared/sessionCleanup'
import type { SessionListItem } from '../src/shared/types'

const NOW = Date.parse('2026-10-15T12:00:00.000Z')
const HOUR = 3600_000
const ago = (ms: number): string => new Date(NOW - ms).toISOString()
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const item = (n: number, hoursAgo: number, more: Partial<SessionListItem> = {}): SessionListItem => ({
  id: id(n),
  provider: 'claude-code',
  source: 'combwork',
  title: null,
  lastActivity: ago(hoursAgo * HOUR),
  archived: false,
  hasTranscript: true,
  hasBackup: true,
  usage: null,
  recache: null,
  ...more
})
const plan = (items: SessionListItem[], age: CleanupAge, action: CleanupAction, more: { live?: string[]; shown?: string | null; current?: string | null } = {}) => {
  const p = cleanupPlan(items, { age, action, now: NOW, live: (s) => (more.live ?? []).includes(s), shown: more.shown, current: more.current })
  return { go: p.go.map((s) => s.id), skipped: p.skipped.map((s) => [s.item.id, s.reason]) }
}

describe('cleanupPlan: the age cut-off', () => {
  const items = [item(1, 1), item(2, 23), item(3, 25), item(4, 24 * 6), item(5, 24 * 8), item(6, 24 * 29), item(7, 24 * 31)]
  it('takes what was last active longer ago than each age', () => {
    expect(plan(items, 'day', 'archive').go).toEqual([id(3), id(4), id(5), id(6), id(7)])
    expect(plan(items, 'week', 'archive').go).toEqual([id(5), id(6), id(7)])
    expect(plan(items, 'month', 'archive').go).toEqual([id(7)])
  })
  it('keeps a session last active exactly at the cut-off, and takes one a moment older', () => {
    const at = item(1, 0, { lastActivity: ago(CLEANUP_AGE_MS.week) })
    const older = item(2, 0, { lastActivity: ago(CLEANUP_AGE_MS.week + 1) })
    expect(plan([at, older], 'week', 'delete').go).toEqual([id(2)])
  })
  it('goes by last activity, not by when the session started', () => {
    const startedLongAgo = item(1, 2, { createdAt: ago(40 * 24 * HOUR) })
    expect(plan([startedLongAgo], 'month', 'delete').go).toEqual([])
  })
  it("falls back to the record's last update, then its start, and keeps a session with no time known", () => {
    const fromRecord = item(1, 0, { lastActivity: null, lastActiveAt: ago(10 * 24 * HOUR) })
    const fromStart = item(2, 0, { lastActivity: null, createdAt: ago(10 * 24 * HOUR) })
    const unknown = item(3, 0, { lastActivity: null })
    const garbled = item(4, 0, { lastActivity: 'not a date' })
    expect(plan([fromRecord, fromStart, unknown, garbled], 'week', 'delete').go).toEqual([id(1), id(2)])
    expect(lastActive(unknown)).toBeNull()
  })
  it('judges a sub-session by its own activity', () => {
    const parent = item(1, 24 * 10)
    const recentSub = item(2, 2, { sub: { parentId: id(1), kind: 'guardian review' } })
    const oldSub = item(3, 24 * 10, { sub: { parentId: id(1), kind: 'guardian review' } })
    expect(plan([parent, recentSub, oldSub], 'week', 'delete').go).toEqual([id(1), id(3)])
  })
})

describe('cleanupPlan: what each action takes', () => {
  const items = [item(1, 24 * 10), item(2, 24 * 10, { archived: true }), item(3, 24 * 10, { source: 'external' })]
  it("archive takes only Combwork's own sessions that aren't archived yet", () => {
    expect(plan(items, 'week', 'archive').go).toEqual([id(1)])
  })
  it('delete takes every old session, archived and external ones too', () => {
    expect(plan(items, 'week', 'delete').go).toEqual([id(1), id(2), id(3)])
  })
})

describe('cleanupPlan: what it always leaves alone', () => {
  const items = [item(1, 24 * 10), item(2, 24 * 10), item(3, 24 * 10), item(4, 24 * 10), item(5, 1)]
  it('skips running sessions, the one open in the tab and the Assistant’s current conversation, and says why', () => {
    for (const action of ['archive', 'delete'] as const) {
      const p = plan(items, 'week', action, { live: [id(1), id(5)], shown: id(2), current: id(3) })
      expect(p.go).toEqual([id(4)])
      expect(p.skipped).toEqual([
        [id(1), 'live'],
        [id(2), 'shown'],
        [id(3), 'current']
      ])
    }
  })
  it('lists only old sessions it skips: a recent running one is not old enough to mention', () => {
    expect(plan(items, 'week', 'delete', { live: [id(5)] }).skipped).toEqual([])
  })
  it('a running session is said to be running even when it is also the one open', () => {
    expect(plan([item(1, 24 * 10)], 'week', 'delete', { live: [id(1)], shown: id(1), current: id(1) }).skipped).toEqual([[id(1), 'live']])
  })
  it("doesn't mention a skip the action wouldn't have taken anyway", () => {
    expect(plan([item(1, 24 * 10, { archived: true })], 'week', 'archive', { shown: id(1) }).skipped).toEqual([])
  })
})
