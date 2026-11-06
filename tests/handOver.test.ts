// A long conversation's hand-over (#1057): Hand Over to… is offered, and a hand-over to the agent itself allowed, only
// while it is idle, not merging and on no running lane's card.
import { describe, expect, it } from 'vitest'
import { handOverNow, onRunningLane } from '../src/shared/handOver'
import type { LaneInfo, LaneState, LiveSessionState, SessionStatus } from '../src/shared/types'

const live = (status: SessionStatus, more: Partial<LiveSessionState> = {}): Pick<LiveSessionState, 'status' | 'provider' | 'backgroundTasks' | 'mergeSlot'> => ({ status, provider: 'claude', ...more })

const lane = (state: LaneState, builder = 'b1', reviewer = 'r1', project = 'demo'): LaneInfo => ({ id: 'lane-1', project, builder: { id: builder, name: 'B1' }, reviewer: { id: reviewer, name: 'R1' }, state }) as LaneInfo

describe('handOverNow', () => {
  it('lets an idle agent on no lane hand over now', () => {
    expect(handOverNow(live('ready'), false)).toBe(true)
    expect(handOverNow(live('finished'), false)).toBe(true)
  })

  it('not while it works, waits, watches, has background tasks that will wake it, or merges', () => {
    for (const s of ['working', 'waiting', 'watching', 'background', 'starting'] as SessionStatus[]) expect(handOverNow(live(s), false)).toBe(false)
    expect(handOverNow(live('finished', { backgroundTasks: 1 }), false)).toBe(false)
    expect(handOverNow(live('ready', { mergeSlot: 'Merging into main' }), false)).toBe(false)
  })

  it('not on a running lane, even idle', () => {
    expect(handOverNow(live('finished'), true)).toBe(false)
  })

  it('an agent not running ends nothing: allowed', () => {
    expect(handOverNow(null, true)).toBe(true)
    expect(handOverNow(live('stopped'), true)).toBe(true)
  })
})

describe('onRunningLane', () => {
  it("finds the agent as a running lane's builder or reviewer, in its project", () => {
    expect(onRunningLane([lane('active')], 'demo', 'b1')).toBe(true)
    expect(onRunningLane([lane('paused')], 'Demo', 'r1')).toBe(true)
    expect(onRunningLane([lane('ended'), lane('abandoned')], 'demo', 'b1')).toBe(false)
    expect(onRunningLane([lane('active')], 'other', 'b1')).toBe(false)
    expect(onRunningLane([lane('active')], 'demo', 'x9')).toBe(false)
  })
})
