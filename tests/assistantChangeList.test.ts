// The Assistant panel's list of its changes (#1283, SPEC §16.14): by the user's message, newest first; the actions that
// aren't changes (refusals, failures, undos) listed with their message, those that changed something only by their
// changes; the line a change is said with; and the reasons a change can't be undone read back as codes the window words.
import { describe, expect, it } from 'vitest'
import { finalWhys, UNDO_FINAL, type UndoFinalWhy } from '../src/shared/assistantActivity'
import { ACTIONS_KEPT, lineOf, messageGroups, undoable, withAction, withSnapshot } from '../src/shared/assistantChangeList'
import type { AssistantAction, AssistantChangeGroup, AssistantChangeRow } from '../src/shared/types'

const change = (id: string, at: string, over: Partial<AssistantChangeRow> = {}): AssistantChangeRow => ({ id, group: 'g1', at, kind: 'card', act: 'update-task', what: 'change #1 on the board', card: 1, fields: ['labels'], ...over })
const action = (id: string, at: string, group: string, over: Partial<AssistantAction> = {}): AssistantAction => ({ id, at, text: id, ok: true, kind: 'update-task', group, groupAt: group === 'g1' ? '2026-10-21T08:00:00.000Z' : '2026-10-21T09:00:00.000Z', ...over })

describe("the Assistant's changes in its panel (#1283)", () => {
  it('by message, newest first; refusals, failures and undos listed with their message, changes by their changes', () => {
    const changes: AssistantChangeGroup[] = [{ id: 'g1', at: '2026-10-21T08:00:00.000Z', changes: [change('c2', '2026-10-21T08:00:02.000Z'), change('c1', '2026-10-21T08:00:01.000Z')] }]
    const actions: AssistantAction[] = [
      action('made c1', '2026-10-21T08:00:01.010Z', 'g1'),
      action('refused', '2026-10-21T08:00:03.000Z', 'g1', { ok: false, error: 'Not allowed' }),
      // A later message with only an undo and a refusal: listed on its own, though nothing of it is kept for undo.
      action('undid', '2026-10-21T09:00:01.000Z', 'g2', { kind: 'undo' }),
      action('failed', '2026-10-21T09:00:02.000Z', 'g2', { ok: false }),
      // A message whose changes aren't loaded (yet): its done actions alone aren't a message of the list.
      action('elsewhere', '2026-10-21T10:00:00.000Z', 'g3'),
      // Before actions had a message: never listed.
      { id: 'old', at: '2026-10-21T07:00:00.000Z', text: 'old', ok: false, kind: 'update-task' }
    ]
    const groups = messageGroups(changes, actions)
    expect(groups.map((g) => g.id)).toEqual(['g2', 'g1'])
    expect(groups[0]).toMatchObject({ at: '2026-10-21T09:00:00.000Z', changes: [], lines: [] })
    expect(groups[0].actions.map((a) => a.id)).toEqual(['undid', 'failed'])
    expect(groups[1].changes.map((c) => c.id)).toEqual(['c2', 'c1'])
    expect(groups[1].actions.map((a) => a.id)).toEqual(['refused'])
    expect(groups[1].lines.map((a) => a.id)).toEqual(['made c1'])
  })

  it("a change's line: the action of its kind in its message recorded nearest it (a setting's is recorded just before)", () => {
    const s1 = change('s1', '2026-10-21T08:00:01.005Z', { kind: 'setting', act: 'setting', card: undefined, fields: ['value'] })
    const s2 = change('s2', '2026-10-21T08:00:05.005Z', { kind: 'setting', act: 'setting', card: undefined, fields: ['value'] })
    const [g] = messageGroups([{ id: 'g1', at: '2026-10-21T08:00:00.000Z', changes: [s2, s1] }], [
      action('Changed it: 20 → 50', '2026-10-21T08:00:01.000Z', 'g1', { kind: 'setting' }),
      action('Changed it: 50 → 60', '2026-10-21T08:00:05.000Z', 'g1', { kind: 'setting' }),
      action('Commented on #1', '2026-10-21T08:00:01.004Z', 'g1', { kind: 'comment-task' })
    ])
    expect(lineOf(g, s1)?.text).toBe('Changed it: 20 → 50')
    expect(lineOf(g, s2)?.text).toBe('Changed it: 50 → 60')
    expect(lineOf(g, change('l', '2026-10-21T08:00:01.005Z', { kind: 'lane', act: 'lane-start' }))).toBeUndefined()
  })

  it('undo is offered for a change not undone yet that can be undone', () => {
    expect(undoable(change('a', '2026-10-21T08:00:00.000Z'))).toBe(true)
    expect(undoable(change('b', '2026-10-21T08:00:00.000Z', { undoneAt: '2026-10-21T08:05:00.000Z' }))).toBe(false)
    expect(undoable(change('c', '2026-10-21T08:00:00.000Z', { kind: 'final', final: UNDO_FINAL.prompt }))).toBe(false)
  })

  it("why a change can't be undone, read back from its English as codes, in their order", () => {
    for (const [why, english] of Object.entries(UNDO_FINAL) as [UndoFinalWhy, string][]) expect(finalWhys(english)).toEqual([why])
    // A card's change records its reasons joined, in the order it found them.
    expect(finalWhys([UNDO_FINAL.decision, UNDO_FINAL.comment, UNDO_FINAL.context].join(' '))).toEqual(['decision', 'comment', 'context'])
    expect(finalWhys('Something Hive says another way.')).toEqual([])
  })
})

// The panel's actions (HI-1863): an event's action is shown with the agents' states, a while after it came, so the
// panel's snapshot (assistant:actions) can be loaded between the two. Applied here in the order the window applies them.
describe("the panel's actions, told by events and loaded as a snapshot", () => {
  const act = (id: string, at: string): AssistantAction => ({ id, at, text: id, ok: true })
  const ids = (list: readonly AssistantAction[]) => list.map((a) => a.id)

  it('an action queued, then a snapshot that has it, then the queue shown: once', () => {
    const a = act('a', '2026-10-28T03:00:01Z')
    const queued = (list: AssistantAction[]) => withAction(list, a)
    // The snapshot (main records it before telling the window) is installed first, the queued append after.
    const installed = withSnapshot([], [act('z', '2026-10-28T03:00:00Z'), a])
    expect(ids(queued(installed))).toEqual(['z', 'a'])
    // Nothing to change: the same list, so the store isn't touched.
    expect(queued(installed)).toBe(installed)
  })

  it('told twice: once', () => {
    const a = act('a', '2026-10-28T03:00:01Z')
    expect(ids(withAction(withAction([], a), a))).toEqual(['a'])
  })

  it('a snapshot loaded after newer actions were told keeps them, after its own, in order, none twice', () => {
    const shown = [act('a', '1'), act('b', '2'), act('c', '3')]
    // The snapshot was read before c was told: c is kept after it.
    expect(ids(withSnapshot(shown, [act('a', '1'), act('b', '2')]))).toEqual(['a', 'b', 'c'])
    // A snapshot with nothing new: its own list.
    expect(ids(withSnapshot(shown, [act('a', '1'), act('b', '2'), act('c', '3')]))).toEqual(['a', 'b', 'c'])
    // One older than the snapshot's newest that it doesn't have (cut by its own cap): not brought back out of order.
    expect(ids(withSnapshot([act('old', '0'), act('b', '2')], [act('b', '2')]))).toEqual(['b'])
  })

  it('a new action after a snapshot is added at the end; the list keeps the last ACTIONS_KEPT', () => {
    const snapshot = Array.from({ length: ACTIONS_KEPT }, (_, i) => act(`s${i}`, String(1000 + i)))
    const list = withAction(withSnapshot([], snapshot), act('new', '9999'))
    expect(list).toHaveLength(ACTIONS_KEPT)
    expect(list.at(-1)?.id).toBe('new')
    expect(list[0].id).toBe('s1')
  })
})
