// Lane watches (#531): the Assistant watches whole lanes, not cards. What counts (shared/laneWatch.ts: a failed review,
// a card blocked or stalled, a lane due to merge, ended or abandoned; passes and moves only when asked), the wake line
// within its size, and the watches themselves (main/watches.ts): "all" follows every running lane, lanes started later
// and cards added too, with no card limit; plain moves stay quiet; a watch after a wake counts what happened in between.
// The sessions are stand-ins here (the e2e lanewatch suite runs fake Claude Code agents).
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { LANE_CARD_CHANGES, LANE_DEFAULT_EVENTS, MERGE_STALL_MS, blockNewsAt, keepAsked, laneHits, laneLimitLine, laneWakeLine, mergeStallReason, readLaneCards, readLaneCondition, readSavedLaneMark, type LaneMark, type LaneNow } from '../src/shared/laneWatch'
import { WAKE_MAX_BYTES, type CardChange } from '../src/shared/watch'
import { taskWaitText } from '../src/shared/toolReplies'
import { REVIEW_WAIT_STALL_MS } from '../src/shared/tasks'
import { IDLE_WATCH_STALL_MS } from '../src/shared/idleWatch'
import { tempDir } from './tempDir'
import { putStoreDocs, storeDocs } from './storeDocs'
import { tr } from '../src/shared/i18n'
import { watchText } from '../src/shared/agentWatch'
import { follow } from './followDoorbell'
import { LANE_NEXT_STALL_MS, laneNextWaitReason, replyWaitReason, RETURN_STALL_MS, returnedWaitReason, setStallRuns, STALE_STALL_MS, staleWaitReason } from '../src/main/cardStall'
import type { ProgressRun } from '../src/shared/types'
import { resetAgentStartsForTests, startBegun, startEnded } from '../src/main/agentStarts'
/** The merge queue's returns as queueReturnOf finds them (HI-1721), by card: none unless a test sets one. */
const { returns, stales } = vi.hoisted(() => ({ returns: new Map<number, { at: string; text: string; builder: string | null }>(), stales: new Map<number, { since: string; approved: string | null; current: string | null }>() }))
vi.mock('../src/main/queueReturn', () => ({ queueReturnOf: async (_ws: unknown, _p: string, n: number) => returns.get(n) ?? null, returnIn: () => null, resubmittedOf: async () => null, resubmittedIn: () => null, staleApprovalOf: async (_ws: unknown, _p: string, n: number) => stales.get(n) ?? null, staleIn: () => null }))
/** Agents queued to resume after a restart (HI-1707's isResuming), by id: none unless a test sets one. */
const { resuming } = vi.hoisted(() => ({ resuming: new Set<string>() }))
vi.mock('../src/main/restartResume', async (orig) => ({ ...(await orig<object>()), isResuming: (_p: string, id: string) => resuming.has(id) }))
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const card = (over: Partial<LaneMark['cards'][string]> = {}) => ({ c: 'doing' as const, b: false, s: false, f: '', p: '', ...over })

describe('what a lane watch counts (#531)', () => {
  it('the condition: lane ids or "all", and events (default: all but passed and moved)', () => {
    expect(readLaneCondition({ lanes: ['all'] })).toEqual({ ids: 'all', events: LANE_DEFAULT_EVENTS })
    expect(readLaneCondition({ lanes: ['lane-1a2b3c', 'lane-4d5e6f'], events: ['failed', 'passed'] })).toEqual({ ids: ['lane-1a2b3c', 'lane-4d5e6f'], events: ['failed', 'passed', 'paused-user', 'ended', 'abandoned'] })
    expect(readLaneCondition({ lanes: [] })).toMatch(/lanes must be/)
    expect(readLaneCondition({ lanes: ['a b'] })).toMatch(/lanes must be/)
    expect(readLaneCondition({ lanes: ['all'], events: ['merged'] })).toMatch(/events must be/)
    expect(LANE_DEFAULT_EVENTS).not.toContain('passed')
    expect(LANE_DEFAULT_EVENTS).not.toContain('moved')
  })

  it("each event since the lane's mark, only those asked for; a lane or card new to the watch starts from now", () => {
    const before: LaneMark = { state: 'active', mergeDue: false, cards: { 1: card({ c: 'review' }), 2: card(), 3: card({ b: true }) } }
    const now = (mark: LaneMark, extra: Partial<LaneNow['cards'][number]>[] = []): LaneNow => ({ id: 'lane-1', label: 'B1 / R1', mark, cards: Object.keys(mark.cards).map((n, i) => ({ number: Number(n), blocked: null, stalled: null, failedBy: null, passedBy: null, ...extra[i] })) })
    const later: LaneMark = { state: 'active', mergeDue: false, cards: { 1: card({ c: 'review', f: '2026-10-11T00:00:00.000Z' }), 2: card({ c: 'review', b: true }), 3: card({ b: true, s: true }), 4: card({ b: true }) } }
    const hit = laneHits(before, now(later, [{ failedBy: 'R1 (alpha)' }, { blocked: 'Which icon?' }, { stalled: "B1 isn't running." }]), LANE_DEFAULT_EVENTS)!
    expect(hit.parts.map((p) => p.text)).toEqual(['#1 failed review (R1 (alpha))', '#2 is blocked', '#3 is stalled'])
    expect(hit.parts[1].detail).toBe('Which icon?')
    // #2's move to Review counts only when asked; #4 is new to the lane: from now.
    expect(laneHits(before, now(later), ['moved'])!.parts.map((p) => p.text)).toEqual(['#2 is in Review'])
    expect(laneHits(null, now(later), LANE_DEFAULT_EVENTS)).toBeNull()
    expect(laneHits(before, now(before), LANE_DEFAULT_EVENTS)).toBeNull()
    // The lane: due to merge once every card passed (or done), ended, abandoned.
    const passed: LaneMark = { state: 'active', mergeDue: true, cards: { 1: card({ c: 'passed' }) } }
    expect(laneHits({ ...before, cards: { 1: card() } }, now(passed), LANE_DEFAULT_EVENTS)!.parts.map((p) => p.event)).toEqual(['merge-due'])
    expect(laneHits(passed, now({ ...passed, state: 'ended', mergeDue: false }), LANE_DEFAULT_EVENTS)!.parts.map((p) => p.text)).toEqual(['ended (merged)'])
    expect(laneHits(passed, now({ ...passed, state: 'abandoned' }), LANE_DEFAULT_EVENTS)!.parts.map((p) => p.text)).toEqual(['was abandoned'])
  })

  it("a card still blocked with news (its reason changed, its agent commented) is told as reblocked by default; a fresh block as blocked; a mark from before never (#1475)", () => {
    const now = (mark: LaneMark): LaneNow => ({ id: 'lane-1', label: 'B1 / R1', mark, cards: Object.keys(mark.cards).map((n) => ({ number: Number(n), blocked: mark.cards[n].b ? 'Screenshots for your OK' : null, stalled: null, failedBy: null, passedBy: null })) })
    const t1 = '2026-10-23T06:00:00.000Z'
    const t2 = '2026-10-23T06:52:00.000Z'
    const was: LaneMark = { state: 'active', mergeDue: false, cards: { 1: card({ c: 'passed', b: true, r: t1 }) } }
    const news: LaneMark = { ...was, cards: { 1: card({ c: 'passed', b: true, r: t2 }) } }
    expect(LANE_DEFAULT_EVENTS).toContain('reblocked')
    expect(laneHits(was, now(news), LANE_DEFAULT_EVENTS)!.parts).toEqual([{ n: 1, event: 'reblocked', text: '#1 is still blocked, with news', detail: 'Screenshots for your OK' }])
    expect(laneHits(was, now(news), ['blocked', 'unblocked'])).toBeNull()
    expect(laneHits(was, now(was), LANE_DEFAULT_EVENTS)).toBeNull()
    // A fresh block is one event (blocked), and a mark saved before #1475 (no r) never fires it.
    expect(laneHits({ ...was, cards: { 1: card({ c: 'passed' }) } }, now(news), LANE_DEFAULT_EVENTS)!.parts.map((p) => p.event)).toEqual(['blocked'])
    expect(laneHits({ ...was, cards: { 1: card({ c: 'passed', b: true }) } }, now(news), LANE_DEFAULT_EVENTS)).toBeNull()
    // The news: the reason last set, or the card's agent's latest comment, whichever is later; others' comments aren't news.
    const history = [{ at: t1, by: 'HB2 (alpha)', what: 'Blocked: Screenshots for your OK' }]
    const base = { blocked: 'Screenshots for your OK', history, agentName: 'HB2', comments: [{ at: t2, by: 'Assistant', text: 'Looking' }] } as unknown as Parameters<typeof blockNewsAt>[0]
    expect(blockNewsAt(base)).toBe(t1)
    expect(blockNewsAt({ ...base, comments: [{ at: t2, by: 'HB2 (alpha)', text: 'Re-shot' }] } as typeof base)).toBe(t2)
    expect(blockNewsAt({ ...base, history: [...history, { at: t2, by: 'HB2 (alpha)', what: 'Blocked: Re-shot: your OK please' }] } as typeof base)).toBe(t2)
    expect(blockNewsAt({ ...base, blocked: null } as typeof base)).toBe('')
    // Saved and read back with its news; one from before reads without.
    expect(readSavedLaneMark(JSON.parse(JSON.stringify(news)))).toEqual(news)
    expect(readSavedLaneMark(JSON.parse(JSON.stringify(was)))!.cards[1].r).toBe(t1)
    expect(readSavedLaneMark({ ...was, cards: { 1: { ...card(), r: 'soon' } } })).toBeNull()
  })

  // HI-1991: a builder's cw_ask_user sat under For you for 20 minutes: its builder wasn't waiting at a prompt, and the
  // Assistant had dropped `paused`, which also fired on every merge.
  it('a question for the user on a lane card is always told (paused-user), whatever the events; a merge pause is paused-merge, and paused still reads as it', () => {
    const t0 = '2026-10-29T00:00:00.000Z'
    const t1 = '2026-10-29T00:10:00.000Z'
    const t2 = '2026-10-29T00:20:00.000Z'
    expect(LANE_DEFAULT_EVENTS).toContain('paused-user')
    expect(LANE_DEFAULT_EVENTS).not.toContain('paused-merge')
    expect(readLaneCondition({ lanes: ['all'], events: ['failed'] })).toEqual({ ids: 'all', events: ['failed', 'paused-user'] })
    expect(readLaneCondition({ lanes: ['all'], events: ['paused', 'failed'] })).toEqual({ ids: 'all', events: ['paused-merge', 'failed', 'paused-user'] })
    expect(readLaneCondition({ lanes: ['all'], events: ['paused-merge', 'paused-user'] })).toEqual({ ids: 'all', events: ['paused-merge', 'paused-user'] })
    const now = (q: string, asked: LaneNow['cards'][number]['asked'] = null): LaneNow => ({ id: 'lane-1', label: 'B1 / R1', mark: { state: 'active', mergeDue: false, cards: { 1: card({ q }) } }, cards: [{ number: 1, blocked: null, stalled: null, failedBy: null, passedBy: null, asked }] })
    const was: LaneMark = { state: 'active', mergeDue: false, cards: { 1: card({ q: '' }) } }
    const ask = { since: t1, by: 'HB6', text: 'Push the tag now?\nIt is v1.0.0.' }
    expect(laneHits(was, now(t1, ask), ['failed', 'paused-user'])!.parts).toEqual([{ n: 1, event: 'paused-user', text: '#1 waits for the user (HB6 asks)', detail: 'Push the tag now?' }])
    // Combwork's own request (no asker), a second question after the first, none new, one answered: told, told, quiet, quiet.
    expect(laneHits(was, now(t1, { since: t1, by: null, text: 'Approve the merge?' }), ['paused-user'])!.parts[0].text).toBe('#1 waits for the user (Combwork asks)')
    expect(laneHits(now(t1).mark, now(t2, { ...ask, since: t2 }), ['paused-user'])).not.toBeNull()
    expect(laneHits(now(t1).mark, now(t1, ask), ['paused-user'])).toBeNull()
    expect(laneHits(now(t1).mark, now(''), ['paused-user'])).toBeNull()
    // Not asked for (a lane notice's own events): not told. A mark from before (no q) never fires it.
    expect(laneHits(was, now(t1, ask), ['failed'])).toBeNull()
    expect(laneHits({ ...was, cards: { 1: card() } }, now(t1, ask), ['paused-user'])).toBeNull()
    // A card new to the lane: a question since the watch began is told, one before it isn't.
    expect(laneHits({ ...was, cards: {} }, now(t1, ask), ['paused-user'], t0)).not.toBeNull()
    expect(laneHits({ ...was, cards: {} }, now(t0, { ...ask, since: t0 }), ['paused-user'], t1)).toBeNull()
    // Its line says to tell the user, never answer for them; the mark keeps q.
    expect(laneWakeLine([laneHits(was, now(t1, ask), ['paused-user'])!])).toBe('[CW] Lane B1 / R1: #1 waits for the user (HB6 asks): "Push the tag now?". Your lane watch has ended: read the cards named (cw_read_task), act on them, tell the user what an agent waits for (cw_notify) and never answer it for them, then watch the lanes again (cw_wait_for_tasks with lanes).')
    expect(readSavedLaneMark(JSON.parse(JSON.stringify(now(t1).mark)))!.cards[1].q).toBe(t1)
    expect(readSavedLaneMark({ ...was, cards: { 1: { ...card(), q: 'soon' } } })).toBeNull()
    // The merge pause, its own event and line; a pause for the user isn't one.
    const paused = (status: LaneNow['status']): LaneNow => ({ ...now(''), mark: { state: 'paused', mergeDue: false, cards: { 1: card({ c: 'passed', q: '' }) } }, status })
    expect(laneHits(was, paused({ reason: 'merging', card: 1 }), ['paused-merge'])!.parts).toEqual([{ n: 1, event: 'paused-merge', text: 'paused for a merge: waiting: #1 merging', detail: 'merging' }])
    expect(laneHits(was, paused({ reason: 'you', card: 1 }), ['paused-merge'])).toBeNull()
    expect(laneHits(was, paused({ reason: 'merging', card: 1 }), ['paused-user'])).toBeNull()
  })

  // HI-1991 round 1 finding: a round that couldn't read the requests saved marks without q, and the question asked
  // meanwhile was then taken as the baseline, never told.
  it("requests that couldn't be read keep the last mark's q (or the watch's start, for a card new to it), so a question asked meanwhile is told once read", () => {
    const t0 = '2026-10-29T00:00:00.000Z'
    const t1 = '2026-10-29T00:10:00.000Z'
    const unread: LaneMark = { state: 'active', mergeDue: false, cards: { 1: card(), 2: card() } }
    const kept = keepAsked({ state: 'active', mergeDue: false, cards: { 1: card({ q: '' }) } }, unread, t0)
    expect(kept.cards[1].q).toBe('')
    expect(kept.cards[2].q).toBe(t0)
    // Read again: the question since is told.
    const now: LaneNow = { id: 'lane-1', label: 'B1 / R1', mark: { ...unread, cards: { 1: card({ q: t1 }), 2: card({ q: '' }) } }, cards: [{ number: 1, blocked: null, stalled: null, failedBy: null, passedBy: null, asked: { since: t1, by: 'HB6', text: 'Go on?' } }, { number: 2, blocked: null, stalled: null, failedBy: null, passedBy: null, asked: null }] }
    expect(laneHits(kept, now, ['paused-user'])!.parts.map((p) => p.n)).toEqual([1])
    // Read marks are kept as they are; a card whose last mark is from before (no q) stays without one.
    expect(keepAsked(null, now.mark, t0)).toBe(now.mark)
    expect(keepAsked({ ...unread, cards: { 1: card() } }, unread, t0).cards[1].q).toBeUndefined()
  })

  it('a block lifted is told by default (#922, #1272); a lane ended with its merge commit names it (#1270), else as before', () => {
    const now = (mark: LaneMark, mergeCommit?: string | null): LaneNow => ({ id: 'lane-1', label: 'B1 / R1', mark, cards: Object.keys(mark.cards).map((n) => ({ number: Number(n), blocked: mark.cards[n].b ? 'Push refused' : null, stalled: null, failedBy: null, passedBy: null })), ...(mergeCommit !== undefined ? { mergeCommit } : {}) })
    const blocked: LaneMark = { state: 'active', mergeDue: false, cards: { 1: card({ b: true }), 2: card() } }
    const lifted: LaneMark = { ...blocked, cards: { 1: card(), 2: card() } }
    expect(LANE_DEFAULT_EVENTS).toContain('unblocked')
    expect(laneHits(blocked, now(lifted), LANE_DEFAULT_EVENTS)!.parts).toEqual([{ n: 1, event: 'unblocked', text: '#1 is no longer blocked' }])
    expect(laneHits(blocked, now(lifted), ['blocked', 'failed'])).toBeNull()
    // Blocked again: a block, not an unblock; a card new to the lane starts unblocked, so nothing is lifted.
    expect(laneHits(lifted, now(blocked), LANE_DEFAULT_EVENTS)!.parts.map((p) => p.event)).toEqual(['blocked'])
    expect(laneHits({ ...blocked, cards: { 2: card() } }, now(lifted), LANE_DEFAULT_EVENTS, '2026-10-01T00:00:00.000Z')).toBeNull()
    const passed: LaneMark = { state: 'active', mergeDue: true, cards: { 1: card({ c: 'passed' }) } }
    const ended: LaneMark = { ...passed, state: 'ended', mergeDue: false }
    expect(laneHits(passed, now(ended, 'dd4ed990c0ffee1234567890'), LANE_DEFAULT_EVENTS)!.parts.map((p) => p.text)).toEqual(['ended: merged at dd4ed990c0ff'])
    expect(laneHits(passed, now(ended, null), LANE_DEFAULT_EVENTS)!.parts.map((p) => p.text)).toEqual(['ended (merged)'])
  })

  // #869: lane G's cards all passed, its builder's commit was refused and it ended its turn after telling the user; merge-due
  // had been told and nothing else woke the Assistant for two hours.
  describe('a merge that stalls (#869)', () => {
    const t0 = Date.parse('2026-10-15T00:00:00.000Z')
    const at = (ms: number): string => new Date(t0 + ms).toISOString()
    const passed = { mark: card({ c: 'passed', p: at(0) }), updatedAt: at(0) }
    const lane = (over: Partial<Parameters<typeof mergeStallReason>[0]> = {}) => ({ state: 'active' as const, builder: 'HB1', cards: [passed, { ...passed, mark: card({ c: 'done' }) }], ...over })
    const idle = { status: 'finished' as const, statusSince: at(60_000) }
    const after = (ms: number): number => t0 + 60_000 + ms

    it('every card passed, its builder idle with no merge slot for the limit: stalled, with why', () => {
      expect(mergeStallReason(lane(), idle, after(MERGE_STALL_MS - 1))).toBeNull()
      expect(mergeStallReason(lane(), idle, after(MERGE_STALL_MS + 2 * 60_000))).toBe('Every card passed, but HB1 has been idle for 12 min with no merge slot claimed.')
      expect(mergeStallReason(lane(), { status: 'ready' }, t0 + MERGE_STALL_MS)).toMatch(/idle for 10 min/)
      // Not running at all: from its cards' last change.
      expect(mergeStallReason(lane(), null, t0 + MERGE_STALL_MS)).toBe("Every card passed, but HB1 isn't running.")
      expect(mergeStallReason(lane(), null, t0 + MERGE_STALL_MS - 1)).toBeNull()
    })

    it('not while its builder works, watches, waits for the user or has a background task or a merge slot; not before every card passed, nor with one blocked', () => {
      const late = after(MERGE_STALL_MS * 3)
      expect(mergeStallReason(lane(), idle, late)).not.toBeNull()
      for (const status of ['working', 'watching', 'waiting', 'background', 'starting', 'signin'] as const) expect(mergeStallReason(lane(), { ...idle, status }, late), status).toBeNull()
      expect(mergeStallReason(lane(), { ...idle, backgroundTasks: 1 }, late)).toBeNull()
      expect(mergeStallReason(lane(), { ...idle, mergeSlot: 'Waiting for the merge slot (B4 is merging #305)' }, late)).toBeNull()
      expect(mergeStallReason(lane({ cards: [passed, { mark: card({ c: 'review' }), updatedAt: at(0) }] }), idle, late)).toBeNull()
      expect(mergeStallReason(lane({ cards: [{ ...passed, mark: card({ c: 'done' }) }] }), idle, late)).toBeNull()
      // A blocked card is told as blocked: the builder asked the user, as card-loop says.
      expect(mergeStallReason(lane({ cards: [{ ...passed, mark: card({ c: 'passed', b: true }) }] }), idle, late)).toBeNull()
      for (const state of ['ended', 'abandoned', 'gone'] as const) expect(mergeStallReason(lane({ state }), idle, late), state).toBeNull()
      // A card changed lately (a comment on it) starts the time again.
      expect(mergeStallReason(lane({ cards: [{ ...passed, updatedAt: new Date(late - 60_000).toISOString() }] }), idle, late)).toBeNull()
    })

    it('a lane watch tells it once, as stalled, with the reason; the mark is kept on disk', () => {
      const due: LaneMark = { state: 'active', mergeDue: true, cards: { 1: card({ c: 'passed' }) } }
      const now = (mark: LaneMark, mergeStall: string | null = null): LaneNow => ({ id: 'lane-g', label: 'HB1 / HR1 (lane G)', mark, cards: [{ number: 1, blocked: null, stalled: null, failedBy: null, passedBy: null }], mergeStall })
      const why = 'Every card passed, but HB1 has been idle for 12 min with no merge slot claimed.'
      expect(laneHits(due, now(due), LANE_DEFAULT_EVENTS)).toBeNull()
      const hit = laneHits(due, now({ ...due, ms: true }, why), LANE_DEFAULT_EVENTS)!
      expect(hit.parts).toEqual([{ n: null, event: 'stalled', text: 'its merge is stalled', detail: why }])
      expect(laneWakeLine([hit])).toMatch(/^\[CW\] Lane HB1 \/ HR1 \(lane G\): its merge is stalled: "Every card passed, but HB1 has been idle for 12 min with no merge slot claimed\."\. Your lane watch has ended/)
      expect(laneHits({ ...due, ms: true }, now({ ...due, ms: true }, why), LANE_DEFAULT_EVENTS)).toBeNull()
      expect(laneHits(due, now({ ...due, ms: true }, why), ['failed', 'merge-due'])).toBeNull()
      expect(readSavedLaneMark(JSON.parse(JSON.stringify({ ...due, ms: true })))).toEqual({ ...due, ms: true })
      expect(readSavedLaneMark(JSON.parse(JSON.stringify(due)))).toEqual(due)
    })
  })

  it("the reply to a lane watch: lean, with the events only when they aren't the default", () => {
    expect(taskWaitText({ watching: 'Waiting on all running lanes', limitAt: 'T', events: [...LANE_DEFAULT_EVENTS] })).toBe('Waiting on all running lanes. End your turn now: Combwork types a line into this session on a lane event, or at T if none comes.')
    expect(taskWaitText({ watching: 'Waiting on 2 lanes', limitAt: 'T', events: ['failed', 'passed'], replaced: 'Waiting for #12 → Review' })).toBe('Waiting on 2 lanes (failed, passed). End your turn now: Combwork types a line into this session on a lane event, or at T if none comes. It replaces your watch (waiting for #12 → Review).')
  })

  it('the wake line names each lane and card, within the size: details give way, then labels, then each lane is counted', () => {
    const hit = (i: number, detail = 'Which icon should the app use? A bee, a honeycomb or a comb cell.') => ({ id: `lane-${i}`, label: `Builder${i} / Reviewer${i} (lane ${i})`, parts: [{ n: 100 + i, event: 'blocked' as const, text: `#${100 + i} is blocked`, detail }, { n: 200 + i, event: 'failed' as const, text: `#${200 + i} failed review (Reviewer${i} (alpha))` }] })
    expect(laneWakeLine([hit(1)])).toBe(`[CW] Lane Builder1 / Reviewer1 (lane 1): #101 is blocked: "Which icon should the app use? A bee, a honeycomb or a comb cell."; #201 failed review (Reviewer1 (alpha)). Your lane watch has ended: read the cards named (cw_read_task), act on them, then watch the lanes again (cw_wait_for_tasks with lanes).`)
    for (const n of [3, 7, 20, 60]) {
      const line = laneWakeLine(Array.from({ length: n }, (_, i) => hit(i, '評'.repeat(300))))
      expect(Buffer.byteLength(JSON.stringify(line))).toBeLessThanOrEqual(WAKE_MAX_BYTES)
      expect(line).toMatch(/^\[CW\] .*Your lane watch has ended/)
      if (n <= 7) for (let i = 0; i < n; i++) expect(line).toContain(`#${100 + i}`)
    }
  })

  it('cards beside the lanes (#726): left out they are kept, [] drops them; their changes default to comment, column and verdict', () => {
    expect(LANE_DEFAULT_EVENTS).toContain('waiting')
    expect(readLaneCards({})).toEqual({})
    expect(LANE_CARD_CHANGES).toEqual(['comment', 'column', 'verdict'])
    expect(readLaneCards({ cards: [] })).toEqual({ cards: [] })
    expect(readLaneCards({ cards: [720, 721], changes: ['comment'] })).toEqual({ cards: [720, 721], changes: ['comment'] })
    expect(readLaneCards({ cards: [7, 7] })).toMatch(/cards must be/)
    expect(readLaneCards({ cards: Array.from({ length: 21 }, (_, i) => i + 1) })).toMatch(/at most 20/)
    expect(readLaneCards({ cards: [7], changes: ['blocked'] })).toMatch(/changes must be/)
    // The reply says whether its cards were kept, replaced or dropped.
    expect(taskWaitText({ watching: 'Waiting on all running lanes and #720', limitAt: 'T', events: [...LANE_DEFAULT_EVENTS], cards: { now: [720], kept: true } })).toBe('Waiting on all running lanes and #720. End your turn now: Combwork types a line into this session on a lane event or a change to #720, or at T if none comes. It kept #720 from your last lane watch (cards: [] for none).')
    expect(taskWaitText({ watching: 'Waiting on all running lanes and #721', limitAt: 'T', events: [...LANE_DEFAULT_EVENTS], cards: { now: [721], replaced: [720] } })).toContain('Its cards replace #720.')
    expect(taskWaitText({ watching: 'Waiting on all running lanes', limitAt: 'T', events: [...LANE_DEFAULT_EVENTS], cards: { now: [], replaced: [720] } })).toContain('It no longer watches #720.')
    expect(taskWaitText({ watching: 'Waiting on all running lanes and #720', limitAt: 'T', events: [...LANE_DEFAULT_EVENTS], cards: { now: [720], kept: true, dropped: [719] } })).toContain('#719 left it (done or gone).')
  })

  it('one line tells the lanes, the cards beside them and the agents waiting for the user, within the size (#726)', () => {
    const lane = { id: 'lane-1', label: 'B1 / R1', parts: [{ n: 12, event: 'failed' as const, text: '#12 failed review (R1 (alpha))' }] }
    const rel: CardChange = { number: 720, column: 'review', changes: ['comment'], by: 'HB6 (alpha)', comment: { by: 'HB6 (alpha)', firstLine: 'Draft release is up: push when ready' }, about: { owner: 'HB6', verdict: null } }
    const wait = { name: 'HB6', project: 'alpha', card: 720, what: 'Claude needs your permission to use Bash' }
    expect(laneWakeLine([lane], { cards: [rel], waits: [wait], watching: true })).toBe(
      `[CW] Lane B1 / R1: #12 failed review (R1 (alpha)) | #720 (HB6's card) is in Review (latest comment by HB6 (alpha): "Draft release is up: push when ready") | HB6 (alpha) is waiting for the user on #720: "Claude needs your permission to use Bash". Your lane watch has ended: read the cards named (cw_read_task), act on them, tell the user what an agent waits for (cw_notify) and never answer it for them, then watch the lanes again (cw_wait_for_tasks with lanes; your cards stay unless you pass cards).`
    )
    // Only what happened: a wait alone, or a card alone.
    expect(laneWakeLine([], { waits: [{ ...wait, card: null, what: null }] })).toMatch(/^\[CW\] HB6 \(alpha\) is waiting for the user\. Your lane watch has ended/)
    expect(laneWakeLine([], { cards: [{ ...rel, changes: ['blocked'], blocked: 'Darren pushes the tag' }], watching: true })).toMatch(/^\[CW\] #720 \(HB6's card\) is in Review and blocked: "Darren pushes the tag" \(latest comment/)
    for (const n of [3, 10, 40]) {
      const many = laneWakeLine(
        Array.from({ length: n }, (_, i) => ({ ...lane, id: `lane-${i}`, label: `Builder${i} / Reviewer${i} (lane ${i})` })),
        { cards: Array.from({ length: Math.min(n, 20) }, (_, i) => ({ ...rel, number: 700 + i, comment: { by: 'HB6', firstLine: '評'.repeat(200) } })), waits: Array.from({ length: n }, (_, i) => ({ ...wait, name: `Agent${i}`, what: '評'.repeat(200) })), watching: true }
      )
      expect(Buffer.byteLength(JSON.stringify(many))).toBeLessThanOrEqual(WAKE_MAX_BYTES)
      expect(many).toMatch(/^\[CW\] .*Your lane watch has ended.*never answer it for them/)
    }
  })
})

describe("an approved card whose pass went stale, waiting for its builder (HI-1763's staleWaitReason)", () => {
  const since = '2026-10-26T21:55:12.000Z'
  const t = Date.parse(since)
  const c = { number: 1739, key: 'HI-1737', column: 'passed' as const, archived: false, blocked: null }
  const stale = { since, approved: 'e89aa2fc1234', current: 'bd6ff9da5678' }
  it('stalled once stale for 10 min since its Stale fact, its builder idle or only watching; never while it is in a turn, a watch kept or not', () => {
    expect(staleWaitReason(c, stale, { name: 'HB4', status: 'watching', watching: true }, t + STALE_STALL_MS)).toBe("HI-1737's pass is for e89aa2f but its line is at bd6ff9d; HB4 is only watching it, not submitting it.")
    expect(staleWaitReason(c, stale, { name: 'HB4', status: 'finished', watching: false }, t + STALE_STALL_MS)).toMatch(/HB4 is idle, not submitting it/)
    for (const status of ['working', 'starting', 'waiting', 'background']) expect(staleWaitReason(c, stale, { name: 'HB4', status, watching: true }, t + 3 * STALE_STALL_MS), status).toBeNull()
    expect(staleWaitReason(c, stale, { name: 'HB4', status: 'watching', watching: true }, t + STALE_STALL_MS - 1000)).toBeNull()
  })
  it('not for a card out of Passed, blocked, or with no stale pass', () => {
    const watching = { name: 'HB4', status: 'watching', watching: true }
    expect(staleWaitReason({ ...c, column: 'doing' }, stale, watching, t + 2 * STALE_STALL_MS)).toBeNull()
    expect(staleWaitReason({ ...c, blocked: 'Which icon?' }, stale, watching, t + 2 * STALE_STALL_MS)).toBeNull()
    expect(staleWaitReason(c, null, watching, t + 2 * STALE_STALL_MS)).toBeNull()
  })
})

describe("a builder's reply waiting on an idle reviewer (HI-2428's replyWaitReason)", () => {
  const asked = '2026-11-03T03:57:01.000Z'
  const replied = '2026-11-03T04:25:08.000Z'
  const t = Date.parse(replied)
  const c = {
    number: 2458,
    key: 'HI-2410',
    column: 'review' as const,
    archived: false,
    blocked: null,
    project: 'alpha',
    review: { agent: 'a-r1', agentName: 'HR1', since: '2026-11-03T03:53:20.000Z' },
    history: [
      { at: '2026-11-03T03:53:13.000Z', by: 'HB2 (alpha)', what: 'Moved to Review' },
      { at: asked, by: 'HR1 (alpha)', what: 'Asked the builder: "Please post a full npm test record."' },
      { at: replied, by: 'HB2 (alpha)', what: 'Replied to the reviewer: "Full run: 8948 passed."' }
    ],
    comments: [
      { at: asked, by: 'HR1 (alpha)', text: 'Please post a full npm test record.' },
      { at: replied, by: 'HB2 (alpha)', text: 'Full run: 8948 passed.' }
    ]
  }
  const idle = { name: 'HR1', status: 'finished' }
  it('stalled 15 min after the reply while its reviewer, watching or not, and its builder are both out of a turn', () => {
    expect(replyWaitReason(c, idle, { status: 'finished' }, null, t + REVIEW_WAIT_STALL_MS)).toBe("HI-2410's builder replied to HR1 15 min ago; HR1 is idle, with no verdict or answer since.")
    expect(replyWaitReason(c, { name: 'HR1', status: 'watching' }, { status: 'watching' }, null, t + REVIEW_WAIT_STALL_MS)).toMatch(/HR1 is only watching/)
    expect(replyWaitReason(c, idle, null, null, t + REVIEW_WAIT_STALL_MS - 1000)).toBeNull()
  })
  it('not while either is in a turn, the builder has a job for the card running, or the reviewer has written since', () => {
    for (const status of ['working', 'starting', 'waiting']) {
      expect(replyWaitReason(c, { name: 'HR1', status }, null, null, t + 3 * REVIEW_WAIT_STALL_MS), `reviewer ${status}`).toBeNull()
      expect(replyWaitReason(c, idle, { status }, null, t + 3 * REVIEW_WAIT_STALL_MS), `builder ${status}`).toBeNull()
    }
    expect(replyWaitReason(c, idle, null, { running: true, endedAt: null }, t + 3 * REVIEW_WAIT_STALL_MS)).toBeNull()
    // A job that ended starts the clock again from its end.
    expect(replyWaitReason(c, idle, null, { running: false, endedAt: t + REVIEW_WAIT_STALL_MS }, t + REVIEW_WAIT_STALL_MS + 60_000)).toBeNull()
    const later = new Date(t + 60_000).toISOString()
    expect(replyWaitReason({ ...c, comments: [...c.comments, { at: later, by: 'HR1 (alpha)', text: 'Reading it.' }] }, idle, null, null, t + 3 * REVIEW_WAIT_STALL_MS)).toBeNull()
  })
  it('not before any reply, nor for a card out of Review, blocked, or with no review started', () => {
    expect(replyWaitReason({ ...c, history: c.history.slice(0, 2) }, idle, null, null, t + 3 * REVIEW_WAIT_STALL_MS)).toBeNull()
    expect(replyWaitReason({ ...c, column: 'passed' }, idle, null, null, t + 3 * REVIEW_WAIT_STALL_MS)).toBeNull()
    expect(replyWaitReason({ ...c, blocked: 'Which icon?' }, idle, null, null, t + 3 * REVIEW_WAIT_STALL_MS)).toBeNull()
    expect(replyWaitReason({ ...c, review: undefined }, idle, null, null, t + 3 * REVIEW_WAIT_STALL_MS)).toBeNull()
  })
})

describe("a card the merge queue returned, waiting for its builder (HI-1721's returnedWaitReason)", () => {
  const at = '2026-10-26T12:34:35.000Z'
  const t = Date.parse(at)
  const c = { number: 1696, key: 'HI-1694', column: 'doing' as const, archived: false, blocked: null, updatedAt: at }
  const back = { at }
  it('stalled once it has waited 15 min, its builder idle or only watching; not while it works, nor before', () => {
    expect(returnedWaitReason(c, back, { name: 'HB2', status: 'watching', watching: true }, t + RETURN_STALL_MS)).toBe('HI-1694 came back from the merge queue 15 min ago; HB2 is only watching it, not fixing it.')
    expect(returnedWaitReason(c, back, { name: 'HB2', status: 'finished', watching: false }, t + RETURN_STALL_MS + 60_000)).toMatch(/16 min ago; HB2 is idle, not fixing it/)
    expect(returnedWaitReason(c, back, { name: 'HB2', status: 'working', watching: false }, t + 3 * RETURN_STALL_MS)).toBeNull()
    // In a turn with a watch still kept (a loop wake leaves it running): at work, never "only watching" (HR1's round 1).
    for (const status of ['working', 'starting', 'background', 'waiting']) expect(returnedWaitReason(c, back, { name: 'HB2', status, watching: true }, t + RETURN_STALL_MS + 2 * 60_000), status).toBeNull()
    expect(returnedWaitReason(c, back, { name: 'HB2', status: 'watching', watching: true }, t + RETURN_STALL_MS - 1000)).toBeNull()
  })
  it('not for a card that changed since, is blocked, out of Doing, or not returned', () => {
    const later = new Date(t + 10 * 60_000).toISOString()
    const watching = { name: 'HB2', status: 'watching', watching: true }
    expect(returnedWaitReason({ ...c, updatedAt: later }, back, watching, t + RETURN_STALL_MS + 60_000)).toBeNull()
    expect(returnedWaitReason({ ...c, blocked: 'Which icon?' }, back, watching, t + 2 * RETURN_STALL_MS)).toBeNull()
    expect(returnedWaitReason({ ...c, column: 'review' }, back, watching, t + 2 * RETURN_STALL_MS)).toBeNull()
    expect(returnedWaitReason(c, null, watching, t + 2 * RETURN_STALL_MS)).toBeNull()
  })
})

describe("a running lane's next card its builder hasn't started (HI-1741's laneNextWaitReason)", () => {
  const at = '2026-10-26T18:17:05.000Z'
  const t = Date.parse(at)
  const lane = { builder: 'hb3', reviewer: 'hr3', state: 'active', cards: [{ number: 1729, key: 'HI-1727', column: 'done', movedAt: at }, { number: 1737, key: 'HI-1735', column: 'todo', movedAt: null }, { number: 1743, key: 'HI-1741', column: 'todo', movedAt: null }] }
  const c = { number: 1737, key: 'HI-1735', column: 'todo' as const, archived: false, blocked: null }
  it('stalled once the card before it has been Done 15 min, its builder idle, only watching or not running; not while it works, nor before', () => {
    expect(laneNextWaitReason(c, lane, { name: 'HB3', status: 'finished' }, t + LANE_NEXT_STALL_MS)).toBe("HI-1735 is the lane's next card: HI-1727 went Done 15 min ago, and HB3 is idle without starting it.")
    expect(laneNextWaitReason(c, lane, { name: 'HB3', status: 'watching' }, t + LANE_NEXT_STALL_MS + 60_000)).toMatch(/16 min ago, and HB3 is only watching without starting it/)
    expect(laneNextWaitReason(c, lane, { name: 'HB3', status: null }, t + LANE_NEXT_STALL_MS)).toMatch(/and HB3 isn't running without starting it/)
    for (const status of ['working', 'starting', 'background', 'waiting']) expect(laneNextWaitReason(c, lane, { name: 'HB3', status }, t + 3 * LANE_NEXT_STALL_MS), status).toBeNull()
    expect(laneNextWaitReason(c, lane, { name: 'HB3', status: 'finished' }, t + LANE_NEXT_STALL_MS - 1000)).toBeNull()
  })
  it('not for a paused lane, a card not next (one before it not Done, or the first), one blocked, started or archived, or no lane', () => {
    const idle = { name: 'HB3', status: 'finished' }
    const late = t + 2 * LANE_NEXT_STALL_MS
    expect(laneNextWaitReason(c, { ...lane, state: 'paused' }, idle, late)).toBeNull()
    expect(laneNextWaitReason({ ...c, number: 1743, key: 'HI-1741' }, lane, idle, late)).toBeNull()
    expect(laneNextWaitReason({ ...c, number: 1729, key: 'HI-1727' }, { ...lane, cards: [{ ...lane.cards[0], column: 'todo' }, ...lane.cards.slice(1)] }, idle, late)).toBeNull()
    expect(laneNextWaitReason({ ...c, blocked: 'Which slot?' }, lane, idle, late)).toBeNull()
    expect(laneNextWaitReason({ ...c, column: 'doing' }, lane, idle, late)).toBeNull()
    expect(laneNextWaitReason({ ...c, archived: true }, lane, idle, late)).toBeNull()
    expect(laneNextWaitReason(c, null, idle, late)).toBeNull()
    // When the card before it went Done isn't known: no stall.
    expect(laneNextWaitReason(c, { ...lane, cards: [{ ...lane.cards[0], movedAt: null }, ...lane.cards.slice(1)] }, idle, late)).toBeNull()
  })
  it("its first card too (HI-2029): stalled 15 min after the lane started, its builder idle without starting it", () => {
    const first = { ...lane, startedAt: at, cards: [{ number: 1729, key: 'HI-1727', column: 'todo', movedAt: null }, ...lane.cards.slice(1)] }
    const card1 = { ...c, number: 1729, key: 'HI-1727' }
    expect(laneNextWaitReason(card1, first, { name: 'LB1', status: 'finished' }, t + LANE_NEXT_STALL_MS)).toBe("HI-1727 is the lane's first card: the lane started 15 min ago, and LB1 is idle without starting it.")
    expect(laneNextWaitReason(card1, first, { name: 'LB1', status: 'finished' }, t + LANE_NEXT_STALL_MS - 1000)).toBeNull()
    expect(laneNextWaitReason(card1, first, { name: 'LB1', status: 'working' }, t + 2 * LANE_NEXT_STALL_MS)).toBeNull()
  })
  it("not while its start waits for a card it depends on to be Done (HI-2129: HB5 watching HI-2108 for HI-2118); the usual stall once it doesn't", () => {
    const first = { ...lane, startedAt: at, cards: [{ number: 2124, key: 'HI-2118', column: 'todo', movedAt: null }] }
    const card1 = { ...c, number: 2124, key: 'HI-2118' }
    const late = t + 2 * LANE_NEXT_STALL_MS
    expect(laneNextWaitReason(card1, { ...first, waitsForDependency: { card: 2124, on: 'HI-2108' } }, { name: 'HB5', status: 'watching' }, late)).toBeNull()
    expect(laneNextWaitReason(card1, { ...first, waitsForDependency: { card: 2124, on: 'HI-2108' } }, { name: 'HB5', status: 'finished' }, late)).toBeNull()
    // Another card's wait says nothing of this one.
    expect(laneNextWaitReason(card1, { ...first, waitsForDependency: { card: 9999, on: 'HI-2108' } }, { name: 'HB5', status: 'watching' }, late)).toMatch(/HI-2118 is the lane's first card: .* HB5 is only watching without starting it/)
    expect(laneNextWaitReason(card1, first, { name: 'HB5', status: 'watching' }, late)).toMatch(/HB5 is only watching without starting it/)
  })
})

describe('lane watches (main/watches.ts, #531)', async () => {
  const base = tempDir('cw-lanewatch-')
  ;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
  afterAll(() => rmSync(base, { recursive: true, force: true }))
  const { contextWorkspace, createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
  const tasks = await import('../src/main/tasks')
  const watches = await import('../src/main/watches')
  watches.testHooks.settleMs = 0
  // A check reads what Combwork did after `await watches.settled()`: deliveries run in the background (#570).
  const lanes = await import('../src/main/lanes')

  /** Workflow rules off for one test (#1270: Combwork owns the lane while they are on), on again after it. */
  const { advanced } = await import('../src/main/advanced')
  const { ENFORCE } = await import('../src/main/workflow/service')
  const rulesOff = (): Promise<unknown> => advanced.set(ENFORCE, false)
  afterEach(async () => {
    await advanced.set(ENFORCE, true)
  })
  const { sessions } = await import('../src/main/sessions')
  let k = 0
  const open = async (builders = 3) => {
    const path = join(base, `ws-${++k}`)
    const alpha = join(path, 'alpha')
    mkdirSync(join(alpha, '.combwork'), { recursive: true })
    writeFileSync(join(alpha, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [...Array.from({ length: builders }, (_, i) => `b${i + 1}`), 'r1', 'r2'].map((id) => ({ id, name: id.toUpperCase() })) }))
    const w = createWorkspaceService()
    await w.open(path)
    mkdirSync(w.assistantHome, { recursive: true })
    return { w, alpha, home: w.assistantHome }
  }
  /**
   * The Assistant (watching, then working once typed into; #650: it follows Combwork's doorbell with cw_inbox, and what it
   * read is `told`), and every agent of alpha running and working.
   */
  const fake = (alpha: string, home: string) => {
    // `agents`: an alpha agent's status other than working (#726: one waiting for the user).
    const st = { status: 'watching' as string, typed: [] as string[], told: [] as string[], agents: {} as Record<string, string> }
    Object.assign(sessions, {
      liveFor: (p: string, id: string) => (p.toLowerCase() === home.toLowerCase() && id === 'assistant' ? ({ projectPath: home, agentId: 'assistant', status: st.status, runId: 'a1' } as never) : p.toLowerCase() === alpha.toLowerCase() ? ({ projectPath: alpha, agentId: id, status: st.agents[id] ?? 'working', runId: id } as never) : null),
      liveStates: () => [],
      userMayBeTyping: () => false,
      lineWaiting: () => false,
      // Each line typed into the Assistant is taken (#650: its wake is received, and its watch ends, once it reads it).
      promptsTaken: (p: string, id: string) => (p.toLowerCase() === home.toLowerCase() && id === 'assistant' ? { runId: 'a1', count: st.typed.length } : null),
      sendPrompt: async (_p: string, _id: string, text: string, guard?: () => void) => {
        guard?.()
        st.typed.push(text)
        st.status = 'working'
        st.told.push(await follow(home, 'assistant', text))
      },
      watchChanged: () => undefined
    })
    return st
  }
  const agent = (id: string) => ({ kind: 'agent', name: `${id.toUpperCase()} (alpha)`, self: { project: 'alpha', agentId: id }, scope: 'alpha' }) as const
  const user = { kind: 'user' } as const
  const newCards = async (w: Parameters<typeof inWorkspace>[0], agentId: string, n: number) => {
    const out: number[] = []
    for (let i = 0; i < n; i++) out.push((await inWorkspace(w, () => tasks.createTask({ title: `Card ${i}`, project: 'alpha', agent: agentId, column: 'doing' }, user))).number)
    return out
  }
  const watchAll = async (w: Parameters<typeof inWorkspace>[0], home: string, st: { status: string }, events?: string[]) => {
    st.status = 'watching'
    return watches.registerLaneWatch(w, home, 'assistant', { ids: 'all', events: (events ?? [...LANE_DEFAULT_EVENTS]) as never })
  }
  /** The lane watch with cards beside the lanes (#726): `cards` left out keeps the last lane watch's. */
  const watchWith = async (w: Parameters<typeof inWorkspace>[0], home: string, st: { status: string }, cards?: number[]) => {
    st.status = 'watching'
    return watches.registerLaneWatch(w, home, 'assistant', { ids: 'all', events: [...LANE_DEFAULT_EVENTS] }, undefined, { ...(cards ? { cards } : {}), changes: [...LANE_CARD_CHANGES] })
  }
  /** An alpha agent's status as Combwork records it (#726: the session-status event). */
  const status = (alpha: string, st: { agents: Record<string, string> }, id: string, s: string, statusMessage?: string) => {
    st.agents[id] = s
    watches.noteAgentStatus({ projectPath: alpha, agentId: id, agentName: id.toUpperCase(), status: s, runId: id, ...(statusMessage ? { statusMessage } : {}) } as never)
  }
  const fail = async (w: Parameters<typeof inWorkspace>[0], n: number, reviewer: string) => {
    await inWorkspace(w, () => tasks.updateTask(n, { review: 'start' }, agent(reviewer)))
    await inWorkspace(w, () => tasks.updateTask(n, { review: 'failed' }, agent(reviewer), { comment: 'Round 1: FAILED' }))
  }

  it('follows every running lane in one watch: a failed review and a block wake it, plain moves stay quiet; a lane due to merge and its end are told', async () => {
    const { w, alpha, home } = await open()
    const st = fake(alpha, home)
    const [a, b] = await newCards(w, 'b1', 2)
    const [c] = await newCards(w, 'b2', 1)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a, b], by: 'B1 (alpha)', name: 'greetings' })
    await lanes.startLane(w, { project: 'alpha', builder: 'b2', reviewer: 'r2', cards: [c], by: 'B2 (alpha)' })
    const r = await watchAll(w, home, st)
    expect(r.watching.label).toBe('Waiting on all running lanes')
    expect(r.watching.lanes).toEqual(['all'])
    // A plain move into Review: nothing.
    await inWorkspace(w, () => tasks.updateTask(a, { column: 'review' }, agent('b1')))
    await watches.evaluateWatches(w)
    await watches.settled()
    expect(st.typed).toEqual([])
    // A failed review: told, with its lane and reviewer.
    await fail(w, a, 'r1')
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.told).toHaveLength(1), { timeout: HUNG_MS })
    expect(st.told[0]).toMatch(new RegExp(`^\\[CW\\] Lane B1 / R1 \\(greetings\\): #${a} failed review \\(R1 \\(alpha\\)\\)\\. Your lane watch has ended`))
    // Watched again: a block in the other lane.
    await watchAll(w, home, st)
    await inWorkspace(w, () => tasks.updateTask(c, { blocked: 'Which icon?' }, agent('b2')))
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.told).toHaveLength(2), { timeout: HUNG_MS })
    expect(st.told[1]).toMatch(new RegExp(`^\\[CW\\] Lane B2 / R2: #${c} is blocked: "Which icon\\?"`))
    // Both of B1's cards pass: its merge is due. Then Done: the lane ends.
    await watchAll(w, home, st)
    for (const n of [a, b]) await inWorkspace(w, () => tasks.updateTask(n, { column: 'passed' }, user))
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.told).toHaveLength(3), { timeout: HUNG_MS })
    expect(st.told[2]).toMatch(/^\[CW\] Lane B1 \/ R1 \(greetings\): all its cards passed: its merge is due\./)
    await watchAll(w, home, st)
    for (const n of [a, b]) await inWorkspace(w, () => tasks.updateTask(n, { column: 'done' }, user))
    // Combwork ends a lane whose cards are all Done as it follows the board (lanes.refresh).
    await lanes.refresh(w)
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.told).toHaveLength(4), { timeout: HUNG_MS })
    expect(st.told[3]).toMatch(/^\[CW\] Lane B1 \/ R1 \(greetings\): ended \(merged\)\./)
    await disposeWorkspaceService(w)
  })

  it("a lane hit names its card by key, with no workspace the context as the watch is looked at (HI-1777)", async () => {
    const { w, alpha, home } = await open()
    const st = fake(alpha, home)
    const { changeProjectKey } = await import('../src/main/projectKeys')
    await changeProjectKey(w, alpha, 'AL')
    const [a] = await newCards(w, 'b1', 1)
    const key = (await inWorkspace(w, () => tasks.getTask(a, w))).key
    expect(key).toMatch(/^AL-\d+$/)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a], by: 'B1 (alpha)' })
    await watchAll(w, home, st)
    await inWorkspace(w, () => tasks.updateTask(a, { blocked: 'Screenshots for your OK' }, agent('b1')))
    expect(contextWorkspace()).toBeUndefined()
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.told).toHaveLength(1), { timeout: HUNG_MS })
    expect(st.told[0]).toContain(`${key} is blocked: "Screenshots for your OK"`)
    expect(st.told[0]).not.toContain(`#${a}`)
    await disposeWorkspaceService(w)
  })

  it("HI-1991: a builder's question for the user (cw_ask_user) wakes a lane watch that dropped paused, naming the card and its first line; once only", async () => {
    const { w, alpha, home } = await open()
    const st = fake(alpha, home)
    const { workflowFor } = await import('../src/main/workflow/service')
    const [a] = await newCards(w, 'b1', 1)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a], by: 'B1 (alpha)' })
    // The Legible Assistant's filter: no paused, no waiting (B1 isn't at a prompt anyway).
    await watchAll(w, home, st, ['failed', 'blocked', 'merge-due', 'ended'])
    const wf = (await workflowFor(w, alpha))!
    await inWorkspace(w, () => wf.askTheUser(`#${a}`, 'agent:b1', { kind: 'decide', text: 'Keep the old setting name?\nIt is in three docs.' }))
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.told).toHaveLength(1), { timeout: HUNG_MS })
    expect(st.told[0]).toMatch(new RegExp(`^\\[CW\\] Lane B1 / R1: #${a} waits for the user \\(b1 asks\\): "Keep the old setting name\\?"\\. Your lane watch has ended: .*tell the user what an agent waits for`))
    expect((await lanes.listLanes(w, { project: 'alpha' }))[0]).toMatchObject({ state: 'paused', status: { reason: 'you', card: a } })
    // Watched again with the question still open: nothing new to tell.
    await watchAll(w, home, st, ['failed'])
    await inWorkspace(w, () => tasks.updateTask(a, { column: 'review' }, agent('b1')).catch(() => undefined))
    await watches.evaluateWatches(w)
    await watches.settled()
    expect(st.told).toHaveLength(1)
    await disposeWorkspaceService(w)
  })

  it("HI-1991 round 1 finding: a question asked while the cards' requests can't be read wakes the lane watch once they can, once", async () => {
    const { w, alpha, home } = await open()
    const st = fake(alpha, home)
    const { workflowFor } = await import('../src/main/workflow/service')
    const cardWork = await import('../src/main/workflow/cardWork')
    const [a] = await newCards(w, 'b1', 1)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a], by: 'B1 (alpha)' })
    await watchAll(w, home, st, ['failed'])
    const failing = vi.spyOn(cardWork, 'forYouOfCards').mockImplementation(() => {
      throw new Error('board busy')
    })
    try {
      // A quiet round with the requests unread saves its marks; the question comes while they still can't be read.
      await watches.evaluateWatches(w)
      const wf = (await workflowFor(w, alpha))!
      await inWorkspace(w, () => wf.askTheUser(`#${a}`, 'agent:b1', { kind: 'decide', text: 'Rename the event?' }))
      await watches.evaluateWatches(w)
      await watches.settled()
      expect(failing).toHaveBeenCalled()
      expect(st.told).toEqual([])
    } finally {
      failing.mockRestore()
    }
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.told).toHaveLength(1), { timeout: HUNG_MS })
    expect(st.told[0]).toContain(`#${a} waits for the user (b1 asks): "Rename the event?"`)
    await watchAll(w, home, st, ['failed'])
    await watches.evaluateWatches(w)
    await watches.settled()
    expect(st.told).toHaveLength(1)
    await disposeWorkspaceService(w)
  })

  // HI-1987: the Tools Assistant swapped its lane watch for an agent watch on LB2's build (on no card), and nothing told it
  // of LB1's lane meanwhile.
  it('HI-1987: a lane watch follows agents beside its lanes, each until a wake tells it; one not working is its state; replacing it with an agent watch names the lanes dropped', async () => {
    const { w, alpha, home } = await open()
    const st = fake(alpha, home)
    Object.assign(sessions, { agentNow: (p: string, id: string) => (p.toLowerCase() === alpha.toLowerCase() ? { status: st.agents[id] ?? 'working', runId: id, prompts: 1, pending: false, statusMessage: null, backgroundTasks: 0, reply: st.agents[id] === 'ready' ? `${id} done.` : null } : null) })
    const of = (id: string) => ({ projectPath: alpha, agentId: id, name: id.toUpperCase(), project: 'alpha' })
    const [a] = await newCards(w, 'b1', 1)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a], by: 'B1 (alpha)' })
    st.agents.b3 = 'ready'
    st.status = 'watching'
    const r = await watches.registerLaneWatch(w, home, 'assistant', { ids: 'all', events: [...LANE_DEFAULT_EVENTS] }, undefined, { agents: { agents: [of('b2'), of('b3')], ignoreBackground: false } })
    expect(r.watching.label).toBe('Waiting on all running lanes and B2')
    expect(r.agents).toEqual({ now: ['B2 (alpha)'], already: ['B3 (alpha) is idle: "b3 done."'] })
    // B2's turn ends: the lane watch wakes, with its own line; watched again, B2 (told) has left it.
    status(alpha, st, 'b2', 'working')
    status(alpha, st, 'b2', 'ready')
    await watches.evaluateAgentWatches(w)
    await vi.waitFor(() => expect(st.told).toHaveLength(1), { timeout: HUNG_MS })
    expect(st.told[0]).toBe('[CW] B2 (alpha) finished: "b2 done.". Your lane watch has ended: read the cards named (cw_read_task), act on them, then watch the lanes again (cw_wait_for_tasks with lanes; your agents stay unless you pass agents, less the agents told here).')
    await watches.settled()
    const again = await watchAll(w, home, st)
    expect(again.agents).toBeUndefined()
    expect(again.watching.label).toBe('Waiting on all running lanes')
    // Two followed, one told: the other stays with the next lane watch; agents: [] drops it.
    st.agents.b2 = 'working'
    st.agents.b3 = 'working'
    await watches.registerLaneWatch(w, home, 'assistant', { ids: 'all', events: [...LANE_DEFAULT_EVENTS] }, undefined, { agents: { agents: [of('b2'), of('b3')], ignoreBackground: false } })
    status(alpha, st, 'b3', 'working')
    status(alpha, st, 'b3', 'ready')
    await watches.evaluateAgentWatches(w)
    await vi.waitFor(() => expect(st.told).toHaveLength(2), { timeout: HUNG_MS })
    expect(st.told[1]).toMatch(/^\[CW\] B3 \(alpha\) finished/)
    await watches.settled()
    const kept = await watchAll(w, home, st)
    expect(kept.agents).toEqual({ now: ['B2 (alpha)'], kept: true })
    expect((await watches.registerLaneWatch(w, home, 'assistant', { ids: 'all', events: [...LANE_DEFAULT_EVENTS] }, undefined, { agents: { agents: [], ignoreBackground: false } })).agents).toBeUndefined()
    // A lane event and an agent together: one line.
    await watches.registerLaneWatch(w, home, 'assistant', { ids: 'all', events: [...LANE_DEFAULT_EVENTS] }, undefined, { agents: { agents: [of('b2')], ignoreBackground: false } })
    await inWorkspace(w, () => tasks.updateTask(a, { column: 'review' }, agent('b1')))
    await fail(w, a, 'r1')
    status(alpha, st, 'b2', 'working')
    status(alpha, st, 'b2', 'ready')
    st.status = 'working'
    await watches.evaluateWatches(w)
    await watches.evaluateAgentWatches(w)
    st.status = 'watching'
    await watches.tick()
    await vi.waitFor(() => expect(st.told).toHaveLength(3), { timeout: HUNG_MS })
    expect(st.told[2]).toMatch(new RegExp(`^\\[CW\\] Lane B1 / R1: #${a} failed review \\(R1 \\(alpha\\)\\) \\| B2 \\(alpha\\) finished: "b2 done\\."\\. Your lane watch has ended`))
    await watches.settled()
    // An agent watch after that lane wake, with the lane still running: the reply says the lane is no longer followed.
    st.agents.b2 = 'working'
    const swapped = await watches.registerAgentWatch(w, home, 'assistant', { agents: [of('b2')], ignoreBackground: false })
    expect(swapped.lanesLeft).toEqual(['B1'])
    // A lane watch replaced by another says nothing of the kind.
    expect('lanesLeft' in (await watchAll(w, home, st))).toBe(false)
    await disposeWorkspaceService(w)
  })

  // #922: HB3's push was refused, the Assistant asked the user to OK it in HB3's pane, the user did and HB3 cleared the
  // block, and the Assistant's lane watch heard of neither.
  it("#922: a pane reply to a lane's builder reaches the Assistant with its first line while its lane watch goes on; the block lifted wakes the lane watch; the lane's end names its merge commit", async () => {
    const { w, alpha, home } = await open()
    const st = fake(alpha, home)
    const [a] = await newCards(w, 'b1', 1)
    const lane = await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a], by: 'B1 (alpha)' })
    await inWorkspace(w, () => tasks.updateTask(a, { blocked: 'git push origin main was refused: OK it in my pane' }, agent('b1')))
    await watchAll(w, home, st)
    // The user's reply in B1's pane: told on its own, at once, with its first line; the lane watch carries on.
    watches.noteUserReply(alpha, 'b1', 'B1', 'OK, push it\nand then merge')
    await vi.waitFor(() => expect(st.told).toHaveLength(1), { timeout: HUNG_MS })
    expect(st.told[0]).toBe('[CW] User replied to B1 (alpha): "OK, push it".')
    expect(watches.watchFor(home, 'assistant')?.lanes).toEqual(['all'])
    // B1 clears the block: the lane watch wakes.
    st.status = 'watching'
    await inWorkspace(w, () => tasks.updateTask(a, { blocked: '' }, agent('b1')))
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.told).toHaveLength(2), { timeout: HUNG_MS })
    expect(st.told[1]).toMatch(new RegExp(`^\\[CW\\] Lane B1 / R1: #${a} is no longer blocked\\. Your lane watch has ended`))
    // The user ends it with its merge commit (its card merged by hand, with no facts): the end says it.
    await watchAll(w, home, st)
    await lanes.endLane(w, lane.lane.id, { mergeCommit: 'dd4ed990c0ffee1234567890abcdef1234567890' })
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.told).toHaveLength(3), { timeout: HUNG_MS })
    expect(st.told[2]).toMatch(/^\[CW\] Lane B1 \/ R1: ended: merged at dd4ed990c0ff\./)
    await disposeWorkspaceService(w)
  })

  // HI-1866: HB6 asked the Assistant in a comment to park a card and move HI-1759 to Done; its lane watch doesn't wake on
  // a comment, and the request sat unseen for an hour.
  it("HI-1866: an agent's request for the Assistant wakes its lane watch with the request whole and its watch goes on; a busy Assistant isn't typed into until it is free", async () => {
    const { askAssistant } = await import('../src/main/assistantAsk')
    const deliveries = await import('../src/main/deliveries')
    const { w, alpha, home } = await open()
    const st = fake(alpha, home)
    const [a, b] = await newCards(w, 'b1', 2)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a, b], by: 'B1 (alpha)' })
    await watchAll(w, home, st)
    // A comment alone, as on 27 Oct: the lane watch stays quiet.
    await inWorkspace(w, () => tasks.commentTask(a, 'For the Assistant: please park the follow-up.', agent('b1')))
    await watches.evaluateWatches(w)
    await watches.settled()
    expect(st.typed).toEqual([])
    // Asked with cw_ask_assistant: the Assistant is woken at once and reads the request whole, as B1's.
    const asked = `Please put #${b} On Hold and move #${a} to Done: the user chose option A on it.`
    const r = await inWorkspace(w, () => askAssistant(w, a, agent('b1'), asked))
    expect(r.id).toMatch(/^m\d+$/)
    await vi.waitFor(() => expect(st.told).toHaveLength(1), { timeout: HUNG_MS })
    expect(st.typed[0]).toMatch(/^\[CW\] New in your inbox: /)
    expect(st.told[0]).toContain(`B1 (alpha) asks you on #${a} (an agent's request, not the user's decision): <<<${asked}>>>`)
    expect(st.told[0]).toContain('cw_message_agent')
    expect((await deliveries.readInbox(home, 'assistant')).items).toEqual([])
    // Its lane watch carries on (a delivery to a watching agent never ends it).
    expect(watches.watchFor(home, 'assistant')?.lanes).toEqual(['all'])
    // Busy (working): nothing typed into it; given once it is free again.
    st.status = 'working'
    const second = await inWorkspace(w, () => askAssistant(w, a, agent('b1'), 'Also unblock it once parked.'))
    await deliveries.offerNow(home, 'assistant')
    expect(st.typed).toHaveLength(1)
    expect(deliveries.deliveryNow(home, second.id)?.state).toBe('queued')
    st.status = 'watching'
    await deliveries.offerNow(home, 'assistant')
    await vi.waitFor(() => expect(st.told).toHaveLength(2), { timeout: HUNG_MS })
    expect(st.told[1]).toContain('<<<Also unblock it once parked.>>>')
    await disposeWorkspaceService(w)
  })

  // 27 cards and three lanes: about 2 s alone, 5 s with four runs at once, and past the 20 s default with twelve suites
  // four at once beside a full e2e set (#570's proofs). Its bound for a hung run fits that work.
  const MANY_CARDS_HUNG_MS = 60_000
  it('"all" takes in a lane started later and cards added to a lane, with no card limit; events narrow what counts', async () => {
    const { w, alpha, home } = await open()
    const st = fake(alpha, home)
    const many = await newCards(w, 'b1', 25)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: many, by: 'B1 (alpha)' })
    await watchAll(w, home, st)
    // A lane started after the watch: followed from when it is first seen.
    const [x] = await newCards(w, 'b3', 1)
    await lanes.startLane(w, { project: 'alpha', builder: 'b3', reviewer: 'r1', cards: [x], by: 'B3 (alpha)' })
    await watches.evaluateWatches(w)
    await watches.settled()
    expect(st.typed).toEqual([])
    await inWorkspace(w, () => tasks.updateTask(x, { column: 'review' }, agent('b3')))
    await fail(w, x, 'r1')
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.told).toHaveLength(1), { timeout: HUNG_MS })
    expect(st.told[0]).toContain(`#${x} failed review`)
    // A lane started after the watch with a card already blocked when first seen: told once.
    await watchAll(w, home, st)
    const [y] = await newCards(w, 'b2', 1)
    await inWorkspace(w, () => tasks.updateTask(y, { blocked: 'Asked before the lane was seen' }, agent('b2')))
    await lanes.startLane(w, { project: 'alpha', builder: 'b2', reviewer: 'r2', cards: [y], by: 'B2 (alpha)' })
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.told).toHaveLength(2), { timeout: HUNG_MS })
    expect(st.told[1]).toContain(`#${y} is blocked: "Asked before the lane was seen"`)
    st.typed.splice(1, 1)
    st.told.splice(1, 1)
    // The 25th card of a lane (more than a card watch's 20).
    await watchAll(w, home, st)
    const last = many[24]
    await inWorkspace(w, () => tasks.updateTask(last, { column: 'review' }, agent('b1')))
    await fail(w, last, 'r1')
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.told).toHaveLength(2), { timeout: HUNG_MS })
    expect(st.told[1]).toContain(`#${last} failed review`)
    // Only passes asked for: a failed review is quiet, a pass wakes it.
    await watchAll(w, home, st, ['passed'])
    await inWorkspace(w, () => tasks.updateTask(many[0], { column: 'review' }, agent('b1')))
    await fail(w, many[0], 'r1')
    await watches.evaluateWatches(w)
    await watches.settled()
    expect(st.typed).toHaveLength(2)
    await inWorkspace(w, () => tasks.updateTask(many[1], { column: 'review' }, agent('b1')))
    await inWorkspace(w, () => tasks.updateTask(many[1], { review: 'start' }, agent('r1')))
    await inWorkspace(w, () => tasks.updateTask(many[1], { review: 'passed', column: 'passed' }, agent('r1'), { comment: 'Round 1: PASSED' }))
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.told).toHaveLength(3), { timeout: HUNG_MS })
    expect(st.told[2]).toContain(`#${many[1]} passed review`)
    await disposeWorkspaceService(w)
  }, MANY_CARDS_HUNG_MS)

  // #1107: a busy board's archived cards are most of it (945 of 1058, 13 MB): a lane watch reads its lanes' cards by
  // number, and the live cards only for an agent waiting for the user, never the archived ones beside them.
  it("reads only its lanes' cards (one archived mid-lane still found) and live cards for a wait, never the archived cards beside them (#1107)", async () => {
    const { w, alpha, home } = await open()
    const st = fake(alpha, home)
    const [a, b] = await newCards(w, 'b1', 2)
    const [doing] = await newCards(w, 'b2', 1)
    const marker = 'ARCHIVED-NOT-IN-A-LANE-1107'
    const old = (await inWorkspace(w, () => tasks.createTask({ title: 'Old', project: 'alpha', description: marker }, user))).number
    await inWorkspace(w, () => tasks.archiveTask(old, true))
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a, b], by: 'B1 (alpha)', name: 'reads' })
    await watchAll(w, home, st)
    const parse = vi.spyOn(JSON, 'parse')
    const parsedOld = (): boolean => parse.mock.calls.some(([text]) => typeof text === 'string' && text.includes(marker))
    try {
      // A lane card archived mid-lane: still the lane's, so a failed review of the other is told with the lane.
      await inWorkspace(w, () => tasks.archiveTask(b, true))
      await inWorkspace(w, () => tasks.updateTask(a, { column: 'review' }, agent('b1')))
      await fail(w, a, 'r1')
      await watches.evaluateWatches(w)
      await vi.waitFor(() => expect(st.told).toHaveLength(1), { timeout: HUNG_MS })
      expect(st.told[0]).toMatch(new RegExp(`^\\[CW\\] Lane B1 / R1 \\(reads\\): #${a} failed review`))
      // An agent waiting for the user: its card found among the live cards.
      await watchAll(w, home, st)
      status(alpha, st, 'b2', 'waiting', 'Claude needs your permission to use Bash')
      await watches.evaluateWatches(w)
      await vi.waitFor(() => expect(st.told).toHaveLength(2), { timeout: HUNG_MS })
      expect(st.told[1]).toContain(`B2 (alpha) is waiting for the user on #${doing}`)
      expect(parsedOld()).toBe(false)
    } finally {
      parse.mockRestore()
    }
    await disposeWorkspaceService(w)
  })

  it('seven lanes, 28 cards, in one watch: each lane followed, one wake for the lane that changed (#531 card)', async () => {
    const { w, alpha, home } = await open(7)
    const st = fake(alpha, home)
    const lanesCards: number[][] = []
    for (let i = 1; i <= 7; i++) {
      const cs = await newCards(w, `b${i}`, 4)
      lanesCards.push(cs)
      await lanes.startLane(w, { project: 'alpha', builder: `b${i}`, reviewer: 'r1', cards: cs, by: `B${i} (alpha)` })
    }
    await watchAll(w, home, st)
    const n = lanesCards[6][3]
    await inWorkspace(w, () => tasks.updateTask(n, { column: 'review' }, agent('b7')))
    await fail(w, n, 'r1')
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.told).toHaveLength(1), { timeout: HUNG_MS })
    expect(st.told[0]).toMatch(new RegExp(`^\\[CW\\] Lane B7 / R1: #${n} failed review \\(R1 \\(alpha\\)\\)\\. Your lane watch has ended`))
    await disposeWorkspaceService(w)
  })

  it('a card added to a followed lane is followed from an empty start: a block it came with is told (round 1 finding)', async () => {
    // A list changed (or a lane ended) at once, as with workflow rules off: with them on, a change waits for the card boundary (#1270, tests/laneOwnership.test.ts).
    await rulesOff()
    const { w, alpha, home } = await open()
    const st = fake(alpha, home)
    const [a] = await newCards(w, 'b1', 1)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a], by: 'B1 (alpha)' })
    await watchAll(w, home, st)
    const [b] = await newCards(w, 'b1', 1)
    await inWorkspace(w, () => tasks.updateTask(b, { blocked: 'Blocked before it joined the lane' }, agent('b1')))
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a, b], by: 'B1 (alpha)' })
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.told).toHaveLength(1), { timeout: HUNG_MS })
    expect(st.told[0]).toContain(`#${b} is blocked: "Blocked before it joined the lane"`)
    // Told once: the next watch starts from what that wake told.
    await watchAll(w, home, st)
    await watches.evaluateWatches(w)
    await watches.settled()
    expect(st.typed).toHaveLength(1)
    await disposeWorkspaceService(w)
  })

  for (const how of ['ended', 'abandoned'] as const) {
    it(`a lane that is ${how} between a wake and the watch after it: the watch after it is told (round 1 finding)`, async () => {
      const { w, alpha, home } = await open()
      const st = fake(alpha, home)
      const [a] = await newCards(w, 'b1', 1)
      const [c] = await newCards(w, 'b2', 1)
      await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a], by: 'B1 (alpha)' })
      const other = (await lanes.startLane(w, { project: 'alpha', builder: 'b2', reviewer: 'r2', cards: [c], by: 'B2 (alpha)' })).lane
      await watchAll(w, home, st)
      await inWorkspace(w, () => tasks.updateTask(a, { blocked: 'A question' }, agent('b1')))
      await watches.evaluateWatches(w)
      await vi.waitFor(() => expect(st.told).toHaveLength(1), { timeout: HUNG_MS })
      // While it handles that wake, the other lane ends (its card Done) or is abandoned.
      if (how === 'ended') {
        await inWorkspace(w, () => tasks.updateTask(c, { column: 'done' }, user))
        await lanes.refresh(w)
      } else await lanes.endLane(w, other.id, { abandoned: true })
      await watchAll(w, home, st)
      await vi.waitFor(() => expect(st.told).toHaveLength(2), { timeout: HUNG_MS })
      expect(st.told[1]).toMatch(new RegExp(`^\\[CW\\] Lane B2 / R2: ${how === 'ended' ? 'ended \\(merged\\)' : 'was abandoned'}\\.`))
      // Its end told, the lane leaves the watch: nothing more about it.
      await watchAll(w, home, st)
      await watches.evaluateWatches(w)
      await watches.settled()
      expect(st.typed).toHaveLength(2)
      expect(watches.watchFor(home, 'assistant')?.label).toBe('Waiting on all running lanes')
      await disposeWorkspaceService(w)
    })
  }

  describe('what is new between a wake and the watch after it (round 2 findings)', () => {
    /** B1's lane with one card, watched; its block wakes the Assistant. */
    const woken = async (events?: string[]) => {
      const { w, alpha, home } = await open()
      const st = fake(alpha, home)
      const [a] = await newCards(w, 'b1', 1)
      await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a], by: 'B1 (alpha)' })
      await watchAll(w, home, st, events)
      await inWorkspace(w, () => tasks.updateTask(a, { blocked: 'A question' }, agent('b1')))
      await watches.evaluateWatches(w)
      await vi.waitFor(() => expect(st.told).toHaveLength(1), { timeout: HUNG_MS })
      return { w, home, st, a }
    }

    for (const verdict of ['failed', 'passed'] as const) {
      it(`a card added to a lane and ${verdict} meanwhile is told by the next watch, once`, async () => {
        // A list changed (or a lane ended) at once, as with workflow rules off: with them on, a change waits for the card boundary (#1270, tests/laneOwnership.test.ts).
        await rulesOff()
        const { w, home, st, a } = await woken(['failed', 'passed', 'blocked'])
        const [b] = await newCards(w, 'b1', 1)
        await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a, b], by: 'B1 (alpha)' })
        await inWorkspace(w, () => tasks.updateTask(b, { column: 'review' }, agent('b1')))
        await inWorkspace(w, () => tasks.updateTask(b, { review: 'start' }, agent('r1')))
        await inWorkspace(w, () => tasks.updateTask(b, { review: verdict }, agent('r1'), { comment: `Round 1: ${verdict.toUpperCase()}` }))
        await watchAll(w, home, st, ['failed', 'passed', 'blocked'])
        await vi.waitFor(() => expect(st.told).toHaveLength(2), { timeout: HUNG_MS })
        expect(st.told[1]).toContain(`#${b} ${verdict} review (R1 (alpha))`)
        expect(st.told[1]).not.toContain(`#${a} is blocked`)
        await watchAll(w, home, st, ['failed', 'passed', 'blocked'])
        await watches.evaluateWatches(w)
        await watches.settled()
        expect(st.typed).toHaveLength(2)
        await disposeWorkspaceService(w)
      })
    }

    it('a lane started meanwhile with a blocked card is told by the next watch, once', async () => {
      const { w, home, st } = await woken()
      const [c] = await newCards(w, 'b2', 1)
      await inWorkspace(w, () => tasks.updateTask(c, { blocked: 'Asked as the lane started' }, agent('b2')))
      await lanes.startLane(w, { project: 'alpha', builder: 'b2', reviewer: 'r2', cards: [c], by: 'B2 (alpha)' })
      await watchAll(w, home, st)
      await vi.waitFor(() => expect(st.told).toHaveLength(2), { timeout: HUNG_MS })
      expect(st.told[1]).toMatch(new RegExp(`^\\[CW\\] Lane B2 / R2: #${c} is blocked: "Asked as the lane started"`))
      await watchAll(w, home, st)
      await watches.evaluateWatches(w)
      await watches.settled()
      expect(st.typed).toHaveLength(2)
      await disposeWorkspaceService(w)
    })

    for (const how of ['ended', 'abandoned'] as const) {
      it(`a lane started and ${how} meanwhile is told by the next watch, once`, async () => {
        const { w, home, st } = await woken()
        const [c] = await newCards(w, 'b2', 1)
        const l = (await lanes.startLane(w, { project: 'alpha', builder: 'b2', reviewer: 'r2', cards: [c], by: 'B2 (alpha)' })).lane
        if (how === 'ended') {
          await inWorkspace(w, () => tasks.updateTask(c, { column: 'done' }, user))
          await lanes.refresh(w)
        } else await lanes.endLane(w, l.id, { abandoned: true })
        await watchAll(w, home, st)
        await vi.waitFor(() => expect(st.told).toHaveLength(2), { timeout: HUNG_MS })
        expect(st.told[1]).toMatch(new RegExp(`^\\[CW\\] Lane B2 / R2: ${how === 'ended' ? 'ended \\(merged\\)' : 'was abandoned'}\\.`))
        await watchAll(w, home, st)
        await watches.evaluateWatches(w)
        await watches.settled()
        expect(st.typed).toHaveLength(2)
        await disposeWorkspaceService(w)
      })
    }
  })

  it('events landing while the line waits to be typed are told in the same line (round 1 finding)', async () => {
    const { w, alpha, home } = await open()
    const st = fake(alpha, home)
    const [a] = await newCards(w, 'b1', 1)
    const [c] = await newCards(w, 'b2', 1)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a], by: 'B1 (alpha)' })
    await lanes.startLane(w, { project: 'alpha', builder: 'b2', reviewer: 'r2', cards: [c], by: 'B2 (alpha)' })
    await watchAll(w, home, st)
    // The Assistant works (the user asked it something): the first event fires the watch but isn't typed yet.
    st.status = 'working'
    await inWorkspace(w, () => tasks.updateTask(a, { blocked: 'First question' }, agent('b1')))
    await watches.evaluateWatches(w)
    await inWorkspace(w, () => tasks.updateTask(c, { blocked: 'Second question' }, agent('b2')))
    await watches.evaluateWatches(w)
    await watches.settled()
    expect(st.typed).toEqual([])
    st.status = 'watching'
    await watches.tick()
    await vi.waitFor(() => expect(st.told).toHaveLength(1), { timeout: HUNG_MS })
    expect(st.told[0]).toContain(`#${a} is blocked: "First question"`)
    expect(st.told[0]).toContain(`#${c} is blocked: "Second question"`)
    // Both told: the next watch doesn't tell them again.
    await watchAll(w, home, st)
    await watches.evaluateWatches(w)
    await watches.settled()
    expect(st.typed).toHaveLength(1)
    await disposeWorkspaceService(w)
  })

  it("a card that stalls wakes it with the board's reason (its agent no longer running)", async () => {
    const { w, alpha, home } = await open()
    const st = fake(alpha, home)
    const [a] = await newCards(w, 'b1', 1)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a], by: 'B1 (alpha)' })
    await watchAll(w, home, st)
    await watches.evaluateWatches(w)
    await watches.settled()
    expect(st.typed).toEqual([])
    // B1 stops: its Doing card has nobody on it.
    const liveFor = sessions.liveFor.bind(sessions)
    Object.assign(sessions, { liveFor: (p: string, id: string) => (id === 'b1' ? null : liveFor(p, id)) })
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.told).toHaveLength(1), { timeout: HUNG_MS })
    expect(st.told[0]).toContain(`#${a} is stalled: "B1 isn't running."`)
    await disposeWorkspaceService(w)
  })

  // HI-1975's start: told "HB5 isn't running" 83 ms after Start, while its slot took 15 s to get ready.
  it("an agent whose start is under way (its slot being prepared) is starting, not stalled; a start that fails stalls it with why (HI-1976)", async () => {
    const { w, alpha, home } = await open()
    const st = fake(alpha, home)
    const [a] = await newCards(w, 'b1', 1)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a], by: 'B1 (alpha)' })
    await watchAll(w, home, st)
    await watches.evaluateWatches(w)
    await watches.settled()
    expect(st.typed).toEqual([])
    const liveFor = sessions.liveFor.bind(sessions)
    Object.assign(sessions, { liveFor: (p: string, id: string) => (id === 'b1' ? null : liveFor(p, id)) })
    try {
      // B1 not running yet, its Start's hold on: a slow start (its slot prepared for minutes) raises no stall.
      startBegun(alpha, 'b1', `#${a}`, { fresh: true })
      await watches.evaluateWatches(w)
      await watches.settled()
      expect(st.told).toEqual([])
      expect(st.typed).toEqual([])
      // Its start fails: stalled, with the failure rather than "isn't running".
      startEnded(alpha, 'b1', `#${a}`, { failed: "Combwork couldn't get slot-g ready: git worktree add failed" })
      await watches.evaluateWatches(w)
      await vi.waitFor(() => expect(st.told).toHaveLength(1), { timeout: HUNG_MS })
      expect(st.told[0]).toContain(`#${a} is stalled: "B1's start failed: Combwork couldn't get slot-g ready: git worktree add failed"`)
    } finally {
      Object.assign(sessions, { liveFor })
      resetAgentStartsForTests()
      await disposeWorkspaceService(w)
    }
  })

  it('a review started with no verdict, its reviewer only watching the card, wakes it once it has watched for the limit (#843)', async () => {
    const { w, alpha, home } = await open()
    const st = fake(alpha, home)
    const [a] = await newCards(w, 'b1', 1)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a], by: 'B1 (alpha)' })
    await inWorkspace(w, () => tasks.updateTask(a, { column: 'review' }, agent('b1')))
    await inWorkspace(w, () => tasks.updateTask(a, { review: 'start' }, agent('r1')))
    // R1 asks the user in a comment, not blocking the card, and goes back to watching it (#805's reviewer, 14 Oct).
    const since = new Date().toISOString()
    Object.assign(sessions, { liveStates: () => [{ projectPath: alpha, agentId: 'r1', agentName: 'R1', status: 'watching', watch: { cards: [a], changes: ['verdict', 'column'], column: 'review', label: '', since, limitAt: '' } }] })
    await watchAll(w, home, st)
    await watches.evaluateWatches(w)
    await watches.settled()
    expect(st.typed).toEqual([])
    // Its only-watching passes the limit: Combwork's clock moves on (the lane tick looks again now and then).
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.parse(since) + REVIEW_WAIT_STALL_MS + 60_000)
      await watches.evaluateWatches(w)
      await vi.waitFor(() => expect(st.told).toHaveLength(1), { timeout: HUNG_MS })
    } finally {
      vi.useRealTimers()
    }
    expect(st.told[0]).toContain(`#${a} is stalled: "R1 started reviewing #${a} but has given no verdict, and has only been watching it for 16 min."`)
    await disposeWorkspaceService(w)
  })

  it("a started review held for its builder's background job on the card: no stall while it runs, one once it has ended for the limit (HI-1993)", async () => {
    const { w, alpha, home } = await open()
    const st = fake(alpha, home)
    const [a] = await newCards(w, 'b1', 1)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a], by: 'B1 (alpha)' })
    await inWorkspace(w, () => tasks.updateTask(a, { column: 'review' }, agent('b1')))
    await inWorkspace(w, () => tasks.updateTask(a, { review: 'start' }, agent('r1')))
    // R1 asked for a stress proof; B1 runs it through cw-progress for the card, then in a background shell.
    const since = new Date().toISOString()
    const t0 = Date.parse(since)
    const run = { agentId: 'b1', projectPath: alpha, card: a, state: 'running', staleReason: null, startedAt: t0, finishedAt: null as number | null } as unknown as ProgressRun
    const runs: ProgressRun[] = [run]
    setStallRuns(() => runs)
    let b1 = { projectPath: alpha, agentId: 'b1', agentName: 'B1', status: 'background', backgroundTasks: 0 as number | undefined, backgroundEndedAt: undefined as string | undefined }
    const r1 = { projectPath: alpha, agentId: 'r1', agentName: 'R1', status: 'watching', watch: { cards: [a], changes: ['verdict', 'column'], column: 'review', label: '', since, limitAt: '' } }
    Object.assign(sessions, { liveStates: () => [r1, b1] })
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      await watchAll(w, home, st)
      // Past the limit, its run still going: no stall.
      vi.setSystemTime(t0 + REVIEW_WAIT_STALL_MS + 60_000)
      await watches.evaluateWatches(w)
      await watches.settled()
      // Its run ends; its background tasks go on: still none.
      Object.assign(run, { state: 'passed', finishedAt: Date.now() })
      b1 = { ...b1, backgroundTasks: 1 }
      vi.setSystemTime(t0 + 2 * REVIEW_WAIT_STALL_MS + 60_000)
      await watches.evaluateWatches(w)
      await watches.settled()
      expect(st.told).toEqual([])
      // They end too, and R1 gives no verdict: stalled once it has waited the limit from their end.
      b1 = { ...b1, status: 'watching', backgroundTasks: undefined, backgroundEndedAt: new Date().toISOString() }
      vi.setSystemTime(Date.now() + REVIEW_WAIT_STALL_MS - 60_000)
      await watches.evaluateWatches(w)
      await watches.settled()
      expect(st.told).toEqual([])
      vi.setSystemTime(Date.now() + 2 * 60_000)
      await watches.evaluateWatches(w)
      await vi.waitFor(() => expect(st.told).toHaveLength(1), { timeout: HUNG_MS })
    } finally {
      vi.useRealTimers()
      setStallRuns(null)
    }
    expect(st.told[0]).toContain(`#${a} is stalled: "R1 started reviewing #${a} but has given no verdict, and has only been watching it for 16 min."`)
    await disposeWorkspaceService(w)
  })

  it("an approved card whose pass went stale, its builder working with a watch kept, then only watching: stalled only then, 10 min after it went stale (HI-1763)", async () => {
    const { w, alpha, home } = await open()
    const st = fake(alpha, home)
    const [a] = await newCards(w, 'b1', 1)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a], by: 'B1 (alpha)' })
    await rulesOff()
    await inWorkspace(w, () => tasks.updateTask(a, { column: 'passed' }, user))
    const since = new Date().toISOString()
    stales.set(a, { since, approved: 'e89aa2fc1234', current: 'bd6ff9da5678' })
    try {
      let b1Status = 'working'
      Object.assign(sessions, { liveStates: () => [{ projectPath: alpha, agentId: 'b1', agentName: 'B1', status: b1Status, watch: { cards: [a], changes: ['column'], column: 'done', label: '', since, limitAt: '' } }] })
      await watchAll(w, home, st)
      await watches.evaluateWatches(w)
      await watches.settled()
      expect(st.typed).toEqual([])
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(Date.parse(since) + STALE_STALL_MS + 60_000)
        await watches.evaluateWatches(w)
        await watches.settled()
        expect(st.typed).toEqual([])
        b1Status = 'watching'
        await watches.evaluateWatches(w)
        await vi.waitFor(() => expect(st.told).toHaveLength(1), { timeout: HUNG_MS })
      } finally {
        vi.useRealTimers()
      }
      expect(st.told[0]).toMatch(new RegExp(`#${a} is stalled: ".*'s pass is for e89aa2f but its line is at bd6ff9d; B1 is only watching it, not submitting it\\."`))
    } finally {
      stales.delete(a)
    }
    await disposeWorkspaceService(w)
  })

  it("a lane's builder only watching its own card in Doing, nothing waiting on it, is stalled 5 min after its watch began; not while it works (HI-2285)", async () => {
    const { w, alpha, home } = await open()
    const st = fake(alpha, home)
    const [a] = await newCards(w, 'b1', 1)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a], by: 'B1 (alpha)' })
    const since = new Date().toISOString()
    // CB1's case (CL-5, 1 Nov): it committed its plan, watched its card for a comment and ended its turn. First it works
    // with that watch kept: no stall however long.
    let b1Status = 'working'
    let usage: true | undefined
    Object.assign(sessions, { liveStates: () => [{ projectPath: alpha, agentId: 'b1', agentName: 'B1', status: b1Status, watch: { cards: [a], changes: ['comment'], label: '', since, limitAt: '', ...(usage ? { usage } : {}) } }] })
    await watchAll(w, home, st)
    await watches.evaluateWatches(w)
    await watches.settled()
    expect(st.typed).toEqual([])
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.parse(since) + IDLE_WATCH_STALL_MS + 60_000)
      await watches.evaluateWatches(w)
      await watches.settled()
      expect(st.typed).toEqual([])
      // Its turn over, watching usage beside the card (HR2's round 1: a wait on more than the card): no stall.
      b1Status = 'watching'
      usage = true
      await watches.evaluateWatches(w)
      await watches.settled()
      expect(st.typed).toEqual([])
      // It only watches the card: stalled.
      usage = undefined
      await watches.evaluateWatches(w)
      await vi.waitFor(() => expect(st.told).toHaveLength(1), { timeout: HUNG_MS })
    } finally {
      vi.useRealTimers()
    }
    expect(st.told[0]).toContain(`#${a} is stalled: "B1 only watches #${a} (6 min), and nothing waits on it: no question for the user, no design step, not submitted."`)
    await disposeWorkspaceService(w)
  })

  it("a card the merge queue returned, its builder only watching it for Done, is stalled once it has waited 15 min (HI-1721)", async () => {
    const { w, alpha, home } = await open()
    const st = fake(alpha, home)
    const [a] = await newCards(w, 'b1', 1)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a], by: 'B1 (alpha)' })
    const since = new Date().toISOString()
    returns.set(a, { at: since, text: `#${a} came back from the merge queue: a conflict.`, builder: 'b1' })
    try {
      // B1 watches its card for Done, as HB2 did HI-1694: the card waits for B1 in Doing. First B1 is at work with
      // that watch still kept (it read the return and is fixing the conflict): no stall however long it takes.
      let b1Status = 'working'
      Object.assign(sessions, { liveStates: () => [{ projectPath: alpha, agentId: 'b1', agentName: 'B1', status: b1Status, watch: { cards: [a], changes: ['column'], column: 'done', label: '', since, limitAt: '' } }] })
      await watchAll(w, home, st)
      await watches.evaluateWatches(w)
      await watches.settled()
      expect(st.typed).toEqual([])
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(Date.parse(since) + RETURN_STALL_MS + 60_000)
        await watches.evaluateWatches(w)
        await watches.settled()
        expect(st.typed).toEqual([])
        // Its turn over, it only watches: stalled.
        b1Status = 'watching'
        await watches.evaluateWatches(w)
        await vi.waitFor(() => expect(st.told).toHaveLength(1), { timeout: HUNG_MS })
      } finally {
        vi.useRealTimers()
      }
      expect(st.told[0]).toMatch(new RegExp(`#${a} is stalled: ".* came back from the merge queue 16 min ago; B1 is only watching it, not fixing it\\."`))
    } finally {
      returns.delete(a)
    }
    await disposeWorkspaceService(w)
  })

  it("a lane's next card its builder, idle, hasn't started is stalled once the card before it has been Done 15 min, told once by key; not while the lane is paused or its builder works or is about to resume; started, it isn't (HI-1741)", async () => {
    const { w, alpha, home } = await open()
    const st = fake(alpha, home)
    await rulesOff()
    const { changeProjectKey } = await import('../src/main/projectKeys')
    await changeProjectKey(w, alpha, 'AL')
    const { noteHooksMissing } = await import('../src/main/hooksHealth')
    const [a] = await newCards(w, 'b1', 1)
    const b = (await inWorkspace(w, () => tasks.createTask({ title: 'Next', project: 'alpha', agent: 'b1' }, user))).number
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a, b], by: 'B1 (alpha)' })
    await inWorkspace(w, () => tasks.updateTask(a, { column: 'done' }, user))
    const done = Date.now()
    // B1 read its card's Done and ended its turn (HB3, 26 Oct): idle, the lane's next card in Todo.
    let b1Status = 'finished'
    Object.assign(sessions, { liveStates: () => [{ projectPath: alpha, agentId: 'b1', agentName: 'B1', status: b1Status }] })
    await watchAll(w, home, st)
    await watches.evaluateWatches(w)
    await watches.settled()
    expect(st.typed).toEqual([])
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(done + LANE_NEXT_STALL_MS + 60_000)
      const quiet = async (): Promise<void> => {
        await watches.evaluateWatches(w)
        await watches.settled()
        expect(st.typed).toEqual([])
      }
      // At work then (its turn not over): no stall.
      b1Status = 'working'
      await quiet()
      // Idle, but its lane paused (its hooks aren't arriving: nothing is typed into it): no stall.
      b1Status = 'finished'
      noteHooksMissing(alpha, 'b1', true)
      try {
        await quiet()
      } finally {
        noteHooksMissing(alpha, 'b1', false)
      }
      // Not running, but queued to resume after a restart: no stall.
      const liveFor = sessions.liveFor.bind(sessions)
      const liveStates = sessions.liveStates.bind(sessions)
      Object.assign(sessions, { liveFor: (p: string, id: string) => (id === 'b1' ? null : liveFor(p, id)), liveStates: () => [] })
      resuming.add('b1')
      try {
        await quiet()
      } finally {
        resuming.delete('b1')
        Object.assign(sessions, { liveFor, liveStates })
      }
      // Idle, the lane running: stalled, by the cards' keys.
      await watches.evaluateWatches(w)
      await vi.waitFor(() => expect(st.told).toHaveLength(1), { timeout: HUNG_MS })
      expect(st.told[0]).toContain(`is stalled: "AL-2 is the lane's next card: AL-1 went Done 16 min ago, and B1 is idle without starting it."`)
      // Told once: looked at again, nothing new.
      await watchAll(w, home, st)
      await watches.evaluateWatches(w)
      await watches.settled()
      expect(st.told).toHaveLength(1)
      // B1 starts it: no longer stalled, as the lane's view shows it.
      await inWorkspace(w, () => tasks.updateTask(b, { column: 'doing' }, agent('b1')))
      b1Status = 'working'
      const now = await watches.lanesNowIn(w, {}, new Date(0).toISOString())
      expect(now.flatMap((l) => l.cards).find((x) => x.number === b)?.stalled).toBeNull()
    } finally {
      vi.useRealTimers()
    }
    await disposeWorkspaceService(w)
  })

  it("a lane deadlocked, its reviewer waiting for one card while its builder waits on another's review, wakes it once the limit has passed (#1410)", async () => {
    const { w, alpha, home } = await open()
    const st = fake(alpha, home)
    const [a, b] = await newCards(w, 'b1', 2)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a, b], by: 'B1 (alpha)' })
    // B1 sends the second card to Review and watches it; R1 keeps the lane's order and watches the first (22 Oct).
    await inWorkspace(w, () => tasks.updateTask(b, { column: 'review' }, agent('b1')))
    const since = new Date().toISOString()
    const watching = (id: string, name: string, cards: number[]) => ({ projectPath: alpha, agentId: id, agentName: name, status: 'watching', watch: { cards, changes: ['verdict', 'column'], column: 'review', label: '', since, limitAt: '' } })
    Object.assign(sessions, { liveStates: () => [watching('r1', 'R1', [a]), watching('b1', 'B1', [b])] })
    await watchAll(w, home, st)
    await watches.evaluateWatches(w)
    await watches.settled()
    expect(st.typed).toEqual([])
    // Neither moves for the limit: Combwork's clock moves on (the lane tick looks again now and then).
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.parse(since) + REVIEW_WAIT_STALL_MS + 60_000)
      await watches.evaluateWatches(w)
      await vi.waitFor(() => expect(st.told).toHaveLength(1), { timeout: HUNG_MS })
    } finally {
      vi.useRealTimers()
    }
    expect(st.told[0]).toMatch(new RegExp(`#${b} is stalled: "R1 is waiting for #${a}, before #${b} in the lane, while B1 waits on the review of #${b}: each has waited on the other for 1[67] mi`))
    await disposeWorkspaceService(w)
  })

  it("a lane's merge due with its builder idle and no merge slot wakes it once the limit has passed (#869, lane G)", async () => {
    const { w, alpha, home } = await open()
    const st = fake(alpha, home)
    const [a, b] = await newCards(w, 'b1', 2)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a, b], by: 'B1 (alpha)', name: 'lane G' })
    await watchAll(w, home, st)
    for (const n of [a, b]) await inWorkspace(w, () => tasks.updateTask(n, { column: 'passed' }, user))
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.told).toHaveLength(1), { timeout: HUNG_MS })
    expect(st.told[0]).toMatch(/all its cards passed: its merge is due\./)
    await watchAll(w, home, st)
    // B1's commit is refused: it tells the user and its turn ends, with no merge slot and nothing blocked.
    const idleSince = new Date().toISOString()
    const liveFor = sessions.liveFor.bind(sessions)
    Object.assign(sessions, { liveFor: (p: string, id: string) => (id === 'b1' ? ({ projectPath: alpha, agentId: 'b1', status: 'finished', statusSince: idleSince, runId: 'b1' } as never) : liveFor(p, id)) })
    await watches.evaluateWatches(w)
    await watches.settled()
    expect(st.told).toHaveLength(1)
    // The limit passes: Combwork's clock moves on (the lane tick looks again now and then).
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.parse(idleSince) + MERGE_STALL_MS + 60_000)
      await watches.evaluateWatches(w)
      await vi.waitFor(() => expect(st.told).toHaveLength(2), { timeout: HUNG_MS })
    } finally {
      vi.useRealTimers()
    }
    expect(st.told[1]).toMatch(/^\[CW\] Lane B1 \/ R1 \(lane G\): its merge is stalled: "Every card passed, but B1 has been idle for 11 min with no merge slot claimed\."/)
    await disposeWorkspaceService(w)
  })

  it('a lane watch started after a wake counts what happened in between; unknown lanes are refused; kept on disk and read back', async () => {
    const { w, alpha, home } = await open()
    const st = fake(alpha, home)
    const [a, b] = await newCards(w, 'b1', 2)
    const l = (await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a, b], by: 'B1 (alpha)' })).lane
    st.status = 'watching'
    await watches.registerLaneWatch(w, home, 'assistant', { ids: [l.id], events: ['failed', 'blocked'] })
    await inWorkspace(w, () => tasks.updateTask(a, { blocked: 'A question' }, agent('b1')))
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.told).toHaveLength(1), { timeout: HUNG_MS })
    // Between the wake and the next watch, #b is blocked too: the next watch is woken at once.
    await inWorkspace(w, () => tasks.updateTask(b, { blocked: 'Another question' }, agent('b1')))
    st.status = 'watching'
    await watches.registerLaneWatch(w, home, 'assistant', { ids: [l.id], events: ['failed', 'blocked'] })
    await vi.waitFor(() => expect(st.told).toHaveLength(2), { timeout: HUNG_MS })
    expect(st.told[1]).toContain(`#${b} is blocked: "Another question"`)
    expect(st.told[1]).not.toContain(`#${a} is blocked`)
    await expect(watches.registerLaneWatch(w, home, 'assistant', { ids: ['lane-nosuch'], events: ['failed'] })).rejects.toThrow(/No such lane: lane-nosuch/)
    // Kept: read back after the workspace is forgotten in memory, still a lane watch.
    st.status = 'watching'
    await watches.registerLaneWatch(w, home, 'assistant', { ids: 'all', events: ['failed'] })
    watches.forgetWatches(w)
    expect(watches.watchFor(home, 'assistant')).toBeNull()
    await watches.evaluateWatches(w)
    await watches.settled()
    expect(watches.watchFor(home, 'assistant')?.label).toBe('Waiting on all running lanes')
    await disposeWorkspaceService(w)
  })

  // HI-2521: WR1 watched its lane 2 s after it ended (merged), and sat watching it for its 6 h limit.
  it('HI-2521: a watch naming a lane that has ended or been abandoned replies at once and starts none, ending the one before; one naming lanes counts their end whatever its events', async () => {
    const { w, alpha, home } = await open()
    const st = fake(alpha, home)
    const [a, b, c] = await newCards(w, 'b1', 3)
    const ended = (await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a], by: 'B1 (alpha)', name: 'screenshots' })).lane
    await lanes.endLane(w, ended.id, { mergeCommit: '47a3d54c0ffee1234567890abcdef1234567890a' })
    const abandoned = (await lanes.startLane(w, { project: 'alpha', builder: 'b2', reviewer: 'r2', cards: [b], by: 'B2 (alpha)' })).lane
    await lanes.endLane(w, abandoned.id, { abandoned: true })
    // A watch it had before: ended by the answer, and said.
    await watches.registerWatch(w, home, 'assistant', { cards: [c], changes: ['comment'] })
    const r = await watches.registerLaneWatch(w, home, 'assistant', { ids: [ended.id, abandoned.id], events: ['failed'] })
    expect(r).toEqual({ already: ['Lane B1 / R1 (screenshots): ended: merged at 47a3d54c0ffe', 'Lane B2 / R2: was abandoned'], replaced: `Waiting for #${c}` })
    expect(watches.watchFor(home, 'assistant')).toBeNull()
    // Through the Agent API's reply: "Already: …".
    expect(taskWaitText({ lanesAlready: (r as { already: string[] }).already, replaced: (r as { replaced: string }).replaced })).toBe(`Already: Lane B1 / R1 (screenshots): ended: merged at 47a3d54c0ffe; Lane B2 / R2: was abandoned. Your watch (waiting for #${c}) has ended.`)
    // A running lane watched for failures only: its end still wakes the watch, which has nothing left to watch.
    const running = (await lanes.startLane(w, { project: 'alpha', builder: 'b3', reviewer: 'r1', cards: [c], by: 'B3 (alpha)' })).lane
    st.status = 'watching'
    const on = await watches.registerLaneWatch(w, home, 'assistant', { ids: [running.id], events: ['failed'] })
    expect('watching' in on).toBe(true)
    await lanes.endLane(w, running.id, { abandoned: true })
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.told).toHaveLength(1), { timeout: HUNG_MS })
    expect(st.told[0]).toMatch(/^\[CW\] Lane B3 \/ R1: was abandoned\./)
    await disposeWorkspaceService(w)
  })

  it('HI-2521 round 1 finding: a named-lane watch read back from before, saved counting only failed, is still woken by its lane ending; an "all" watch keeps its events', async () => {
    expect(readLaneCondition({ lanes: ['lane-a'], events: ['failed'] })).toEqual({ ids: ['lane-a'], events: ['failed', 'paused-user', 'ended', 'abandoned'] })
    expect(readLaneCondition({ lanes: ['all'], events: ['failed'] })).toEqual({ ids: 'all', events: ['failed', 'paused-user'] })
    const { w, alpha, home } = await open()
    const st = fake(alpha, home)
    const [a] = await newCards(w, 'b1', 1)
    const l = (await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a], by: 'B1 (alpha)' })).lane
    st.status = 'watching'
    await watches.registerLaneWatch(w, home, 'assistant', { ids: [l.id], events: ['failed'] })
    // Saved as a build from before HI-2521 saved it: failed (and the question for the user) only.
    const saved = storeDocs(w.path!, 'watches')
    expect(saved).toHaveLength(1)
    await putStoreDocs(w.path!, 'watches', [{ ...saved[0], lanes: { ids: [l.id], events: ['failed', 'paused-user'] } }])
    watches.forgetWatches(w)
    await vi.waitFor(() => expect(watches.watchFor(home, 'assistant')).not.toBeNull(), { timeout: HUNG_MS })
    await lanes.endLane(w, l.id, { mergeCommit: '47a3d54c0ffee1234567890abcdef1234567890a' })
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.told).toHaveLength(1), { timeout: HUNG_MS })
    expect(st.told[0]).toMatch(/^\[CW\] Lane B1 \/ R1: ended: merged at 47a3d54c0ffe\./)
    await disposeWorkspaceService(w)
  })

  // HI-2522: Darren read WR1's "Waiting on lane lane-1d1c05" as a commit id; the lane is "combwork screenshots".
  it("HI-2522: a watch on one lane is labelled by the lane's name (its builder's too when another lane has it, else its builder's lane), kept on disk; never its id", async () => {
    const { w, alpha, home } = await open()
    fake(alpha, home)
    const [a, b, c] = await newCards(w, 'b1', 3)
    const named = (await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a], by: 'B1 (alpha)', name: 'combwork screenshots' })).lane
    const label = async (id: string): Promise<string> => {
      const r = await watches.registerLaneWatch(w, home, 'assistant', { ids: [id], events: ['failed'] })
      return 'watching' in r ? r.watching.label : r.already.join('; ')
    }
    expect(await label(named.id)).toBe('Waiting on lane combwork screenshots')
    expect(watches.watchFor(home, 'assistant')).toMatchObject({ lanes: [named.id], laneTitles: { [named.id]: { name: 'combwork screenshots', builder: 'B1' } } })
    // Read back from disk: the same label.
    watches.forgetWatches(w)
    await vi.waitFor(() => expect(watches.watchFor(home, 'assistant')?.label).toBe('Waiting on lane combwork screenshots'), { timeout: HUNG_MS })
    // Another lane with the same name: its builder is named too.
    const twin = (await lanes.startLane(w, { project: 'alpha', builder: 'b2', reviewer: 'r2', cards: [b], by: 'B2 (alpha)', name: 'Combwork screenshots' })).lane
    expect(await label(named.id)).toBe("Waiting on B1's lane combwork screenshots")
    // A lane with no name: its builder's lane.
    const plain = (await lanes.startLane(w, { project: 'alpha', builder: 'b3', reviewer: 'r1', cards: [c], by: 'B3 (alpha)' })).lane
    expect(await label(plain.id)).toBe("Waiting on B3's lane")
    for (const l of [named, twin, plain]) expect(watches.watchFor(home, 'assistant')!.label).not.toContain(l.id)
    // A wake line too long to tell in full names each lane by its name, never by its id.
    const hit = { id: named.id, label: `B1 / R1 (combwork screenshots${' and more'.repeat(400)})`, short: 'combwork screenshots', parts: [{ n: a, event: 'blocked' as const, text: `#${a} is blocked` }] }
    const short = laneWakeLine([hit])
    expect(short).toMatch(/^\[CW\] Lane combwork screenshots: #\d+ is blocked\./)
    expect(short).not.toContain(named.id)
    await disposeWorkspaceService(w)
  })

  it('HI-2522 round 1 finding: a watch on named lanes saved before HI-2522 (no titles) is read back naming each lane, in its label, the window and its limit line; never an id', async () => {
    const { w, alpha, home } = await open()
    fake(alpha, home)
    const [a] = await newCards(w, 'b1', 1)
    const named = (await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a], by: 'B1 (alpha)', name: 'combwork screenshots' })).lane
    const readBack = async (id: string) => {
      await watches.registerLaneWatch(w, home, 'assistant', { ids: [id], events: ['failed'] })
      // Saved as a build from before HI-2522 saved it: no titles.
      const saved = storeDocs(w.path!, 'watches')
      const { laneTitles: _t, ...old } = saved[0] as Record<string, unknown>
      await putStoreDocs(w.path!, 'watches', [old])
      watches.forgetWatches(w)
      await vi.waitFor(() => expect(watches.watchFor(home, 'assistant')).not.toBeNull(), { timeout: HUNG_MS })
      return watches.watchFor(home, 'assistant')!
    }
    const was = await readBack(named.id)
    expect(was.label).toBe('Waiting on lane combwork screenshots')
    expect(watchText(was, tr, (l) => l.join(', '))).toBe('Waiting on lane combwork screenshots')
    expect(laneLimitLine({ ids: [named.id], events: [] }, 90, [], [], was.laneTitles)).toMatch(/^\[CW\] Nothing to tell on lane combwork screenshots in 1\.5 h/)
    // Kept: saved again with its titles at the next tick.
    await watches.tick()
    await vi.waitFor(() => expect((storeDocs(w.path!, 'watches')[0] as { laneTitles?: unknown }).laneTitles).toEqual({ [named.id]: { name: 'combwork screenshots', builder: 'B1' } }), { timeout: HUNG_MS })
    await disposeWorkspaceService(w)
  })

  it('HI-2521: a lane ending while its watch is being set up (after its lanes were read) still wakes the watcher', async () => {
    const { w, alpha, home } = await open()
    const st = fake(alpha, home)
    const [a] = await newCards(w, 'b1', 1)
    const l = (await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a], by: 'B1 (alpha)' })).lane
    watches.testHooks.afterLanesRead = async () => {
      watches.testHooks.afterLanesRead = undefined
      await lanes.endLane(w, l.id, { mergeCommit: '47a3d54c0ffee1234567890abcdef1234567890a' })
    }
    try {
      st.status = 'watching'
      const r = await watches.registerLaneWatch(w, home, 'assistant', { ids: [l.id], events: ['failed'] })
      // Read while it ran: a watch starts, and its own check after setup tells the end (nothing else looks).
      expect('watching' in r).toBe(true)
    } finally {
      watches.testHooks.afterLanesRead = undefined
    }
    await vi.waitFor(() => expect(st.told).toHaveLength(1), { timeout: HUNG_MS })
    expect(st.told[0]).toMatch(/^\[CW\] Lane B1 \/ R1: ended: merged at 47a3d54c0ffe\./)
    await disposeWorkspaceService(w)
  })

  it('one watch for the lanes and a card beside them: its comment wakes it, then a lane failure and its block together, in one line (#726)', async () => {
    const { w, alpha, home } = await open()
    const st = fake(alpha, home)
    const [a] = await newCards(w, 'b1', 1)
    // The release card: in no lane.
    const [rel] = await newCards(w, 'b2', 1)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a], by: 'B1 (alpha)' })
    const r = await watchWith(w, home, st, [rel])
    expect(r.watching.label).toBe(`Waiting on all running lanes and #${rel}`)
    expect(r.watching.cards).toEqual([rel])
    expect(r.cards).toEqual({ now: [rel] })
    // (a) A comment on the card outside the lanes.
    await inWorkspace(w, () => tasks.commentTask(rel, 'Draft release is up: push when ready', agent('b2')))
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.told).toHaveLength(1), { timeout: HUNG_MS })
    expect(st.told[0]).toMatch(new RegExp(`^\\[CW\\] #${rel} .*is in Doing \\(latest comment by B2 \\(alpha\\): "Draft release is up: push when ready"\\)\\. Your lane watch has ended: .*your cards stay unless you pass cards`))
    // Watched again without cards: the card is kept.
    const again = await watchWith(w, home, st)
    expect(again.cards).toEqual({ now: [rel], kept: true })
    expect(again.watching.label).toBe(`Waiting on all running lanes and #${rel}`)
    // (b) While the Assistant works, a lane card fails review and the release card is blocked: one line tells both.
    st.status = 'working'
    await inWorkspace(w, () => tasks.updateTask(a, { column: 'review' }, agent('b1')))
    await fail(w, a, 'r1')
    await inWorkspace(w, () => tasks.updateTask(rel, { blocked: 'Darren pushes the tag' }, agent('b2')))
    await watches.evaluateWatches(w)
    await watches.settled()
    expect(st.typed).toHaveLength(1)
    st.status = 'watching'
    await watches.tick()
    await vi.waitFor(() => expect(st.told).toHaveLength(2), { timeout: HUNG_MS })
    expect(st.told[1]).toContain(`Lane B1 / R1: #${a} failed review (R1 (alpha))`)
    expect(st.told[1]).toContain(`#${rel} `)
    expect(st.told[1]).toContain('and blocked: "Darren pushes the tag"')
    // Told once: the next watch (cards kept) starts from what that line told.
    await watchWith(w, home, st)
    await watches.evaluateWatches(w)
    await watches.settled()
    expect(st.typed).toHaveLength(2)
    // cards: [] drops them: a comment on it is quiet now.
    const none = await watchWith(w, home, st, [])
    expect(none.cards).toEqual({ now: [], replaced: [rel] })
    expect(none.watching.label).toBe('Waiting on all running lanes')
    await inWorkspace(w, () => tasks.commentTask(rel, 'Pushed', agent('b2')))
    await watches.evaluateWatches(w)
    await watches.settled()
    expect(st.typed).toHaveLength(2)
    // A lane's own card listed beside it (#1531, #1346 item 3): the watch is kept as asked, and the reply warns.
    const dup = await watchWith(w, home, st, [a, rel])
    expect(dup.cards).toEqual({ now: [a, rel], inLanes: [a] })
    expect(dup.watching.cards).toEqual([a, rel])
    expect(taskWaitText({ watching: dup.watching.label, limitAt: 'T', events: [...LANE_DEFAULT_EVENTS], cards: dup.cards })).toContain(`Warning: #${a} is a card of the lanes you watch: listed too, it wakes you on every move. For a lane, pass lanes only.`)
    await disposeWorkspaceService(w)
  })

  it('cards kept from the last lane watch leave it once done or gone; a card outside the caller’s view is refused; read back from disk (#726)', async () => {
    const { w, alpha, home } = await open()
    const st = fake(alpha, home)
    const [x, y] = await newCards(w, 'b2', 2)
    await watchWith(w, home, st, [x, y])
    await inWorkspace(w, () => tasks.updateTask(y, { column: 'done' }, user))
    // y's move to Done wakes it (column counts).
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.told).toHaveLength(1), { timeout: HUNG_MS })
    const kept = await watchWith(w, home, st)
    expect(kept.cards).toEqual({ now: [x], kept: true, dropped: [y] })
    // Replacing a live lane watch keeps its cards too.
    const live = await watchWith(w, home, st)
    expect(live.cards).toEqual({ now: [x], kept: true })
    await expect(watches.registerLaneWatch(w, home, 'assistant', { ids: 'all', events: [...LANE_DEFAULT_EVENTS] }, undefined, { cards: [99999], changes: [...LANE_CARD_CHANGES] })).rejects.toThrow(/99999/)
    // Kept on disk with its cards, and still woken by them once read back.
    watches.forgetWatches(w)
    await watches.evaluateWatches(w)
    await watches.settled()
    expect(watches.watchFor(home, 'assistant')?.cards).toEqual([x])
    await inWorkspace(w, () => tasks.commentTask(x, 'Still here', agent('b2')))
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.told).toHaveLength(2), { timeout: HUNG_MS })
    expect(st.told[1]).toContain('"Still here"')
    await disposeWorkspaceService(w)
  })

  it("HI-2153 (the Assistant's call): a card beside the lanes in Done or archived leaves the watch with no notice of its own, the lanes still watched; one named already Done or archived never joins", async () => {
    const { w, alpha, home } = await open()
    const st = fake(alpha, home)
    const [a] = await newCards(w, 'b1', 1)
    const [x, y, gone] = await newCards(w, 'b2', 3)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a], by: 'B1 (alpha)' })
    // Comments only, so no column change can stand in for the card leaving.
    const comments = (cards?: number[]) => {
      st.status = 'watching'
      return watches.registerLaneWatch(w, home, 'assistant', { ids: 'all', events: [...LANE_DEFAULT_EVENTS] }, undefined, { ...(cards ? { cards } : {}), changes: ['comment'] })
    }
    expect((await comments([x, y, gone])).cards).toEqual({ now: [x, y, gone] })
    // x merged, gone archived: both leave at once, nothing typed; the lanes are still watched.
    await inWorkspace(w, () => tasks.updateTask(x, { column: 'done' }, user))
    await inWorkspace(w, () => tasks.archiveTask(gone, true))
    await watches.evaluateWatches(w)
    await watches.settled()
    expect(st.typed).toHaveLength(0)
    expect(watches.watchFor(home, 'assistant')).toMatchObject({ cards: [y], label: `Waiting on all running lanes and #${y}` })
    await vi.waitFor(async () => expect((await inWorkspace(w, () => tasks.getTask(x, w))).history.map((h) => h.what)).toContainEqual(expect.stringMatching(/^Ended .*'s watch on it: the card is in Done$/)), { timeout: HUNG_MS })
    // The next lane event's line names neither.
    await inWorkspace(w, () => tasks.updateTask(a, { column: 'review' }, agent('b1')))
    await fail(w, a, 'r1')
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.told).toHaveLength(1), { timeout: HUNG_MS })
    expect(st.told[0]).toContain(`#${a} failed review`)
    expect(st.told[0]).not.toContain(`#${x}`)
    expect(st.told[0]).not.toContain(`#${gone}`)
    // Watched again, cards kept: y only.
    expect((await comments()).cards).toEqual({ now: [y], kept: true })
    // Named when already Done or archived: never joins the watch (the reply lists it as dropped).
    const late = await comments([x, gone])
    expect(late.cards).toMatchObject({ now: [], dropped: [x, gone] })
    expect(late.watching.label).toBe('Waiting on all running lanes')
    await disposeWorkspaceService(w)
  })

  it('HI-2153 round 2 finding: a card beside the lanes merged after the watch fired but before its line is typed leaves it then, and the line never names it', async () => {
    const { w, alpha, home } = await open()
    const st = fake(alpha, home)
    const [a] = await newCards(w, 'b1', 1)
    const [x, y] = await newCards(w, 'b2', 2)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a], by: 'B1 (alpha)' })
    await watches.registerLaneWatch(w, home, 'assistant', { ids: 'all', events: [...LANE_DEFAULT_EVENTS] }, undefined, { cards: [x, y], changes: ['comment'] })
    // The Assistant works: a lane failure fires the watch, but its line waits; x is merged meanwhile.
    st.status = 'working'
    await inWorkspace(w, () => tasks.updateTask(a, { column: 'review' }, agent('b1')))
    await fail(w, a, 'r1')
    await watches.evaluateWatches(w)
    await inWorkspace(w, () => tasks.updateTask(x, { column: 'done' }, user))
    await watches.evaluateWatches(w)
    await watches.settled()
    expect(st.typed).toEqual([])
    // While it waits, x has left (what its agent shows, and Archive All, see it gone).
    expect(watches.watchFor(home, 'assistant')).toMatchObject({ cards: [y], label: `Waiting on all running lanes and #${y}` })
    await vi.waitFor(async () => expect((await inWorkspace(w, () => tasks.getTask(x, w))).history.map((h) => h.what)).toContainEqual(expect.stringMatching(/^Ended .*'s watch on it: the card is in Done$/)), { timeout: HUNG_MS })
    st.status = 'watching'
    await watches.tick()
    await vi.waitFor(() => expect(st.told).toHaveLength(1), { timeout: HUNG_MS })
    expect(st.told[0]).toContain(`#${a} failed review`)
    expect(st.told[0]).not.toContain(`#${x}`)
    // Watched again, cards kept: y only, x not carried over.
    st.status = 'watching'
    expect((await watches.registerLaneWatch(w, home, 'assistant', { ids: 'all', events: [...LANE_DEFAULT_EVENTS] }, undefined, { changes: ['comment'] })).cards).toEqual({ now: [y], kept: true })
    await disposeWorkspaceService(w)
  })

  it('a lane watch replaced before its wake was given keeps its cards from where it was: the change is still told (#726)', async () => {
    const { w, alpha, home } = await open()
    const st = fake(alpha, home)
    const [rel] = await newCards(w, 'b2', 1)
    await watchWith(w, home, st, [rel])
    // The Assistant works (the user asked it something): the comment fires the watch, not given yet.
    st.status = 'working'
    await inWorkspace(w, () => tasks.commentTask(rel, 'Tagged: push when ready', agent('b2')))
    await watches.evaluateWatches(w)
    await watches.settled()
    expect(st.typed).toEqual([])
    // It watches again (cards kept) before that wake was given: the comment is still news.
    const again = await watchWith(w, home, st)
    expect(again.cards).toEqual({ now: [rel], kept: true })
    await vi.waitFor(() => expect(st.told).toHaveLength(1), { timeout: HUNG_MS })
    expect(st.told[0]).toContain('"Tagged: push when ready"')
    await disposeWorkspaceService(w)
  })

  it('an agent that starts waiting while the first lane watch is being set up is told (#726 round 1 finding)', async () => {
    const { w, alpha, home } = await open()
    const st = fake(alpha, home)
    const [a] = await newCards(w, 'b1', 1)
    const [rel] = await newCards(w, 'b2', 1)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a], by: 'B1 (alpha)' })
    // B2 shows a permission prompt while the watch reads its card beside the lanes.
    watches.testHooks.cardRead = (n) => {
      if (n !== rel || st.agents.b2 === 'waiting') return
      status(alpha, st, 'b2', 'waiting', 'Claude needs your permission to use Bash')
    }
    try {
      await watchWith(w, home, st, [rel])
    } finally {
      watches.testHooks.cardRead = undefined
    }
    expect(st.agents.b2).toBe('waiting')
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.told).toHaveLength(1), { timeout: HUNG_MS })
    expect(st.told[0]).toContain(`B2 (alpha) is waiting for the user on #${rel}`)
    await disposeWorkspaceService(w)
  })

  it('an agent waiting for the user wakes a lane watch once a wait, naming it, its card and what it waits for; events can leave it out (#726)', async () => {
    const { w, alpha, home } = await open()
    const st = fake(alpha, home)
    const [a] = await newCards(w, 'b1', 1)
    const [rel] = await newCards(w, 'b2', 1)
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a], by: 'B1 (alpha)' })
    await watchAll(w, home, st)
    // (c) B2, on the release card in no lane, shows a permission prompt.
    status(alpha, st, 'b2', 'waiting', 'Claude needs your permission to use Bash')
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.told).toHaveLength(1), { timeout: HUNG_MS })
    expect(st.told[0]).toMatch(new RegExp(`^\\[CW\\] B2 \\(alpha\\) is waiting for the user on #${rel}: "Claude needs your permission to use Bash"\\. Your lane watch has ended: .*tell the user what an agent waits for \\(cw_notify\\) and never answer it for them`))
    // The same wait again (a refresh of its status): not told again.
    await watchAll(w, home, st)
    status(alpha, st, 'b2', 'waiting', 'Claude needs your permission to use Bash')
    await watches.evaluateWatches(w)
    await watches.settled()
    expect(st.typed).toHaveLength(1)
    // A wait that ended before it was checked (the user answered at once) isn't told.
    status(alpha, st, 'b2', 'working')
    status(alpha, st, 'b1', 'waiting', 'Claude needs your permission to use Edit')
    status(alpha, st, 'b1', 'working')
    await watches.evaluateWatches(w)
    await watches.settled()
    expect(st.typed).toHaveLength(1)
    // It works, then waits again: a new wait, told.
    status(alpha, st, 'b2', 'waiting', 'Claude needs your permission to use Write')
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.told).toHaveLength(2), { timeout: HUNG_MS })
    expect(st.told[1]).toContain('B2 (alpha) is waiting for the user')
    expect(st.told[1]).toContain('use Write')
    expect(st.told[1]).not.toContain('use Edit')
    // Left out of events: quiet.
    await watchAll(w, home, st, ['failed', 'blocked'])
    status(alpha, st, 'b2', 'working')
    status(alpha, st, 'b2', 'waiting', 'Claude needs your permission to use Read')
    await watches.evaluateWatches(w)
    await watches.settled()
    expect(st.typed).toHaveLength(2)
    await disposeWorkspaceService(w)
  })
})
