// Agent moves shown before they are saved (#1229): a report that read the project before the save keeps the order and
// the panes' cells as the window shows them (the latest move's that wasn't refused), with the agents' state as reported;
// once the last move has ended, reports are taken as they come, and if one was refused the window reads the workspace
// again. Here as App.tsx's workspace-changed handler and actions.ts's moves use it.
import { describe, expect, it } from 'vitest'
import { pendingMoves } from '../src/renderer/src/pendingMoves'
import type { WorkspaceInfo } from '../src/shared/types'

const alpha = 'C:\\ws\\alpha'
const beta = 'C:\\ws\\beta'
type Cells = (string | null)[]
/** A workspace as Hive reports it: alpha's agents in this order (each with a status), beta's two. */
const report = (order: string, opts: { status?: string; cells?: Cells } = {}): WorkspaceInfo =>
  ({
    path: 'C:\\ws',
    projects: [
      { path: alpha, config: { layout: 'auto', ...(opts.cells ? { placement: { grid6: opts.cells } } : {}) }, agents: order.split(',').map((id) => ({ id, live: { status: opts.status ?? 'idle' } })) },
      { path: beta, config: {}, agents: [{ id: 'b1' }, { id: 'b2' }] }
    ]
  }) as unknown as WorkspaceInfo
const alphaOf = (ws: WorkspaceInfo | null) => ws!.projects.find((p) => p.path === alpha)!
const ids = (ws: WorkspaceInfo | null, path = alpha): string => ws!.projects.find((p) => p.path === path)!.agents.map((a) => a.id).join(',')

/** A window's store and its handler of workspace-changed. */
function windowOf(moves: ReturnType<typeof pendingMoves>) {
  let shown: WorkspaceInfo | null = report('a1,a2,a3')
  return {
    shown: () => shown,
    /** A move as actions.ts makes one: shown at once, then saved (begin returns the end it calls). */
    move: (order: string) => {
      shown = { ...shown!, projects: shown!.projects.map((p) => (p.path === alpha ? { ...p, agents: order.split(',').map((id) => p.agents.find((a) => a.id === id)!) } : p)) }
      return moves.begin(alpha, { order: order.split(',') })
    },
    /** A pane placed: its cells (grid6) and the order they read, shown at once. */
    place: (cells: Cells) => {
      const order = cells.filter((c): c is string => !!c)
      shown = { ...shown!, projects: shown!.projects.map((p) => (p.path === alpha ? { ...p, config: { ...p.config, layout: 'grid6', placement: { grid6: cells } }, agents: order.map((id) => p.agents.find((a) => a.id === id)!) } : p)) }
      return moves.begin(alpha, { order, placement: { grid6: cells }, layout: 'grid6' })
    },
    deliver: (ws: WorkspaceInfo) => void (shown = moves.keep(ws))
  }
}

describe('a move shown while it is saved (#1229)', () => {
  it('a report from before the save keeps the order shown, with the state as reported; once saved, reports as they come', () => {
    const w = windowOf(pendingMoves())
    const end = w.move('a3,a1,a2')
    // Read before the save landed: the order from before.
    w.deliver(report('a1,a2,a3', { status: 'working' }))
    expect(ids(w.shown())).toBe('a3,a1,a2')
    expect(alphaOf(w.shown()).agents.map((a) => a.live?.status)).toEqual(['working', 'working', 'working'])
    // The move's own refresh, then the save's reply: nothing to read again.
    w.deliver(report('a3,a1,a2'))
    expect(end(true)).toBe(false)
    w.deliver(report('a2,a3,a1'))
    expect(ids(w.shown())).toBe('a2,a3,a1')
  })

  it('without the tracker, the same report puts the order back (what it guards against)', () => {
    const w = windowOf(pendingMoves())
    w.move('a3,a1,a2')(true)
    w.deliver(report('a1,a2,a3'))
    expect(ids(w.shown())).toBe('a1,a2,a3')
  })

  it('two quick moves saved: the later one is kept until both have ended, in either order; ending one twice ends it once', () => {
    const w = windowOf(pendingMoves())
    const first = w.move('a3,a1,a2')
    const second = w.move('a1,a3,a2')
    expect(first(true)).toBe(false)
    expect(first(true)).toBe(false)
    w.deliver(report('a3,a1,a2'))
    expect(ids(w.shown())).toBe('a1,a3,a2')
    expect(second(true)).toBe(false)
    w.deliver(report('a3,a1,a2'))
    expect(ids(w.shown())).toBe('a3,a1,a2')
    // The later saved first, the earlier still ending: still the later's.
    const third = w.move('a2,a3,a1')
    const fourth = w.move('a3,a2,a1')
    fourth(true)
    w.deliver(report('a3,a1,a2'))
    expect(ids(w.shown())).toBe('a3,a2,a1')
    expect(third(true)).toBe(false)
  })

  it('the later of two panes placed refused while the earlier saves (HR1 round 2): the earlier is shown, and the window reads it again once both end', () => {
    const w = windowOf(pendingMoves())
    const before = w.shown()
    const first = w.place([null, 'a2', 'a1', 'a3'])
    const second = w.place([null, 'a2', 'a3', 'a1'])
    // The later is refused: its own refresh (read while the earlier's save is held) shows the earlier's, not the refused.
    expect(second(false)).toBe(false)
    w.deliver(before!)
    expect(ids(w.shown())).toBe('a2,a1,a3')
    expect(alphaOf(w.shown()).config.placement).toEqual({ grid6: [null, 'a2', 'a1', 'a3'] })
    // The earlier's own refresh, as saved, then its reply: the last to end, with one refused, so the window reads again.
    const saved = report('a2,a1,a3', { cells: [null, 'a2', 'a1', 'a3'] })
    w.deliver(saved)
    expect(first(true)).toBe(true)
    w.deliver(saved)
    expect(ids(w.shown())).toBe('a2,a1,a3')
    expect(alphaOf(w.shown()).config).toMatchObject({ placement: { grid6: [null, 'a2', 'a1', 'a3'] } })
  })

  it('the later of two moves refused, the earlier refused too: reports as they come, and the last end reads again', () => {
    const w = windowOf(pendingMoves())
    const first = w.move('a3,a1,a2')
    const second = w.move('a1,a3,a2')
    expect(second(false)).toBe(false)
    expect(first(false)).toBe(true)
    w.deliver(report('a1,a2,a3'))
    expect(ids(w.shown())).toBe('a1,a2,a3')
  })

  it('the earlier of two moves refused while the later saves: the later is kept, then read again', () => {
    const w = windowOf(pendingMoves())
    const first = w.move('a3,a1,a2')
    const second = w.move('a1,a3,a2')
    expect(first(false)).toBe(false)
    w.deliver(report('a1,a2,a3'))
    expect(ids(w.shown())).toBe('a1,a3,a2')
    expect(second(true)).toBe(true)
  })

  it("an agent added meanwhile comes after the order shown; one removed goes; another project's report is as it came", () => {
    const w = windowOf(pendingMoves())
    const end = w.move('a3,a1,a2')
    w.deliver(report('a1,a4,a3'))
    expect(ids(w.shown())).toBe('a3,a1,a4')
    expect(ids(w.shown(), beta)).toBe('b1,b2')
    end(true)
  })

  it("a pane placed keeps the cells and layout shown, the agents' order as the cells read", () => {
    const moves = pendingMoves()
    const end = moves.begin(alpha, { order: ['a2', 'a1', 'a3'], placement: { grid6: [null, 'a2', 'a1', 'a3'] }, layout: 'grid6' })
    const kept = moves.keep(report('a1,a2,a3', { cells: ['a1', 'a2', 'a3'] }))
    expect(ids(kept)).toBe('a2,a1,a3')
    expect(alphaOf(kept).config).toMatchObject({ layout: 'grid6', placement: { grid6: [null, 'a2', 'a1', 'a3'] } })
    end(true)
    expect(alphaOf(moves.keep(report('a1,a2,a3', { cells: ['a1', 'a2', 'a3'] }))).config.placement).toEqual({ grid6: ['a1', 'a2', 'a3'] })
  })

  it('with nothing being saved, a report is the same object; no workspace stays none', () => {
    const moves = pendingMoves()
    const ws = report('a1,a2,a3')
    expect(moves.keep(ws)).toBe(ws)
    moves.begin(alpha, { order: ['a1'] })
    expect(moves.keep(null)).toBeNull()
  })
})
