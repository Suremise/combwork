// HI-2680, HI-3592: a retarget's reasons, said where one is shown: Save…'s list and notification (Workflow options), Start
// the next version, and a slot's own Move to… (Version Control's Worktrees, Slots and copies).

import type { RetargetResult } from '@shared/types'
import { msg, tr } from '@shared/i18n'

export const RT = {
  retargetKeep: msg({ id: 'workflow.form.retargetKeep', defaultMessage: '{what}: {why, select, work {it has work on its branch} started {already started} lane {a running lane keeps its branch until it ends} queued {it is in the merge queue} notInTarget {it has commits {to} doesn’t have} reviewed {its reviewed work would bring other commits} noLine {it works in the project folder} line {its branch was made from {from}, so it keeps merging there} lent {lent} dirty {it has changes not committed} busy {in use} unmerged {it holds commits {from} lacks} targetChanged {the target changed meanwhile} refused {not allowed now} changed {it changed meanwhile} moved {it moved meanwhile} gone {its folder is gone} setAside {set aside: look at its folder} other {Combwork can’t tell}}', description: 'HI-2680, HI-2753: a card, slot or lane the retarget leaves where it is, and why (a select: keep the keys). {what} is its name; {from} the old branch, {to} the new one. queued: in the merge queue; notInTarget: a started card with commits the new branch lacks; reviewed: a reviewed card whose change would differ on the new branch; noLine: it has no branch of its own; line (HI-3112): a card put back whose branch, made from the old branch {from}, still holds history the new one lacks, so it keeps merging into {from};' }),
  retargetSkipped: msg({ id: 'workflow.form.retargetSkipped', defaultMessage: '{what}: {why, select, targetChanged {the target changed meanwhile} refused {not allowed now} changed {it changed meanwhile} busy {in use} dirty {it has changes not committed} moved {it moved meanwhile} unmerged {it holds commits the old branch lacks} gone {its folder is gone} setAside {set aside until you remove it: look at its folder first} failed {it couldn’t be moved; Combwork looks at it again} other {Combwork can’t tell}}', description: 'HI-2680: a line of the notification after the retarget: a card or slot left where it was ({what}: its key or name), and why (a select: keep the keys).' })
}

/** HI-2680: what a retarget left where it was, a line each (the toast's text). */
export function retargetSkippedText(r: RetargetResult): string {
  return r.skipped.map((s) => tr(RT.retargetSkipped, { what: s.key ?? s.slot ?? s.lane ?? '', why: s.why })).join('\n')
}
