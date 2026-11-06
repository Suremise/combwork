// Agent pages (#134): one layout for the project (automatic until chosen), and a page holds as many agents as it has
// panes, so every agent on a page has a pane: pages = agents ÷ panes. One at a time (Single) is one page of every agent.
import { describe, expect, it } from 'vitest'
import { AGENT_LIMIT_DEFAULT, AGENT_LIMIT_MAX, SESSION_LAYOUTS, agentPageCount, agentsPerPage, chosenLayout, layoutColumns, layoutFitting, paneColumnsFor, tileStripRoom, layoutForAgents, layoutPanes, migrateProjectConfig, pageAgents, pageEndIndex, pageOfAgent, projectLayout, projectPerPage } from '../src/shared/defaults'
import type { PageLayout, SessionLayout } from '../src/shared/types'

const agents = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `a${i + 1}`, name: `Agent ${i + 1}` }))
const cfg = (n: number, layout: PageLayout = 'auto') => ({ agents: agents(n), layout })
/** Each page's agents, as ids joined: "a1a2a3|a4". */
const pages = (n: number, layout: PageLayout = 'auto') => {
  const per = projectPerPage(cfg(n, layout))
  return Array.from({ length: agentPageCount(n, per) }, (_, p) => pageAgents(agents(n), p, per).map((a) => a.id).join('')).join('|')
}

describe('agent pages follow the layout (#134)', () => {
  it('pages = agents ÷ panes: the examples on the card', () => {
    // 6 agents in a grid of 4: 4 + 2.
    expect(pages(6, 'grid')).toBe('a1a2a3a4|a5a6')
    // 4 agents in 3 columns: 3 + 1.
    expect(pages(4, 'columns3')).toBe('a1a2a3|a4')
    // 12 agents in a grid of 6: 6 + 6.
    expect(pages(12, 'grid6')).toBe('a1a2a3a4a5a6|a7a8a9a10a11a12')
    // One at a time: one page of every agent (its tabs choose the one shown), so never any page buttons.
    expect(pages(12, 'single')).toBe('a1a2a3a4a5a6a7a8a9a10a11a12')
    // 24, the most Agents per project allows (#562): four pages of six; one at a time, still one page.
    expect(pages(24, 'grid6').split('|').length).toBe(4)
    expect(pages(24, 'single').split('|').length).toBe(1)
  })

  it('for every layout and every count from 1 to 24 (#562), auto included: each agent on exactly one page, every page full but the last', () => {
    expect([AGENT_LIMIT_DEFAULT, AGENT_LIMIT_MAX]).toEqual([12, 24])
    for (const layout of ['auto', ...SESSION_LAYOUTS.map((l) => l.value)] as PageLayout[]) {
      for (let n = 1; n <= AGENT_LIMIT_MAX; n++) {
        const shown = projectLayout(cfg(n, layout))
        const per = agentsPerPage(shown)
        const count = agentPageCount(n, per)
        const all = Array.from({ length: count }, (_, p) => pageAgents(agents(n), p, per))
        expect(all.flat().map((a) => a.id), `${layout} × ${n}`).toEqual(agents(n).map((a) => a.id))
        for (const [p, list] of all.entries()) {
          if (p < count - 1) expect(list.length, `${layout} × ${n}, page ${p + 1}`).toBe(per)
          expect(list.length).toBeGreaterThan(0)
          // A page fits its layout: every agent has a pane (Single shows the focused one).
          if (shown !== 'single') expect(list.length).toBeLessThanOrEqual(layoutPanes(shown))
          for (const i of list.keys()) expect(pageOfAgent(p * per + i, per)).toBe(p)
        }
        expect(count).toBe(shown === 'single' ? 1 : Math.ceil(n / layoutPanes(shown)))
      }
    }
  })

  it('auto shows every agent up to the 3×2 grid, then pages of six', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 12, 24].map(layoutForAgents)).toEqual(['single', 'columns2', 'columns3', 'grid', 'grid6', 'grid6', 'grid6', 'grid6', 'grid6'])
    expect(projectLayout(cfg(4))).toBe('grid')
    expect(pages(5)).toBe('a1a2a3a4a5')
    expect(pages(7)).toBe('a1a2a3a4a5a6|a7')
    expect(pages(0)).toBe('')
    expect(agentPageCount(0, 6)).toBe(1)
    // A layout that isn't one Combwork knows reads as automatic.
    expect(projectLayout({ agents: agents(3), layout: 'mosaic' as SessionLayout })).toBe('columns3')
  })

  it('choosing the layout that shows the agents makes it automatic again; another is kept as chosen', () => {
    expect(chosenLayout(cfg(4), 'grid')).toBe('auto')
    expect(chosenLayout(cfg(4), 'columns3')).toBe('columns3')
    expect(chosenLayout(cfg(7), 'grid6')).toBe('auto')
    expect(projectLayout(cfg(9, 'columns3'))).toBe('columns3')
  })

  it("a drop on a page's button lands at that page's last place, with the page size of the layout", () => {
    // 4 agents in 3 columns: page 1 ends at index 2, page 2 at 3.
    expect([0, 1].map((p) => pageEndIndex(4, p, 3))).toEqual([2, 3])
    expect(pageEndIndex(6, 0, 4)).toBe(3)
    expect(pageEndIndex(3, 0, 6)).toBe(2)
  })

  it("migrates one layout a page to one for the project: page 1's, else automatic", () => {
    expect(migrateProjectConfig({ version: 2, agents: agents(6), layouts: ['grid', 'grid6'] })).toMatchObject({ layout: 'grid' })
    expect(migrateProjectConfig({ version: 2, agents: agents(6), layouts: ['auto', 'single'] })).toMatchObject({ layout: 'auto' })
    expect(migrateProjectConfig({ version: 2, agents: agents(2), layouts: [] })).toMatchObject({ layout: 'auto' })
    expect(migrateProjectConfig({ version: 2, agents: agents(2), layouts: ['bogus'] })).toMatchObject({ layout: 'auto' })
    expect('layouts' in migrateProjectConfig({ version: 2, agents: agents(2), layouts: ['grid'] })).toBe(false)
    // Before agent pages (one layout for every agent): automatic when it showed them all, else kept.
    expect(migrateProjectConfig({ version: 2, agents: agents(4), sessionLayout: 'grid' })).toMatchObject({ layout: 'auto' })
    expect(migrateProjectConfig({ version: 2, agents: agents(3), sessionLayout: 'single' })).toMatchObject({ layout: 'single' })
    expect(migrateProjectConfig({ version: 2, agents: agents(2) })).toMatchObject({ layout: 'auto' })
    expect('sessionLayout' in migrateProjectConfig({ version: 2, agents: [], sessionLayout: 'grid' })).toBe(false)
    // Already one layout: kept; a stray old array beside it goes; an unknown one reads as automatic.
    expect(migrateProjectConfig({ version: 2, agents: agents(2), layout: 'columns3' })).toMatchObject({ layout: 'columns3' })
    const both = migrateProjectConfig({ version: 2, agents: agents(2), layout: 'columns3', layouts: ['grid'] })
    expect([both.layout, 'layouts' in both]).toEqual(['columns3', false])
    expect(migrateProjectConfig({ version: 2, agents: agents(2), layout: 'mosaic' })).toMatchObject({ layout: 'auto' })
  })
})

describe('a layout too wide for the room drops columns (#1037)', () => {
  it('each layout, as fewer columns fit: the grids keep their rows, then one at a time', () => {
    const shown = (l: SessionLayout) => [3, 2, 1].map((c) => layoutFitting(l, c)).join(' ')
    expect(shown('columns3')).toBe('columns3 columns2 single')
    expect(shown('columns2')).toBe('columns2 columns2 single')
    expect(shown('grid6')).toBe('grid6 grid single')
    expect(shown('grid')).toBe('grid grid single')
    expect(shown('single')).toBe('single single single')
  })

  it('never more columns than fit, the chosen one when they all fit or before it is measured', () => {
    for (const { value } of SESSION_LAYOUTS) {
      expect(layoutFitting(value, null)).toBe(value)
      expect(layoutFitting(value, 9)).toBe(value)
      for (const c of [0, 1, 2, 3]) expect(layoutColumns(layoutFitting(value, c))).toBeLessThanOrEqual(Math.max(1, c))
    }
  })
})

describe('how many panes fit, with a margin before giving one back (#1037)', () => {
  it('first measured: as many as fit', () => {
    expect(paneColumnsFor(399, 200, null, 24)).toBe(1)
    expect(paneColumnsFor(400, 200, null, 24)).toBe(2)
    expect(paneColumnsFor(150, 200, null, 24)).toBe(1)
  })

  it('a pixel at a time across the boundary: one change each way, two again only past the margin', () => {
    const walk = (widths: number[]) => {
      let n: number | null = 1
      const changes: number[] = []
      for (const w of widths) {
        const next = paneColumnsFor(w, 200, n, 24)
        if (next !== n) changes.push(w)
        n = next
      }
      return changes
    }
    const up = Array.from({ length: 80 }, (_, i) => 380 + i)
    expect(walk(up)).toEqual([424])
    // From two, narrowing: one as soon as two don't fit.
    let n: number | null = 2
    const down: number[] = []
    for (const w of [...up].reverse()) {
      const next = paneColumnsFor(w, 200, n, 24)
      if (next !== n) down.push(w)
      n = next
    }
    expect(down).toEqual([399])
    // Wiggling a pixel either side of 400 changes nothing.
    expect(paneColumnsFor(401, 200, 1, 24)).toBe(1)
    expect(paneColumnsFor(400, 200, 2, 24)).toBe(2)
  })
})

describe("the focus view's strip gives way to the terminal beside it (#1037, #1050)", () => {
  // A terminal's least 200 px, the strip's 170.
  const room = (width: number, was: number | null = null) => tileStripRoom(width, 200, 170, was, 24)

  it('at most 40% of the width, so the strip is at its least before the terminal is (a 13 px font)', () => {
    // Wide: 40% (the chosen width, up to 420, is shown when it is less).
    expect(room(1200)).toBe(480)
    expect(room(700)).toBe(280)
    // At its least from 425 px down, the terminal still 255 px.
    expect(room(425)).toBe(170)
    expect(room(400)).toBe(170)
    // Then the terminal narrows to its least, and the strip hides.
    expect(room(370)).toBe(170)
    expect(room(369)).toBe(0)
  })

  it('whatever the terminal font: the strip at its least while the terminal still has the margin over its own', () => {
    // A 24 px font (HR4's case): the terminal's least is 342 px.
    expect(tileStripRoom(566, 342, 170, 170, 24)).toBe(185)
    expect(tileStripRoom(516, 342, 170, 170, 24)).toBe(170)
    for (const paneMin of [200, 260, 342, 500]) {
      let was: number | null = null
      for (let width = 1600; width >= 300; width--) {
        const strip = tileStripRoom(width, paneMin, 170, was, 24)
        if (strip > 170) expect(width - strip, `${paneMin} at ${width}`).toBeGreaterThanOrEqual(paneMin + 24)
        if (strip > 0) expect(width - strip, `${paneMin} at ${width}`).toBeGreaterThanOrEqual(paneMin)
        expect(strip, `${paneMin} at ${width}`).toBeLessThanOrEqual(Math.max(170, width * 0.4))
        was = strip
      }
    }
  })

  it('a pixel at a time across where it hides: shown again only past the margin', () => {
    expect(room(369, 170)).toBe(0)
    expect(room(370, 0)).toBe(0)
    expect(room(393, 0)).toBe(0)
    expect(room(394, 0)).toBe(170)
    expect(room(380, 170)).toBe(170)
  })
})
