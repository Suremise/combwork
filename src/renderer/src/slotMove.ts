// HI-3592: a free slot left on another branch than Work merges into (lent, changed or holding commits when that moved on),
// moved on from its row: Version Control's Worktrees and Slots and copies. The same checks and move as Save…'s Also
// retarget what can move (workflow/retarget.ts): asked first, then rechecked as it is made.

import type { RetargetResult } from '@shared/types'
import { msg, tr } from '@shared/i18n'
import { call } from './api'
import { attempt } from './actions'
import { confirm, notify } from './store'
import { RT, retargetSkippedText } from './retargetText'

const M = {
  button: msg({ id: 'slots.move.button', defaultMessage: 'Move to {to}…', description: "HI-3592: a button on a free slot's row (Version Control → Worktrees, Slots and copies): the slot still follows an older branch, and this moves it to the project's Work merges into, {to} (a branch name, such as 1.8.0). Asks first." }),
  buttonTip: msg({ id: 'slots.move.buttonTip', defaultMessage: '{slot} is free and still follows {from}: move it to {to}, the branch work merges into now', description: "HI-3592: the tooltip of a free slot's Move to… button. {slot} is its name (slot-e), {from} the older branch it follows, {to} the project's Work merges into." }),
  readFailed: msg({ id: 'slots.move.readFailed', defaultMessage: "Could not check the slot's move", description: "HI-3592: an error's title: Combwork couldn't check whether a slot can move to Work merges into." }),
  title: msg({ id: 'slots.move.title', defaultMessage: 'Move {slot} to {to}?', description: "HI-3592: the question before moving a free slot ({slot}, such as slot-e) to the project's Work merges into ({to}, a branch name)." }),
  message: msg({ id: 'slots.move.message', defaultMessage: '{slot} is free and still follows {from}. Its folder is detached at {to}, and its next card or lane starts there. Nothing in it is lost: it has no changes, and every commit it holds is in {from}.', description: "HI-3592: the question before moving a free slot ({slot}) from the older branch it follows ({from}) to Work merges into ({to}): what happens. Detached: git's word (its folder at that branch's commit, on no branch)." }),
  detail: msg({ id: 'slots.move.detail', defaultMessage: 'Checked again as it moves: if it was lent or changed meanwhile, it stays where it is.', description: 'HI-3592: under the question before moving a free slot to Work merges into.' }),
  confirm: msg({ id: 'slots.move.confirm', defaultMessage: 'Move', description: 'HI-3592: the button that moves the free slot to Work merges into.' }),
  cant: msg({ id: 'slots.move.cant', defaultMessage: '{slot} can’t move to {to} now', description: "HI-3592: a notification's title: the free slot ({slot}) can't move to Work merges into ({to}); its text says why." }),
  onTarget: msg({ id: 'slots.move.onTarget', defaultMessage: '{slot} follows {to} already.', description: 'HI-3592: why a slot ({slot}) needs no move: it follows Work merges into ({to}) already.' }),
  failed: msg({ id: 'slots.move.failed', defaultMessage: 'Could not move the slot', description: "HI-3592: an error's title: moving a free slot to Work merges into failed." }),
  moved: msg({ id: 'slots.move.moved', defaultMessage: '{slot} follows {to} now', description: 'HI-3592: a notification after a free slot ({slot}) moved to Work merges into ({to}).' }),
  kept: msg({ id: 'slots.move.kept', defaultMessage: '{slot} stayed on {from}', description: "HI-3592: a notification's title: the slot ({slot}) was checked again as it moved and stayed on its branch ({from}); its text says why." })
}

/** HI-3592: the row's button text and tooltip for a slot its view offers to move on (`SlotView.moveOn`). */
export const slotMoveText = (slot: string, on: { from: string; to: string }): { label: string; tip: string } => ({ label: tr(M.button, { to: on.to }), tip: tr(M.buttonTip, { slot, from: on.from, to: on.to }) })

/** HI-3592: Move to…: checks the slot's move, asks, makes it, and says what came of it; `after` once anything was tried. */
export async function moveSlotOn(path: string, slot: string, after?: () => void): Promise<void> {
  const p = await attempt(tr(M.readFailed), () => call('slots:movePreview', path, slot))
  if (!p) return
  if (!p.move) {
    notify('warning', tr(M.cant, { slot, to: p.to }), p.keep === 'onTarget' || !p.keep ? tr(M.onTarget, { slot, to: p.to }) : tr(RT.retargetKeep, { what: slot, why: p.keep, from: p.from, to: p.to }))
    after?.()
    return
  }
  let moved: RetargetResult | null = null
  const ok = await confirm({
    title: tr(M.title, { slot, to: p.to }),
    message: tr(M.message, { slot, from: p.from, to: p.to }),
    detail: tr(M.detail),
    confirmLabel: tr(M.confirm),
    run: async () => {
      moved = await call('slots:move', path, p)
    }
  })
  if (!ok) return
  const r = moved as RetargetResult | null
  if (!r) notify('error', tr(M.failed))
  else if (r.moved.slots.includes(slot)) notify('success', tr(M.moved, { slot, to: r.to }))
  else notify('warning', tr(M.kept, { slot, from: r.from }), retargetSkippedText(r))
  after?.()
}
