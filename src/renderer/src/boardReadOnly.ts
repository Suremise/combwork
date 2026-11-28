import { msg, tr } from '@shared/i18n'
import type { BoardState } from '@shared/types'

const M = {
  newer: msg({ id: 'board.readOnly.newer', defaultMessage: 'This board was saved by a newer version of Combwork: it is read-only here.', description: "Tooltip on what changes cards (the board's add-card buttons, the card dialog's Save, comments and decisions), disabled while the board was saved by a newer Combwork (whose format this one can't change); also a banner in the card dialog." })
}

/** Why the board takes no changes (its add-card buttons' tooltip), or null when it does: only a board a newer Combwork saved (#1207). */
export function readOnlyReason(readOnly: BoardState['readOnly'] | undefined): string | null {
  return readOnly === 'newer' ? tr(M.newer) : null
}
