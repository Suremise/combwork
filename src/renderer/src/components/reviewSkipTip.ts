import { msg } from '../../../shared/i18n'
import type { Tr } from '../../../shared/tasks'
import type { ReviewSkip } from '../../../shared/workflow/workView'

// The Review skipped mark's words (#1625): who set the skip and why. Whether there is a note is its own select key
// (`who`), never the note itself, so a note that reads "none" or "other" is shown as written (#1636).

const SKIPPED_TIP = msg({ id: 'board.reviewSkip.skippedTip', defaultMessage: '{who, select, assistant {Review skipped, set by the Assistant: {reason}} note {Review skipped, set by you: {reason}} other {Review skipped, set by you.}}', description: "Tooltip and accessible name of a card's Review skipped mark (#1625): who set it and why. Select keys (keep them): assistant, the Hive Assistant set it, with the user's reason ({reason}: their words); note, the user set it with a note ({reason}); other, the user set it with no note." })

/** The Review skipped mark's tooltip and accessible name: who set it, and their note or reason as text. */
export function reviewSkipTip(skip: ReviewSkip, tr: Tr): string {
  const who = skip.by === 'assistant' ? 'assistant' : skip.reason ? 'note' : 'user'
  return tr(SKIPPED_TIP, { who, reason: skip.reason })
}
