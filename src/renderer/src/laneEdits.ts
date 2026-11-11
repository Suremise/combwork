import { msg, tr } from '@shared/i18n'
import { ownRunAfter, revisionToName, type OwnRun } from '@shared/laneQueueEdit'
import type { LaneEdit, LaneEditResult, LaneEditUndo } from '@shared/types'
import { call, errorMessage } from './api'
import { cardLabelOf, get, notify, pushToast, set } from './store'

/**
 * The window's edits of a running lane's list (HI-2898, Progress → Lanes): each asked of main (`lanes:edit`), which
 * applies or queues it as `cw_lane start` does, or refuses it with why. A change it made says so in a notification with
 * Undo; Ctrl+Z in the Lanes tab undoes the last one made in this window, while nothing has changed the lanes since.
 */

/** A board card dragged out of the Tasks view (Board.tsx sets it): its number, for a lane to take it. */
export const CARD_DRAG = 'application/x-combwork-card'

/** The last change made here that can be undone, with its workspace (an Undo pressed in another is refused). */
let last: { id: string; undo: LaneEditUndo; workspace: string } | null = null
let seq = 0

const M = {
  done: msg({ id: 'board.laneEdit.done', defaultMessage: '{op, select, move {Moved {card} in {lane}} add {Added {card} to {lane}} remove {Took {card} off {lane}} transfer {Moved {card} to {lane}} cancel {Cancelled the queued change of {lane}} other {Undone}}', description: "HI-2898: a notification's title after the user changed a lane's cards in Progress → Lanes (a lane: a builder and a reviewer agent working through cards in turn): moved a card ({card}, its key) within it, added one, took one off (it goes back to the board), moved one here from another lane (transfer), cancelled its queued change, or undid the last change (other). {lane} is the lane's builder / reviewer (B1 / R1). Keep the select keys. It has an Undo button." }),
  queued: msg({ id: 'board.laneEdit.queued', defaultMessage: 'It applies once {card} is Done.', description: "HI-2898: under the title of the notification after changing a lane's cards in Progress → Lanes, when the change waits for the lane's card in progress ({card}, its key) to be Done first." }),
  undo: msg({ id: 'board.laneEdit.undo', defaultMessage: 'Undo', description: "HI-2898: the button on the notification after changing a lane's cards (Progress → Lanes): undoes that change." }),
  undoFailed: msg({ id: 'board.laneEdit.undoFailed', defaultMessage: 'Couldn’t undo the change of the lane', description: "HI-2898: a notification's title: undoing a change of a lane's cards (Progress → Lanes) was refused; the reason follows (the lane changed since, say)." }),
  nothing: msg({ id: 'board.laneEdit.nothingToUndo', defaultMessage: 'Nothing to undo in the lanes', description: "HI-2898: said (a notification) when the user presses Ctrl+Z in Progress → Lanes with no change of a lane's cards made in this window to undo." }),
  otherWorkspace: msg({ id: 'board.laneEdit.otherWorkspace', defaultMessage: 'That change was made in another workspace: open it there to undo it.', description: "HI-2898: an error, the Undo of a change of a lane's cards was pressed after this window switched to another workspace." })
}

/** A lane as the notifications name it: its builder / reviewer. */
export interface EditNames {
  lane: string
  /** The lane the card goes to, for a move from another lane (Move here). */
  to?: string
}

/**
 * Asks main for an edit; null when it was made (and said so, with Undo), else main's reason, in the window's language.
 * The Lanes tab asks through editLaneInTurn, so an edit names the revision the last one left.
 */
async function editLane(e: LaneEdit, names: EditNames): Promise<LaneEditResult | string> {
  let r: LaneEditResult
  try {
    r = await call('lanes:edit', e)
  } catch (err) {
    return errorMessage(err)
  }
  said(r, names)
  await reload()
  return r
}

/** How an edit asked in turn ended: made, refused (main's reason), or not asked (nothing to do by the time its turn came). */
export type EditOutcome = 'made' | 'skipped' | { refused: string }

/** Each lane's last edit asked here, in turn (HI-2932): the next one for that lane waits for it. */
const turns = new Map<string, Promise<unknown>>()
/** Each lane's revisions this window's own edits went through, nothing else between (ownRunAfter). */
const own = new Map<string, OwnRun>()

/**
 * An edit of these lanes' lists in turn (HI-2932): asked once the last one asked here for any of them has been answered
 * and the lanes read again, and only then made, from the lanes as they are now (`make`: a card's place). `shown`: each
 * lane's revision as the user saw it when they asked; `rev(lane)` the one to name (revisionToName): the lane's now when
 * only this window's own edits came between, so two quick moves are two moves, else the one shown, which main refuses
 * as changed meanwhile. `make` returns null when there is nothing left to do (the lane ended, the card is at the end).
 */
export function editLaneInTurn(shown: Readonly<Record<string, number>>, make: (rev: (lane: string) => number) => { edit: LaneEdit; names: EditNames } | null): Promise<EditOutcome> {
  const lanes = Object.keys(shown)
  const before = Promise.all(lanes.map((id) => turns.get(id)))
  const mine = before.then(async (): Promise<EditOutcome> => {
    const sent = new Map<string, number>()
    const rev = (lane: string): number => {
      const current = get().lanes.find((x) => x.id === lane)?.listRev ?? 0
      const r = revisionToName(shown[lane] ?? current, current, own.get(lane))
      sent.set(lane, r)
      return r
    }
    const asked = make(rev)
    if (!asked) return 'skipped'
    const r = await editLane(asked.edit, asked.names)
    if (typeof r === 'string') return { refused: r }
    for (const s of r.lanes) {
      const from = sent.get(s.lane)
      if (from !== undefined) own.set(s.lane, ownRunAfter(own.get(s.lane), from, s.rev))
    }
    return 'made'
  })
  const done = mine.then(
    () => undefined,
    () => undefined
  )
  for (const id of lanes) turns.set(id, done)
  void done.then(() => {
    for (const id of lanes) if (turns.get(id) === done) turns.delete(id)
  })
  return mine
}

/**
 * The lanes read again at once after a change made here: the next edit names the revision its lane has now, not the
 * one the settled lanes-changed event (300 ms later) would bring. Set directly, never batched (setLoaded can wait up to
 * a live batch's 250 ms, HI-2932): the next edit in turn is made from the store as soon as this returns. A direct set
 * shows what waits first, so an older answer never replaces this one.
 */
async function reload(): Promise<void> {
  await call('lanes:list').then((lanes) => set({ lanes }), () => undefined)
}

/** The notification of a change made, with its Undo (kept as the last change made here). */
function said(r: LaneEditResult, names: EditNames): void {
  const workspace = get().workspace?.path ?? ''
  const card = r.card !== null ? cardLabelOf(get(), r.card) : ''
  const lane = r.op === 'transfer' ? (names.to ?? names.lane) : names.lane
  const after = r.lanes.find((x) => x.queuedAfter !== null)?.queuedAfter ?? null
  const id = `lane-edit-${++seq}`
  last = r.undo ? { id, undo: r.undo, workspace } : null
  pushToast({
    id,
    level: 'success',
    title: tr(M.done, { op: r.op, card, lane }),
    ...(after !== null ? { message: tr(M.queued, { card: cardLabelOf(get(), after) }) } : {}),
    ...(r.undo ? { actions: [{ label: tr(M.undo), command: 'lanes.undoEdit', args: [id, workspace] }] } : {}),
    timestamp: new Date().toISOString(),
    timeoutMs: 10_000
  })
}

/**
 * Undoes the last change made here (`id`: the notification's, which only undoes its own while it is the last; none: the
 * last, Ctrl+Z). Main refuses it, nothing undone, once a lane or the card changed since.
 */
export async function undoLaneEdit(id?: string, workspace?: string): Promise<void> {
  const l = last
  if (!l || (id !== undefined && l.id !== id)) {
    if (id === undefined) notify('info', tr(M.nothing))
    else notify('error', tr(M.undoFailed), tr(msg({ id: 'board.laneEdit.notLast', defaultMessage: 'Only the last change of the lanes made here can be undone.', description: "HI-2898: why an Undo on an older notification of a change of a lane's cards (Progress → Lanes) does nothing: only the latest change can be undone." })))
    return
  }
  const here = get().workspace?.path ?? ''
  if ((workspace ?? l.workspace).toLowerCase() !== here.toLowerCase() || l.workspace.toLowerCase() !== here.toLowerCase()) return notify('error', tr(M.undoFailed), tr(M.otherWorkspace))
  last = null
  try {
    const r = await call('lanes:edit', { op: 'undo', undo: l.undo })
    await reload()
    pushToast({ id: `lane-edit-${++seq}`, level: 'success', title: tr(M.done, { op: r.op, card: '', lane: '' }), timestamp: new Date().toISOString() })
  } catch (err) {
    notify('error', tr(M.undoFailed), errorMessage(err))
  }
}
