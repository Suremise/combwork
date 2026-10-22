// Agent moves shown before they are saved (#1229): a report that read the project before the save keeps the order and
// the panes' cells as the window shows them, with the agents' state as reported; once the move is saved or refused,
// reports are taken as they come. Here as App.tsx's workspace-changed handler and actions.ts's moves use it.
import { describe, expect, it } from 'vitest'
import { pendingMoves } from '../src/renderer/src/pendingMoves'
import type { WorkspaceInfo } from '../src/shared/types'

const alpha = 'C:\\ws\\alpha'
const beta = 'C:\\ws\\beta'
/** A workspace as Hive reports it: alpha's agents in this order (each with a status), beta's two. */
const report = (order: string, opts: { status?: string; placement?: Record<string, (string | null)[]> } = {}): WorkspaceInfo =>
  ({
    path: 'C:\\ws',
    projects: [
      { path: alpha, config: { layout: 'auto', ...(opts.placement ? { placement: opts.placement } : {}) }, agents: order.split(',').map((id) => ({ id, live: { status: opts.status ?? 'idle' } })) },
      { path: beta, config: {}, agents: [{ id: 'b1' }, { id: 'b2' }] }
    ]
  }) as unknown as WorkspaceInfo
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
    expect(w.shown()!.projects[0].agents.map((a) => a.live?.status)).toEqual(['working', 'working', 'working'])
    // The move's own refresh, then the save's reply.
    w.deliver(report('a3,a1,a2'))
    end()
    w.deliver(report('a2,a3,a1'))
    expect(ids(w.shown())).toBe('a2,a3,a1')
  })

  it('without the tracker, the same report puts the order back (what it guards against)', () => {
    const moves = pendingMoves()
    const w = windowOf(moves)
    w.move('a3,a1,a2')()
    w.deliver(report('a1,a2,a3'))
    expect(ids(w.shown())).toBe('a1,a2,a3')
  })

  it('two quick moves: the later one is kept until both are saved; ending one twice ends it once', () => {
    const w = windowOf(pendingMoves())
    const first = w.move('a3,a1,a2')
    const second = w.move('a1,a3,a2')
    first()
    first()
    w.deliver(report('a3,a1,a2'))
    expect(ids(w.shown())).toBe('a1,a3,a2')
    second()
    w.deliver(report('a3,a1,a2'))
    expect(ids(w.shown())).toBe('a3,a1,a2')
  })

  it("an agent added meanwhile comes after the order shown; one removed goes; another project's report is as it came", () => {
    const w = windowOf(pendingMoves())
    const end = w.move('a3,a1,a2')
    w.deliver(report('a1,a4,a3'))
    expect(ids(w.shown())).toBe('a3,a1,a4')
    expect(ids(w.shown(), beta)).toBe('b1,b2')
    end()
  })

  it("a pane placed keeps the cells and layout shown, the agents' order as the cells read", () => {
    const moves = pendingMoves()
    const end = moves.begin(alpha, { order: ['a2', 'a1', 'a3'], placement: { grid6: [null, 'a2', 'a1', 'a3'] }, layout: 'grid6' })
    const kept = moves.keep(report('a1,a2,a3', { placement: { grid6: ['a1', 'a2', 'a3'] } }))
    expect(ids(kept)).toBe('a2,a1,a3')
    expect(kept!.projects[0].config).toMatchObject({ layout: 'grid6', placement: { grid6: [null, 'a2', 'a1', 'a3'] } })
    end()
    expect(moves.keep(report('a1,a2,a3', { placement: { grid6: ['a1', 'a2', 'a3'] } }))!.projects[0].config.placement).toEqual({ grid6: ['a1', 'a2', 'a3'] })
  })

  it('with nothing being saved, a report is the same object; no workspace stays none', () => {
    const moves = pendingMoves()
    const ws = report('a1,a2,a3')
    expect(moves.keep(ws)).toBe(ws)
    moves.begin(alpha, { order: ['a1'] })
    expect(moves.keep(null)).toBeNull()
  })
})
