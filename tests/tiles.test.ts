import { describe, expect, it } from 'vitest'
import { REPLY_START_MAX, TILES_PER_PAGE, isUrgent, replyStart, tileOrder, tilePageCount, tilePageOf, tilePageShown, tilesOnPage, tilesPerPage, tilesThatFit, TILES_PER_PAGE_MIN, urgentByPage } from '../src/shared/tiles'
import type { AgentState } from '../src/shared/agentState'

describe('the Tiles view (#976)', () => {
  const states: AgentState[] = ['idle', 'working', 'waiting', 'idle', 'stalled', 'working']

  it('keeps the panes order by default, and sorts by urgency on request (the panes order within a state)', () => {
    expect(tileOrder(states, 'panes')).toEqual([0, 1, 2, 3, 4, 5])
    expect(tileOrder(states, 'urgency')).toEqual([2, 4, 1, 5, 0, 3])
  })

  it('counts waiting and stalled as urgent', () => {
    expect((['waiting', 'stalled', 'working', 'idle'] as AgentState[]).map(isUrgent)).toEqual([true, true, false, false])
  })

  it('holds as many tiles a page as fit (HI-1951): 13 agents on one page where 35 fit, paged where 12 or 6 fit', () => {
    const ids = Array.from({ length: 13 }, (_, i) => i)
    // Darren's window: 5 columns, about 7 rows.
    expect([0, 1, 13, 24, 35, 36].map((n) => tilePageCount(n, 35))).toEqual([1, 1, 1, 1, 1, 2])
    expect(tilesOnPage(ids, 0, 35)).toEqual(ids)
    expect(tilePageOf(12, 35)).toBe(0)
    // A smaller window: 12, then 6, a page.
    expect([0, 1, 12, 13, 24].map((n) => tilePageCount(n, 12))).toEqual([1, 1, 1, 2, 2])
    expect(tilePageOf(11, 12)).toBe(0)
    expect(tilePageOf(12, 12)).toBe(1)
    expect(tilesOnPage(ids, 0, 12)).toHaveLength(12)
    expect(tilesOnPage(ids, 1, 12)).toEqual([12])
    expect(tilePageCount(13, 6)).toBe(3)
    expect(tilesOnPage(ids, 2, 6)).toEqual([12])
    // Not measured yet (0, null): TILES_PER_PAGE, 12.
    expect(TILES_PER_PAGE).toBe(12)
    expect([tilesPerPage(null), tilesPerPage(0), tilesPerPage(undefined), tilesPerPage(7.9)]).toEqual([12, 12, 12, 7])
    expect(tilePageCount(13, 0)).toBe(2)
    // Never fewer than 6 a page (Darren's decision: as Panes' largest page), however few fit: a small window scrolls.
    expect(TILES_PER_PAGE_MIN).toBe(6)
    expect([1, 4, 6].map(tilesPerPage)).toEqual([6, 6, 6])
    expect(tilePageCount(13, 2)).toBe(3)
    expect(tilesOnPage(ids, 0, 4)).toHaveLength(6)
  })

  it('fits columns × whole rows of tiles in the area, at least one row; null when it cannot be measured', () => {
    // 5 columns, 7 rows of 120 px tiles with 8 px gaps in 892 px: (892 + 8) / 128 = 7.03.
    expect(tilesThatFit({ columns: 5, height: 892, tileHeight: 120, gap: 8 })).toBe(35)
    // One pixel short of the seventh row: six.
    expect(tilesThatFit({ columns: 5, height: 887, tileHeight: 120, gap: 8 })).toBe(30)
    // Shorter than a tile: one row still (the grid scrolls).
    expect(tilesThatFit({ columns: 2, height: 50, tileHeight: 120, gap: 8 })).toBe(2)
    expect(tilesThatFit({ columns: 0, height: 892, tileHeight: 120, gap: 8 })).toBeNull()
    expect(tilesThatFit({ columns: 5, height: 0, tileHeight: 120, gap: 8 })).toBeNull()
    expect(tilesThatFit({ columns: 5, height: 892, tileHeight: 0, gap: 8 })).toBeNull()
  })

  it('shows a page there is: one past the end (agents removed, or more now fit a page) is the last', () => {
    expect(tilePageShown(1, 13, 12)).toBe(1)
    expect(tilePageShown(1, 12, 12)).toBe(0)
    expect(tilePageShown(1, 13, 35)).toBe(0)
    expect(tilePageShown(-1, 30, 12)).toBe(0)
    expect(tilePageShown(Number.NaN, 30, 12)).toBe(0)
  })

  it('counts the urgent tiles on each page, for the page control', () => {
    const many: AgentState[] = [...Array<AgentState>(12).fill('idle'), 'waiting', 'stalled', 'working']
    expect(urgentByPage(many, 12)).toEqual([0, 2])
    expect(urgentByPage(many, 6)).toEqual([0, 0, 2])
    expect(urgentByPage(many, 35)).toEqual([2])
    expect(urgentByPage(['waiting'], 12)).toEqual([1])
  })

  it("takes the start of a reply: Markdown's marks out, whitespace run together, cut short", () => {
    expect(replyStart('## Done\n\nMerged **#12** into `main`.\n')).toBe('Done Merged #12 into main.')
    expect(replyStart('   \n')).toBeUndefined()
    expect(replyStart(null)).toBeUndefined()
    const long = replyStart('word '.repeat(200))!
    expect(long.length).toBeLessThanOrEqual(REPLY_START_MAX)
    expect(long.endsWith('…')).toBe(true)
  })
})
