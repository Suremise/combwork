import { useEffect, useState } from 'react'
import { msg, tr } from '@shared/i18n'
import type { TaskCard } from '@shared/types'
import type { WorkBadge } from '@shared/workflow/workView'
import { cardLabel } from '@shared/projectKeys'
import { call, errorMessage } from '../api'
import { loadTasks, notify, prompt, useLanguage, useStore } from '../store'
import { BusyButton, Icon, Tooltip, useBusy } from './ui'
import { reviewSkipTip } from './reviewSkipTip'

// Review: Skip in the window (#1625, SPEC §16.7.3): a card that skips review is finished by its submission (a code card
// goes on to its merge). The user decides it, when the card is made or before it is submitted; a project agent only
// proposes it, and the user (or the Assistant, with the user's reason) confirms it.

const M = {
  skipped: msg({ id: 'board.reviewSkip.skipped', defaultMessage: 'Review skipped', description: "A mark on a card's tile (#1625): the card skips its review; its submission finishes it (a code card still goes on to its merge)." }),
  proposedTip: msg({ id: 'board.reviewSkip.proposedTip', defaultMessage: 'Skip review? Proposed by the agent that made it: open the card to decide.', description: "Tooltip and accessible name of a card's mark when the agent that made it proposed that it skip its review and nobody has answered yet (#1625)." }),
  proposedMark: msg({ id: 'board.reviewSkip.proposedMark', defaultMessage: 'Skip review?', description: "A dashed mark on a card's tile (#1625): the agent that made it proposed that it skip its review, not answered yet." }),
  field: msg({ id: 'board.reviewSkip.field', defaultMessage: 'Review', description: "A field label in the card dialog (#1625): whether the card is reviewed as its project's rules say, or skips its review." }),
  newChoice: msg({ id: 'board.reviewSkip.newChoice', defaultMessage: 'Skip review (its submission finishes it)', description: "A tick box in the New Card dialog (#1625): the card skips its review; submitting it finishes it (a code card still goes on to its merge, with its merge checks)." }),
  note: msg({ id: 'board.reviewSkip.note', defaultMessage: 'Why (optional)', description: "Placeholder of the box beside the New Card dialog's Skip review tick box (#1625): the user's note on why the card skips review." }),
  reviewed: msg({ id: 'board.reviewSkip.reviewed', defaultMessage: 'Reviewed', description: "The card dialog's Review field (#1625): the card is reviewed as its project's rules say." }),
  change: msg({ id: 'board.reviewSkip.change', defaultMessage: '{skip, select, true {Review It} other {Skip Review…}}', description: "A button beside a card's Review field in its dialog (#1625): Skip Review… makes it skip its review (asking why, optional), Review It sets it back to be reviewed. Select keys: whether it skips review now." }),
  askTitle: msg({ id: 'board.reviewSkip.askTitle', defaultMessage: 'Skip the review of {card}?', description: "Title of the question before a card is set to skip its review (#1625). {card} is the card's name." }),
  askMessage: msg({ id: 'board.reviewSkip.askMessage', defaultMessage: 'Submitting it will finish it with no review: a code card goes on to its merge, with its merge checks. The card shows Review skipped, with your note.', description: "The question before a card is set to skip its review (#1625): what that means. Review skipped is the mark's text." }),
  reason: msg({ id: 'board.reviewSkip.reason', defaultMessage: 'Why (optional)', description: "The label of the field in the question before a card is set to skip its review (#1625): the user's note on why." }),
  confirmLabel: msg({ id: 'board.reviewSkip.confirmLabel', defaultMessage: 'Skip Review', description: "The button of the question before a card is set to skip its review (#1625)." }),
  proposal: msg({ id: 'board.reviewSkip.proposal', defaultMessage: 'Skip review? The agent that made this card proposes it: {reason}', description: "A banner in a card's dialog (#1625): the agent that made the card proposed that it skip its review, with its reason ({reason}: the agent's words); the user decides." }),
  confirm: msg({ id: 'board.reviewSkip.confirm', defaultMessage: 'Skip Review', description: "A button on the banner of a card an agent proposed should skip its review (#1625): makes it skip review." }),
  keep: msg({ id: 'board.reviewSkip.keep', defaultMessage: 'Keep Review', description: "A button on the banner of a card an agent proposed should skip its review (#1625): keeps its review." }),
  working: msg({ id: 'board.reviewSkip.working', defaultMessage: 'Saving…', description: "A button while whether the card skips review is being saved (#1625)." }),
  failed: msg({ id: 'board.reviewSkip.failed', defaultMessage: "Whether the card skips review wasn't changed", description: "An error toast's title (#1625): setting whether a card skips its review failed. Its text says why." })
}

/**
 * Whether a project's rules review its cards (its stages have Review), read from main; null while unknown or none.
 * Read again whenever `opened` changes (HI-2851: the card dialog stays mounted, so each opening counts) and on each
 * `workflow-changed`, as the project's rules gain or lose Review meanwhile; the last answer stays while the same
 * project's is re-read.
 */
export function useProjectReviews(projectPath: string | null, opened: number): boolean | null {
  const [read, setRead] = useState<{ path: string; reviews: boolean | null } | null>(null)
  const version = useStore((s) => s.workflowVersion)
  useEffect(() => {
    let live = true
    if (!projectPath) return
    call('workflow:stages', projectPath)
      .then((p) => live && setRead({ path: projectPath, reviews: !!p?.stages.some((s) => s.id === 'review') }))
      .catch(() => live && setRead({ path: projectPath, reviews: null }))
    return () => {
      live = false
    }
  }, [projectPath, opened, version])
  return read && read.path === projectPath ? read.reviews : null
}

/** The Review skipped mark on a card's tile, or Skip review? for an agent's proposal not answered yet. */
export function ReviewSkipMark({ b }: { b: WorkBadge | undefined }) {
  useLanguage()
  if (!b || (!b.reviewSkip && b.reviewSkipProposed === null)) return null
  const proposed = !b.reviewSkip
  const text = proposed ? tr(M.proposedTip) : reviewSkipTip(b.reviewSkip!, tr)
  return (
    <Tooltip content={text}>
      <span className={proposed ? 'task-kind review-skip proposed' : 'task-kind review-skip'} aria-label={text} data-review-skip={proposed ? 'proposed' : 'skipped'}>
        <Icon name="debug-step-over" /> {tr(proposed ? M.proposedMark : M.skipped)}
      </span>
    </Tooltip>
  )
}

/** Sets whether a card skips review (`tasks:setReviewSkip`), then reloads the board; a failure is a toast. */
async function saveSkip(n: number, skip: boolean, reason: string | undefined, run: (id: string, fn: () => Promise<void>) => Promise<unknown>, id: string): Promise<void> {
  let failed: string | null = null
  await run(id, async () => {
    try {
      await call('tasks:setReviewSkip', n, skip, reason?.trim() ? { reason: reason.trim() } : {})
    } catch (e) {
      failed = errorMessage(e)
    }
  })
  if (failed !== null) notify('error', tr(M.failed), failed)
  await loadTasks()
}

/** An agent's proposal that the card skip review (#1625): the banner in its dialog, Skip Review or Keep Review. */
export function ReviewSkipProposal({ card, b, readOnly }: { card: TaskCard; b: WorkBadge | undefined; readOnly: boolean }) {
  const action = useBusy()
  useLanguage()
  if (!b || b.reviewSkipProposed === null || b.reviewSkip) return null
  return (
    <div className="banner info kind-proposal" data-section="review-skip-proposal">
      <Icon name="debug-step-over" /> <span>{tr(M.proposal, { reason: b.reviewSkipProposed })}</span>
      {!readOnly && (
        <span className="kind-proposal-actions">
          <BusyButton className="primary" busy={action.busy === 'confirm'} busyLabel={tr(M.working)} disabled={!!action.busy} onClick={() => void saveSkip(card.number, true, undefined, action.run, 'confirm')}>
            {tr(M.confirm)}
          </BusyButton>
          <BusyButton busy={action.busy === 'keep'} busyLabel={tr(M.working)} disabled={!!action.busy} onClick={() => void saveSkip(card.number, false, undefined, action.run, 'keep')}>
            {tr(M.keep)}
          </BusyButton>
        </span>
      )}
    </div>
  )
}

/**
 * The card dialog's Review (#1625), where the card's project reviews (or it skips review already): for a new card, the
 * Skip review choice and an optional note; for a card made, whether it skips review and the button that changes it, until
 * it is submitted.
 */
export function ReviewSkipField(props: { card: TaskCard | null; b: WorkBadge | undefined; reviews: boolean | null; skip: boolean; setSkip: (v: boolean) => void; note: string; setNote: (v: string) => void; readOnly: boolean }) {
  const { card, b, reviews, skip, setSkip, note, setNote, readOnly } = props
  const action = useBusy()
  useLanguage()
  if (!card) {
    if (!reviews) return null
    return (
      <>
        <label>{tr(M.field)}</label>
        <span className="flex review-skip-new">
          <label className="flex dialog-check">
            <input type="checkbox" checked={skip} disabled={readOnly} onChange={(e) => setSkip(e.target.checked)} /> {tr(M.newChoice)}
          </label>
          {skip && <input className="input" aria-label={tr(M.note)} placeholder={tr(M.note)} value={note} maxLength={1000} readOnly={readOnly} onChange={(e) => setNote(e.target.value)} />}
        </span>
      </>
    )
  }
  const skipped = !!b?.reviewSkip
  if (!reviews && !skipped) return null
  // Decided before it is submitted: in Review or past it, the field only says how it stands.
  const open = !b || b.stage === 'hold' || b.stage === 'todo' || b.stage === 'active'
  const change = async (): Promise<void> => {
    if (skipped) return saveSkip(card.number, false, undefined, action.run, 'skip')
    const reason = await prompt({ title: tr(M.askTitle, { card: cardLabel(card) }), message: tr(M.askMessage), fieldLabel: tr(M.reason), confirmLabel: tr(M.confirmLabel) })
    if (reason === null) return
    return saveSkip(card.number, true, reason, action.run, 'skip')
  }
  return (
    <>
      <label>{tr(M.field)}</label>
      <span className="flex kind-field" data-review-skip={skipped ? 'skipped' : 'reviewed'}>
        {skipped ? <ReviewSkipMark b={b} /> : tr(M.reviewed)}
        {open && !readOnly && !card.archived && (
          <BusyButton className="subtle" busy={action.busy === 'skip'} busyLabel={tr(M.working)} disabled={!!action.busy} onClick={() => void change()}>
            {tr(M.change, { skip: String(skipped) })}
          </BusyButton>
        )}
      </span>
    </>
  )
}
