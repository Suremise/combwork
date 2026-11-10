import { msg, tr } from '@shared/i18n'
import type { LaneEdit, LaneEditResult, LaneEditUndo } from '@shared/types'
import { call, errorMessage } from './api'
import { cardLabelOf, get, notify, pushToast } from './store'

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

/** Asks main for an edit; null when it was made (and said so, with Undo), else main's reason, in the window's language. */
export async function editLane(e: LaneEdit, names: EditNames): Promise<string | null> {
  let r: LaneEditResult
  try {
    r = await call('lanes:edit', e)
  } catch (err) {
    return errorMessage(err)
  }
  said(r, names)
  return null
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
    pushToast({ id: `lane-edit-${++seq}`, level: 'success', title: tr(M.done, { op: r.op, card: '', lane: '' }), timestamp: new Date().toISOString() })
  } catch (err) {
    notify('error', tr(M.undoFailed), errorMessage(err))
  }
}
