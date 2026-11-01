// The scenarios' wait for Hive's start of a lane's first card (HI-2278, scenarios.cjs laneStartLanded): it has landed
// only once the card is in Doing, the builder is past starting, and the start's task delivery is offered (or read) with
// its doorbell, which names its id, in what the current launch shows. Never on a delivery uncertain or ended, one still
// queued, one for another card, or one whose line only an earlier launch showed.
import { describe, expect, it } from 'vitest'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
type Delivery = { id: string; kind: string; card?: number; state: string }
type Seen = { column?: string; live?: { status: string } | null; deliveries?: Delivery[]; shown?: string }
const { helpers } = require('./scenarios/scenarios.cjs') as { helpers: { laneStartLanded: (seen: Seen, n: number) => boolean } }
const { laneStartLanded } = helpers

const N = 3
const DOORBELL = '› [Hive] New in your inbox: 1 task (AL-3) (m4). Call hive_inbox to read it, act on it, then ack it.'
const task = (state: string, more: Partial<Delivery> = {}): Delivery => ({ id: 'm4', kind: 'task', card: N, state, ...more })
const seen = (more: Partial<Seen> = {}): Seen => ({ column: 'doing', live: { status: 'ready' }, deliveries: [task('offered')], shown: DOORBELL, ...more })

describe('laneStartLanded (HI-2278)', () => {
  it("has landed: the current launch shows the start's doorbell, its delivery offered or read", () => {
    expect(laneStartLanded(seen(), N)).toBe(true)
    for (const state of ['received', 'acked']) expect(laneStartLanded(seen({ deliveries: [task(state)] }), N)).toBe(true)
    for (const status of ['working', 'finished']) expect(laneStartLanded(seen({ live: { status } }), N)).toBe(true)
  })

  it("hasn't while the delivery is queued, uncertain or ended", () => {
    for (const state of ['queued', 'uncertain', 'cancelled', 'refused', 'expired', 'stale']) expect(laneStartLanded(seen({ deliveries: [task(state)] }), N), state).toBe(false)
  })

  it("hasn't on an earlier launch's delivery while the current launch's is still queued", () => {
    // m2 went into a launch that has ended (its terminal dropped with it); m4 is the current start's, not offered yet.
    const history = [task('received', { id: 'm2' }), task('queued')]
    expect(laneStartLanded(seen({ deliveries: history, shown: 'Welcome to the fake CLI' }), N)).toBe(false)
    // Nor when the current launch shows another id that merely begins the same (m4 is not m41).
    expect(laneStartLanded(seen({ deliveries: [task('offered', { id: 'm4' })], shown: DOORBELL.replace('(m4)', '(m41)') }), N)).toBe(false)
  })

  it("hasn't for another card, another kind, or before the card and the builder are there", () => {
    expect(laneStartLanded(seen({ deliveries: [task('offered', { card: N + 1 })] }), N)).toBe(false)
    expect(laneStartLanded(seen({ deliveries: [task('offered', { kind: 'message' })] }), N)).toBe(false)
    expect(laneStartLanded(seen({ column: 'todo' }), N)).toBe(false)
    expect(laneStartLanded(seen({ live: null }), N)).toBe(false)
    expect(laneStartLanded(seen({ live: { status: 'starting' } }), N)).toBe(false)
    expect(laneStartLanded(seen({ shown: '' }), N)).toBe(false)
    expect(laneStartLanded(seen({ deliveries: [] }), N)).toBe(false)
  })
})
