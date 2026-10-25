import { msg, tr } from '@shared/i18n'
import type { TaskCard } from '@shared/types'
import type { CardKind } from '@shared/workflow/facts'
import { RULE_NAMES } from '@shared/workflow/texts'
import type { WorkBadge } from '@shared/workflow/workView'
import { cardLabel } from '@shared/projectKeys'
import { call, errorMessage } from '../api'
import { loadTasks, notify, prompt, useLanguage } from '../store'
import { BusyButton, Icon, Tooltip, useBusy } from './ui'

// A card's kind in the window (#1277, SPEC §16.7.3): code (the default: work in commits) or no code (a decision, a
// write-up, a trial: no commits, submitted with a summary). Set when the card is made; a project agent only proposes no
// code, and the user (or the Assistant) confirms it; changing it later is the user's exception to the rules, asked first.

const M = {
  noCode: msg({ id: 'board.kind.noCode', defaultMessage: 'No code', description: "A card's kind (a mark on its tile, and in its dialog): work with no commits, such as a decision, a write-up or a trial; it is submitted with a summary. Glossary: no-code card." }),
  code: msg({ id: 'board.kind.code', defaultMessage: 'Code', description: "A card's kind in its dialog: work in commits (the default). Glossary: no-code card." }),
  noCodeTip: msg({ id: 'board.kind.noCodeTip', defaultMessage: 'No code: its work is a decision, a write-up or a trial, submitted with a summary and no commits.', description: "Tooltip and accessible name of a card's No code mark (on its tile). Glossary: no-code card." }),
  proposedTip: msg({ id: 'board.kind.proposedTip', defaultMessage: 'No code? Proposed by the agent that made it: open the card to confirm it.', description: "Tooltip and accessible name of a card's mark when an agent proposed it as no code (no commits) and nobody has answered yet. Glossary: no-code card." }),
  field: msg({ id: 'board.kind.field', defaultMessage: 'Kind', description: "A field label in the card dialog: the card's kind, code (work in commits) or no code (a decision, a write-up, a trial). Glossary: no-code card." }),
  newChoice: msg({ id: 'board.kind.newChoice', defaultMessage: 'No code (a decision, a write-up, a trial…)', description: "A tick box in the New Card dialog: the card's work has no commits; it is submitted with a summary. Glossary: no-code card." }),
  change: msg({ id: 'board.kind.change', defaultMessage: '{kind, select, code {Make It No Code…} other {Make It Code…}}', description: "A button beside a card's kind in its dialog: changes it to the other kind, asking first (…): an exception to the card's rules. Select keys: the kind it is now." }),
  askTitle: msg({ id: 'board.kind.askTitle', defaultMessage: '{kind, select, code {Make {card} code?} other {Make {card} no code?}}', description: "Title of the question before a card's kind is changed after it was made. {kind} is the kind it would get (select keys), {card} the card's name." }),
  askMessage: msg({ id: 'board.kind.askMessage', defaultMessage: 'This skips a rule of its project:', description: "The question before a card's kind is changed after it was made: the rule it skips is listed below (its name)." }),
  askDetail: msg({ id: 'board.kind.askDetail', defaultMessage: 'Changing it anyway records an override on the card, with your reason.', description: "Under the rule a kind change skips, in the question before it: the change is recorded on the card as an exception to the rules (glossary: override), with the reason the user gives below." }),
  reason: msg({ id: 'board.kind.reason', defaultMessage: 'Reason (optional)', description: "The label of the field in the question before a card's kind is changed: why the user makes the exception. Optional." }),
  anyway: msg({ id: 'board.kind.anyway', defaultMessage: 'Change Anyway', description: "The button of the question before a card's kind is changed: makes the change, recorded as an override (glossary: override)." }),
  proposal: msg({ id: 'board.kind.proposal', defaultMessage: 'No code? The agent that made this card proposes it: its work has no commits (a decision, a write-up, a trial).', description: "A banner in a card's dialog: the agent that made the card proposed it as no code, and the user is to confirm it or keep it as code. Glossary: no-code card." }),
  confirm: msg({ id: 'board.kind.confirm', defaultMessage: 'Confirm No Code', description: "A button on the banner of a card an agent proposed as no code: makes it no code." }),
  keep: msg({ id: 'board.kind.keep', defaultMessage: 'Keep as Code', description: "A button on the banner of a card an agent proposed as no code: keeps it code (work in commits)." }),
  working: msg({ id: 'board.kind.working', defaultMessage: 'Saving…', description: "A button while the card's kind is being saved." }),
  failed: msg({ id: 'board.kind.failed', defaultMessage: "The card's kind wasn't changed", description: "An error toast's title: changing or confirming a card's kind failed. Its text says why." })
}

/** The No code mark on a card's tile: no code, or no code proposed by an agent (not answered yet). */
export function KindMark({ b }: { b: WorkBadge | undefined }) {
  useLanguage()
  if (!b || (b.kind !== 'no-code' && b.kindProposed !== 'no-code')) return null
  const proposed = b.kind !== 'no-code'
  const text = tr(proposed ? M.proposedTip : M.noCodeTip)
  return (
    <Tooltip content={text}>
      <span className={proposed ? 'task-kind proposed' : 'task-kind'} aria-label={text} data-kind={proposed ? 'proposed' : 'no-code'}>
        <Icon name="note" />
        <span className="task-chip-label">
          {tr(M.noCode)}
          {proposed ? '?' : ''}
        </span>
      </span>
    </Tooltip>
  )
}

/** An agent's proposal of no code (#1277): the banner in the card's dialog, Confirm No Code or Keep as Code. */
export function KindProposal({ card, b, readOnly }: { card: TaskCard; b: WorkBadge | undefined; readOnly: boolean }) {
  const action = useBusy()
  useLanguage()
  if (!b?.kindProposed || b.kind === b.kindProposed) return null
  const answer = async (accept: boolean): Promise<void> => {
    let failed: string | null = null
    await action.run(accept ? 'confirm' : 'keep', async () => {
      try {
        await call('tasks:confirmKind', card.number, accept)
      } catch (e) {
        failed = errorMessage(e)
      }
    })
    if (failed !== null) notify('error', tr(M.failed), failed)
    await loadTasks()
  }
  return (
    <div className="banner info kind-proposal" data-section="kind-proposal">
      <Icon name="note" /> <span>{tr(M.proposal)}</span>
      {!readOnly && (
        <span className="kind-proposal-actions">
          <BusyButton className="primary" busy={action.busy === 'confirm'} busyLabel={tr(M.working)} disabled={!!action.busy} onClick={() => void answer(true)}>
            {tr(M.confirm)}
          </BusyButton>
          <BusyButton busy={action.busy === 'keep'} busyLabel={tr(M.working)} disabled={!!action.busy} onClick={() => void answer(false)}>
            {tr(M.keep)}
          </BusyButton>
        </span>
      )}
    </div>
  )
}

/**
 * The card dialog's Kind: for a new card, the No code choice; for a card made, its kind and the button that changes it,
 * asking first (the rule it skips, a reason, Change Anyway: one override).
 */
export function KindField({ card, b, noCode, setNoCode, readOnly }: { card: TaskCard | null; b: WorkBadge | undefined; noCode: boolean; setNoCode: (v: boolean) => void; readOnly: boolean }) {
  const action = useBusy()
  useLanguage()
  if (!card) {
    return (
      <>
        <label>{tr(M.field)}</label>
        <label className="flex dialog-check kind-new">
          <input type="checkbox" checked={noCode} disabled={readOnly} onChange={(e) => setNoCode(e.target.checked)} /> {tr(M.newChoice)}
        </label>
      </>
    )
  }
  const kind: CardKind = b?.kind ?? 'code'
  const to: CardKind = kind === 'code' ? 'no-code' : 'code'
  const change = async (): Promise<void> => {
    let failed: string | null = null
    await action.run('kind', async () => {
      try {
        const r = await call('tasks:setKind', card.number, to)
        if ('ask' in r) {
          const reason = await prompt({ title: tr(M.askTitle, { kind: to, card: cardLabel(card) }), message: tr(M.askMessage), list: [tr(RULE_NAMES['card.kind'])], listOnly: true, detail: tr(M.askDetail), fieldLabel: tr(M.reason), confirmLabel: tr(M.anyway) })
          if (reason === null) return
          await call('tasks:setKind', card.number, to, { confirm: true, ...(reason.trim() ? { reason: reason.trim() } : {}) })
        }
      } catch (e) {
        failed = errorMessage(e)
      }
    })
    if (failed !== null) notify('error', tr(M.failed), failed)
    await loadTasks()
  }
  return (
    <>
      <label>{tr(M.field)}</label>
      <span className="flex kind-field" data-kind={kind}>
        {kind === 'no-code' ? <Icon name="note" /> : <Icon name="git-commit" />} {tr(kind === 'no-code' ? M.noCode : M.code)}
        {!readOnly && !card.archived && (
          <BusyButton className="subtle" busy={action.busy === 'kind'} busyLabel={tr(M.working)} disabled={!!action.busy} onClick={() => void change()}>
            {tr(M.change, { kind })}
          </BusyButton>
        )}
      </span>
    </>
  )
}
