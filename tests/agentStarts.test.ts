// Starts under way, and the last that failed (HI-1976): what the stall check reads to tell an agent starting (a Start, its
// slot being prepared) from one that isn't running, and one whose start failed, with why. The stall itself, through a lane
// watch, is laneWatch.test.ts's; the holds a Start and a placement take, taskStartSlot.test.ts's and slotCards.test.ts's.
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { START_HOLD_MS, resetAgentStartsForTests, startBegins, startBegun, startEnded, startFailed, startNow } from '../src/main/agentStarts'
import { tempDir } from './tempDir'

const p = join(tempDir('agentstarts-'), 'alpha')

afterEach(() => resetAgentStartsForTests())

describe('an agent being started (HI-1976)', () => {
  it('is starting while a hold is on, by its project and agent (a path in another case or form is the same), and not once it ends', () => {
    expect(startNow(p, 'b1')).toEqual({ starting: false, failed: null })
    startBegun(p, 'b1', '#12', { fresh: true })
    expect(startNow(p, 'b1')).toEqual({ starting: true, failed: null })
    expect(startNow(p.toUpperCase(), 'b1').starting).toBe(true)
    expect(startNow(join(p, 'x', '..'), 'b1').starting).toBe(true)
    expect(startNow(p, 'b2').starting).toBe(false)
    startEnded(p, 'b1', '#12')
    expect(startNow(p, 'b1')).toEqual({ starting: false, failed: null })
  })

  it("a placement takes its Start's hold over (the same tag): one end ends it; another start's hold keeps it starting", () => {
    startBegun(p, 'b1', '#12', { fresh: true })
    startBegun(p, 'b1', '#12')
    startBegun(p, 'b1', '#13')
    startEnded(p, 'b1', '#12')
    expect(startNow(p, 'b1').starting).toBe(true)
    startEnded(p, 'b1', '#13')
    expect(startNow(p, 'b1').starting).toBe(false)
  })

  it('a slow start stays starting; a hold never ended counts for START_HOLD_MS at most', () => {
    const t0 = Date.now()
    startBegun(p, 'b1', '#12')
    expect(startNow(p, 'b1', t0 + 15_000).starting).toBe(true)
    expect(startNow(p, 'b1', t0 + START_HOLD_MS - 1000).starting).toBe(true)
    expect(startNow(p, 'b1', t0 + START_HOLD_MS + 1000).starting).toBe(false)
  })
})

describe('a start that failed (HI-1976)', () => {
  it('is said with why (its lines as one), over any hold, until a session of it is started again', () => {
    startBegun(p, 'b1', '#12', { fresh: true })
    startEnded(p, 'b1', '#12', { failed: "Hive couldn't get slot-g ready:\n  git worktree add failed" })
    expect(startNow(p, 'b1')).toEqual({ starting: false, failed: "Hive couldn't get slot-g ready: | git worktree add failed" })
    // A retry's hold doesn't hide it; its plain end keeps it.
    startBegun(p, 'b1', '#12')
    expect(startNow(p, 'b1').failed).toMatch(/git worktree add failed/)
    startEnded(p, 'b1', '#12')
    expect(startNow(p, 'b1').failed).toMatch(/git worktree add failed/)
    startBegins(p, 'b1')
    expect(startNow(p, 'b1')).toEqual({ starting: false, failed: null })
  })

  it("a CLI that exits before its session starts is a failure; a new Start (fresh) or a placement given ends it", () => {
    startFailed(p, 'b1', 'error: unknown option --bogus')
    expect(startNow(p, 'b1').failed).toBe('error: unknown option --bogus')
    startBegun(p, 'b1', '#12', { fresh: true })
    expect(startNow(p, 'b1')).toEqual({ starting: true, failed: null })
    startEnded(p, 'b1', '#12', { failed: 'its delivery was refused' })
    startBegun(p, 'b1', '#12')
    startEnded(p, 'b1', '#12', { ok: true })
    expect(startNow(p, 'b1')).toEqual({ starting: false, failed: null })
  })

  it("a start's success clears only a failure of its own tries, never its CLI's, which may land while it finishes (HR6's round 2)", () => {
    // The placement's launch spawned the CLI, which failed; the placement then ends well, its exit's clean-up still going.
    startBegun(p, 'b1', '#12', { fresh: true })
    startFailed(p, 'b1', 'error: unknown option --bogus')
    startEnded(p, 'b1', '#12', { ok: true })
    expect(startNow(p, 'b1')).toEqual({ starting: false, failed: 'error: unknown option --bogus' })
    // Another start's success leaves a failure it didn't record, too.
    startEnded(p, 'b1', '#13', { failed: 'its slot could not be prepared' })
    startEnded(p, 'b1', '#12', { ok: true })
    expect(startNow(p, 'b1').failed).toBe('its slot could not be prepared')
    // Only a new attempt clears a CLI's: a new launch of its session, or a new Start.
    startFailed(p, 'b1', 'error: unknown option --bogus')
    startBegins(p, 'b1')
    expect(startNow(p, 'b1').failed).toBeNull()
  })
})
