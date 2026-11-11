// Progress → Lanes' quick edits in the window (HI-2932): each asked in turn, made from the lanes read again after the
// last. HR1's round 1: two lanes' edits each read the whole list again; when the first's slower read landed last it put
// the second lane back to an older revision, and its next edit was refused as changed meanwhile. Here main and its
// replies are stood in for: each read of the lanes answers only when the test lets it, in any order.
import { describe, expect, it, vi } from 'vitest'

interface FakeLane {
  id: string
  listRev: number
}
const state = vi.hoisted(() => ({
  store: { workspace: { path: 'W' }, lanes: [] as FakeLane[] },
  main: new Map<string, number>(),
  edits: [] as { lane: string; rev: number }[],
  reads: [] as { snapshot: FakeLane[]; answer: () => void }[]
}))

vi.mock('../src/renderer/src/store', () => ({
  get: () => state.store,
  set: (change: unknown) => {
    const next = typeof change === 'function' ? (change as (s: typeof state.store) => Partial<typeof state.store>)(state.store) : change
    state.store = { ...state.store, ...(next as object) }
  },
  cardLabelOf: (_s: unknown, n: number) => `#${n}`,
  notify: () => undefined,
  pushToast: () => undefined
}))
vi.mock('../src/renderer/src/api', () => ({
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  call: (channel: string, arg: { lane: string; rev: number }) => {
    if (channel === 'lanes:edit') {
      state.edits.push({ lane: arg.lane, rev: arg.rev })
      // Main: refused unless it names the lane's revision now; made, its revision up by one.
      if (state.main.get(arg.lane) !== arg.rev) return Promise.reject(new Error('changed meanwhile'))
      const rev = arg.rev + 1
      state.main.set(arg.lane, rev)
      return Promise.resolve({ op: 'move', card: 1, lanes: [{ lane: arg.lane, queuedAfter: null, rev }], undo: null })
    }
    // lanes:list: the lanes as main has them when asked, answered when the test says.
    const snapshot = [...state.main].map(([id, listRev]) => ({ id, listRev }))
    return new Promise((resolve) => state.reads.push({ snapshot, answer: () => resolve(snapshot) }))
  }
}))

// Through a variable, as the other window modules' tests import them: the node typecheck can't follow the window's aliases.
const laneEditsModule = '../src/renderer/src/laneEdits'
type Outcome = 'made' | 'skipped' | { refused: string }
const { editLaneInTurn } = (await import(/* @vite-ignore */ laneEditsModule)) as {
  editLaneInTurn: (shown: Record<string, number>, make: (rev: (lane: string) => number) => { edit: unknown; names: { lane: string } } | null) => Promise<Outcome>
}
const settle = () => new Promise((r) => setTimeout(r, 0))
const move = (lane: string, shown: number) => editLaneInTurn({ [lane]: shown }, (rev) => ({ edit: { op: 'move', lane, rev: rev(lane), card: 1, to: 0 }, names: { lane } }))

describe("quick edits of two lanes, in turn (HI-2932, HR1's round 1)", () => {
  it("a lane's edit waits for the last edit's read of the lanes, so an older read never lands last; every edit is made", async () => {
    state.main = new Map([['A', 0], ['B', 0]])
    state.store.lanes = [{ id: 'A', listRev: 0 }, { id: 'B', listRev: 0 }]
    // A's edit, then B's, then B's again, all asked before any answer (each on the revisions shown then: 0).
    const a = move('A', 0)
    const b = move('B', 0)
    const b2 = move('B', 0)
    await settle()
    // A's edit made; its read of the lanes (A1, B0) waits. B's edit isn't asked yet.
    expect(state.edits).toEqual([{ lane: 'A', rev: 0 }])
    expect(state.reads).toHaveLength(1)
    state.reads[0].answer()
    await settle()
    // Then B's, on B0, and its read (A1, B1); then B's second, on what B's first left.
    expect(state.edits).toEqual([{ lane: 'A', rev: 0 }, { lane: 'B', rev: 0 }])
    state.reads[1].answer()
    await settle()
    expect(state.edits).toEqual([{ lane: 'A', rev: 0 }, { lane: 'B', rev: 0 }, { lane: 'B', rev: 1 }])
    state.reads[2].answer()
    expect(await Promise.all([a, b, b2])).toEqual(['made', 'made', 'made'])
    expect(state.store.lanes).toEqual([{ id: 'A', listRev: 1 }, { id: 'B', listRev: 2 }])
  })

  it("someone else's change between is still refused: the revision shown is named", async () => {
    state.main = new Map([['A', 5]])
    state.store.lanes = [{ id: 'A', listRev: 4 }]
    state.edits = []
    state.reads = []
    // Shown at 4 while main is at 5 (another window moved it): refused, as before.
    expect(await move('A', 4)).toEqual({ refused: 'changed meanwhile' })
    expect(state.edits).toEqual([{ lane: 'A', rev: 4 }])
  })
})
