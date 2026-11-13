// Progress → Lanes' quick edits in the window (HI-2932) when one of the window's own changes between is an Undo (HI-3064,
// from hunt 7's probe): the undo's revision counts as the window's own, as an edit's does, so the next quick edit isn't
// refused as changed meanwhile; someone else's change after it still is. Main is stood in for as in
// tests/laneEditsInTurn.test.ts: an edit or undo is refused unless it names the lane's revision now.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  store: { workspace: { path: 'W' }, lanes: [] as { id: string; listRev: number }[] },
  main: new Map<string, number>(),
  edits: [] as { op: string; lane: string; rev: number }[],
  toasts: [] as { level: string; title: string; message?: string }[]
}))

vi.mock('../src/renderer/src/store', () => ({
  get: () => state.store,
  set: (change: unknown) => {
    const next = typeof change === 'function' ? (change as (s: typeof state.store) => Partial<typeof state.store>)(state.store) : change
    state.store = { ...state.store, ...(next as object) }
  },
  cardLabelOf: (_s: unknown, n: number) => `#${n}`,
  notify: (level: string, title: string, message?: string) => void state.toasts.push({ level, title, ...(message ? { message } : {}) }),
  pushToast: (t: { level: string; title: string }) => void state.toasts.push({ level: t.level, title: t.title })
}))
vi.mock('../src/renderer/src/api', () => ({
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  call: (channel: string, arg: { op: string; lane: string; rev: number; undo?: { lanes: { before: { lane: string }; rev: number }[] } }) => {
    if (channel === 'lanes:edit') {
      const lane = arg.op === 'undo' ? arg.undo!.lanes[0].before.lane : arg.lane
      const named = arg.op === 'undo' ? arg.undo!.lanes[0].rev : arg.rev
      state.edits.push({ op: arg.op, lane, rev: named })
      if (state.main.get(lane) !== named) return Promise.reject(new Error('changed meanwhile'))
      const rev = named + 1
      state.main.set(lane, rev)
      return Promise.resolve({ op: arg.op, card: 1, lanes: [{ lane, queuedAfter: null, rev }], undo: arg.op === 'undo' ? null : { lanes: [{ before: { lane, cards: [1, 2], pending: null }, rev }], card: null, back: [] } })
    }
    return Promise.resolve([...state.main].map(([id, listRev]) => ({ id, listRev })))
  }
}))

// Through a variable, as the other window modules' tests import them: the node typecheck can't follow the window's aliases.
const laneEditsModule = '../src/renderer/src/laneEdits'
type Outcome = 'made' | 'skipped' | { refused: string }
const { editLaneInTurn, undoLaneEdit } = (await import(/* @vite-ignore */ laneEditsModule)) as {
  editLaneInTurn: (shown: Record<string, number>, make: (rev: (lane: string) => number) => { edit: unknown; names: { lane: string } } | null) => Promise<Outcome>
  undoLaneEdit: (id?: string, workspace?: string) => Promise<void>
}
const move = (lane: string, shown: number) => editLaneInTurn({ [lane]: shown }, (rev) => ({ edit: { op: 'move', lane, rev: rev(lane), card: 1, to: 0 }, names: { lane } }))

describe('a quick edit asked while the window’s own Undo is on its way (HI-3064)', () => {
  beforeEach(() => {
    state.edits.length = 0
    state.toasts.length = 0
  })

  it('Alt+Down, Ctrl+Z, Alt+Down: the undo is the window’s own, so the third is made', async () => {
    state.main = new Map([['A', 0]])
    state.store.lanes = [{ id: 'A', listRev: 0 }]
    expect(await move('A', 0)).toBe('made')
    expect(state.store.lanes[0].listRev).toBe(1)
    // Ctrl+Z, and before its answer shows, another move on the lane as shown (revision 1).
    const undone = undoLaneEdit()
    const again = move('A', 1)
    await undone
    expect(await again).toBe('made')
    expect(state.edits.map((e) => `${e.op}@${e.rev}`)).toEqual(['move@0', 'undo@1', 'move@2'])
    expect(state.toasts.filter((t) => t.level === 'error')).toEqual([])
  })

  it('someone else’s change after the undo is still refused: the revision shown is named', async () => {
    state.main = new Map([['B', 0]])
    state.store.lanes = [{ id: 'B', listRev: 0 }]
    expect(await move('B', 0)).toBe('made')
    await undoLaneEdit()
    // Another window or an agent changes the lane after the undo (revision 2 → 3); the user acts on revision 2 as shown.
    state.main.set('B', 3)
    expect(await move('B', 2)).toEqual({ refused: 'changed meanwhile' })
  })
})
