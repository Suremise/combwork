// HI-2285: a lane's builder watching its own card while nothing on it waits on anyone. The card watch's reply nudges it,
// and only watching on is a stall; a legitimate wait (a question to the user, a design step out, the card in Review) gets
// neither.
import { describe, expect, it } from 'vitest'
import { IDLE_WATCH_STALL_MS, idleWatchReason, idleWatchText, nothingWaitsOn } from '../src/shared/idleWatch'
import { taskWaitText } from '../src/shared/toolReplies'
import type { TaskCard } from '../src/shared/types'

const t0 = Date.parse('2026-11-01T13:33:00.000Z')
const at = (min: number): string => new Date(t0 + min * 60_000).toISOString()
const card = (over: Partial<TaskCard> = {}): TaskCard => ({ number: 5, key: 'CL-5', title: 'Broker', project: 'cli', column: 'doing', agent: 'cb1', blocked: null, archived: false, labels: [], blockedBy: [], links: [], comments: [], history: [{ at: at(-60), by: 'CB1 (cli)', what: 'Moved to Doing' }], ...over }) as unknown as TaskCard
const lane = { builder: 'cb1', state: 'active', cards: [{ number: 5 }] }
const cb1 = { name: 'CB1', agentId: 'cb1', cards: [5], status: 'watching', watchSince: at(0) }
const designOut = [{ at: at(-60), by: 'CB1 (cli)', what: 'Moved to Doing' }, { at: at(-1), by: 'CB1 (cli)', what: 'Posted a design for the reviewer to check: "Plan"' }]

describe('nothing waits on the card (HI-2285)', () => {
  it('its own card in Doing, not blocked, no design step out, no For you request: nothing waits', () => {
    expect(nothingWaitsOn(card(), 'cb1', false)).toBe(true)
  })
  it('a legitimate wait: a question open for the user, a design step out, the card in Review or later', () => {
    expect(nothingWaitsOn(card(), 'cb1', true)).toBe(false)
    expect(nothingWaitsOn(card({ history: designOut as TaskCard['history'] }), 'cb1', false)).toBe(false)
    for (const column of ['review', 'passed', 'done', 'todo'] as const) expect(nothingWaitsOn(card({ column }), 'cb1', false)).toBe(false)
  })
  it("blocked, archived, or another agent's card: not this check's", () => {
    expect(nothingWaitsOn(card({ blocked: 'Waits for HI-1' }), 'cb1', false)).toBe(false)
    expect(nothingWaitsOn(card({ archived: true }), 'cb1', false)).toBe(false)
    expect(nothingWaitsOn(card(), 'cb2', false)).toBe(false)
  })
  it('a design answered no longer waits', () => {
    const answered = [...designOut, { at: at(0), by: 'CR1 (cli)', what: 'Checked the design: OK: "Fine"' }]
    expect(nothingWaitsOn(card({ history: answered as TaskCard['history'] }), 'cb1', false)).toBe(true)
  })
})

describe("the card watch's reply (HI-2285)", () => {
  it('nudges the builder to carry on or ask, in place of "End your turn now"', () => {
    const t = taskWaitText({ watching: 'Waiting for #5', limitAt: 'T', idle: 5 })
    expect(t).toBe(`Waiting for #5. ${idleWatchText({ number: 5 })} Hive types a line into this session when it changes, or at T if nothing does.`)
    expect(t).toMatch(/Nothing waits on #5: it is in Doing and not submitted, with no question open for the user and no design step out for the reviewer/)
    expect(t).toMatch(/hive_ask_user .*hive_loop_step/)
    expect(t).toMatch(/stalled after 5 min/)
    expect(t).not.toMatch(/End your turn now/)
  })
  it('a legitimate watch (no idle card) replies as before', () => {
    expect(taskWaitText({ watching: 'Waiting for #5', limitAt: 'T' })).toBe('Waiting for #5. End your turn now: Hive types a line into this session when it changes, or at T if nothing does. Nothing runs meanwhile.')
  })
  it('a card with commits to hand over says that first, not the nudge', () => {
    expect(taskWaitText({ watching: 'Waiting for #5', limitAt: 'T', idle: 5, unsubmitted: [{ card: 5, count: 1, atLeast: false, since: 'ab30f52' }] })).toMatch(/^Waiting for #5\. First hand #5 over/)
  })
})

describe('only watching it is a stall (HI-2285)', () => {
  it('stalled once its builder has only watched it IDLE_WATCH_STALL_MS; not before', () => {
    expect(idleWatchReason(card(), lane, cb1, t0 + IDLE_WATCH_STALL_MS - 1000)).toBeNull()
    expect(idleWatchReason(card(), lane, cb1, t0 + IDLE_WATCH_STALL_MS)).toBe('CB1 only watches CL-5 (5 min), and nothing waits on it: no question for the user, no design step, not submitted.')
  })
  it('not while it works (a watch kept in a turn), watches more than this card, or the watch time is unknown', () => {
    const late = t0 + 60 * 60_000
    expect(idleWatchReason(card(), lane, { ...cb1, status: 'working' }, late)).toBeNull()
    expect(idleWatchReason(card(), lane, { ...cb1, cards: [5, 6] }, late)).toBeNull()
    expect(idleWatchReason(card(), lane, { ...cb1, watchSince: undefined }, late)).toBeNull()
    // HR2's round 1: usage (or lanes, agents) watched beside the card is a wait on more than it.
    expect(idleWatchReason(card(), lane, { ...cb1, watchesMore: true }, late)).toBeNull()
  })
  // HI-2445: on HI-2433 HB1 watched its card from submission; 7 min later HR1 failed it, and the card was stalled at once,
  // its 7 min watching through Review counted as idle in Doing while HB1's wake was on its way.
  it('timed from when the card came back to Doing, not from when a watch kept through Review began', () => {
    const failed = card({ history: [{ at: at(-60), by: 'CB1 (cli)', what: 'Moved to Doing' }, { at: at(0), by: 'CB1 (cli)', what: 'Moved to Review' }, { at: at(7), by: 'CR1 (cli)', what: 'Review failed' }, { at: at(7), by: 'CR1 (cli)', what: 'Moved to Doing' }] as TaskCard['history'] })
    const verdict = t0 + 7 * 60_000
    expect(idleWatchReason(failed, lane, cb1, verdict + 5000)).toBeNull()
    expect(idleWatchReason(failed, lane, cb1, verdict + IDLE_WATCH_STALL_MS - 1000)).toBeNull()
    // Still only watching it IDLE_WATCH_STALL_MS after it came back: a real stall, timed from the verdict.
    expect(idleWatchReason(failed, lane, cb1, verdict + IDLE_WATCH_STALL_MS)).toBe('CB1 only watches CL-5 (5 min), and nothing waits on it: no question for the user, no design step, not submitted.')
  })
  it('a watch begun after the card came back to Doing is timed from its start', () => {
    expect(idleWatchReason(card(), lane, { ...cb1, watchSince: at(10) }, t0 + 10 * 60_000 + IDLE_WATCH_STALL_MS - 1000)).toBeNull()
    expect(idleWatchReason(card(), lane, { ...cb1, watchSince: at(10) }, t0 + 10 * 60_000 + IDLE_WATCH_STALL_MS)).not.toBeNull()
  })
  it("not in a paused lane, outside a lane, or when the watcher isn't the lane's builder", () => {
    const late = t0 + 60 * 60_000
    expect(idleWatchReason(card(), { ...lane, state: 'paused' }, cb1, late)).toBeNull()
    expect(idleWatchReason(card(), null, cb1, late)).toBeNull()
    expect(idleWatchReason(card(), { ...lane, cards: [{ number: 6 }] }, cb1, late)).toBeNull()
    expect(idleWatchReason(card(), { ...lane, builder: 'cb2' }, { ...cb1, agentId: 'cb2' }, late)).toBeNull()
  })
})
