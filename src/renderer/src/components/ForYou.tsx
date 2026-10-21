import { useState } from 'react'
import { msg, tr } from '@shared/i18n'
import type { TaskCard } from '@shared/types'
import { LANE_MAX_ROUNDS } from '@shared/lanes'
import { ROUND_LIMIT_GATE, type RoundChoice } from '@shared/workflow/facts'
import { FOR_YOU_KIND, ROUND_CHOICE, workflowLine } from '@shared/workflow/texts'
import type { ForYouAnswer, ForYouItem } from '@shared/workflow/workView'
import { call, errorMessage } from '../api'
import { loadTasks, notify, prompt, useLanguage, useStore } from '../store'
import { cx, timeAgo } from '../util'
import { BusyButton, Icon, Tooltip, useBusy } from './ui'

// For you in the window (#1276, SPEC §16.8.5): a card's requests for the user, as a chip on its tile and a section in
// its dialog where the user answers them (tasks:answer, #1269: only the user answers). Hive's own requests are shown
// through their messages (in the window's language), an agent's question in its own words.

const M = {
  chip: msg({ id: 'board.forYou.chip', defaultMessage: 'For you', description: "A chip on a board card: something on the card waits for the user (an approval, a decision, a question). Glossary: For you." }),
  chipTip: msg({ id: 'board.forYou.chipTip', defaultMessage: '{n, plural, one {Waits for you: {requests}} other {# requests wait for you: {requests}}}', description: "Tooltip and accessible name of a card's For you chip: how many requests wait for the user ({n}) and each one, its kind and what it asks ({requests}, separated by · ). Glossary: For you." }),
  heading: msg({ id: 'board.forYou.heading', defaultMessage: 'For you', description: "A heading in the card dialog, above what on the card waits for the user (approvals, decisions, questions). Glossary: For you." }),
  asked: msg({ id: 'board.forYou.asked', defaultMessage: '{who, select, hive {Hive asks} other {{who} asks}} · {when}', description: "Under a request for the user in the card dialog: who asks (Hive, or an agent: its name {who}) and when ({when}: \"5 min ago\"). Keep the select keys as they are." }),
  approve: msg({ id: 'board.forYou.approve', defaultMessage: 'Approve', description: "A button under a request for the user's approval (For you): approves it. Glossary: approve." }),
  decline: msg({ id: 'board.forYou.decline', defaultMessage: 'Decline…', description: "A button under a request for the user's approval (For you): declines it, asking why first (…). For the user's review, the card goes back to its builder as a round." }),
  declineTitle: msg({ id: 'board.forYou.declineTitle', defaultMessage: 'Decline: {request}', description: 'Title of the question when the user declines a request (For you); {request} is what it asks.' }),
  declineWhy: msg({ id: 'board.forYou.declineWhy', defaultMessage: 'Why? The agent waiting on it reads your reason.', description: 'The question when the user declines a request for their approval: their reason, which the waiting agent is told.' }),
  declineNeeds: msg({ id: 'board.forYou.declineNeeds', defaultMessage: 'Say why, so the agent knows what to change.', description: 'An error in the question when the user declines a request without a reason: one is needed.' }),
  reply: msg({ id: 'board.forYou.reply', defaultMessage: 'Your answer', description: "The label (and placeholder) of the box under a question for the user (For you) in the card dialog: the user's answer, sent to the agent that asked." }),
  send: msg({ id: 'board.forYou.send', defaultMessage: 'Send Reply', description: "A button under a question for the user (For you): sends the answer typed above to the agent that asked." }),
  asDecision: msg({ id: 'board.forYou.asDecision', defaultMessage: 'Record as Decision', description: "A button under a question for the user (For you): records the answer typed above as one of the card's decisions (a new decision, which its agents read), and answers the question with it." }),
  rounds: msg({ id: 'board.forYou.rounds', defaultMessage: 'More rounds', description: "The label of the number box beside Carry on, at a card loop's round limit: how many more review rounds the card gets." }),
  checklist: msg({ id: 'board.forYou.checklist', defaultMessage: 'To try:', description: 'Above the checklist of a Test request (For you): what the user is asked to try.' }),
  answering: msg({ id: 'board.forYou.answering', defaultMessage: 'Answering…', description: "A button while the user's answer to a request is being recorded." }),
  failed: msg({ id: 'board.forYou.failed', defaultMessage: "Your answer wasn't taken", description: "An error toast's title: the user's answer to a request (For you) was refused, perhaps answered or retired meanwhile (a new submission, the card moved on). Its text says why." })
}

/** A request's text in the window: Hive's own by its message (the window's language), an agent's in its own words. */
export const requestText = (i: Pick<ForYouItem, 'shown' | 'text'>): string => (i.shown ? (workflowLine(i.shown, (m, values) => tr(m, values)) ?? i.text) : i.text)

/** A request's kind, as the window names it (Approve, Decide, Test, Sign in, Other). */
const kindText = (i: Pick<ForYouItem, 'kind'>): string => tr(FOR_YOU_KIND, { kind: i.kind })

/** The chip on a card's tile: what waits for the user, by kind; each request in its tooltip and accessible name. */
export function ForYouChip({ items }: { items: ForYouItem[] | undefined }) {
  if (!items?.length) return null
  const text = tr(M.chipTip, { n: items.length, requests: items.map((i) => `${kindText(i)}: ${requestText(i)}`).join(' · ') })
  return (
    <Tooltip content={text}>
      <span className="task-for-you" aria-label={text} data-for-you={items.map((i) => i.kind).join(' ')}>
        <Icon name="bell-dot" /> {tr(M.chip)}: {items.length === 1 ? kindText(items[0]) : items.length}
      </span>
    </Tooltip>
  )
}

/** The card dialog's For you section: each request with its answers. Nothing when nothing waits for the user. */
export function ForYouSection({ card, items }: { card: TaskCard; items: ForYouItem[] | undefined }) {
  useLanguage()
  if (!items?.length) return null
  return (
    <div className="for-you-section" data-section="for-you">
      <div className="task-section-h">
        <Icon name="bell-dot" /> {tr(M.heading)}
      </div>
      {items.map((i) => (
        <ForYouRequest key={i.request} card={card} item={i} />
      ))}
    </div>
  )
}

function ForYouRequest({ card, item }: { card: TaskCard; item: ForYouItem }) {
  const agents = useStore((s) => s.workspace?.projects.find((p) => p.name.toLowerCase() === card.project.toLowerCase())?.agents)
  const [reply, setReply] = useState('')
  const [rounds, setRounds] = useState('1')
  const action = useBusy()
  const text = requestText(item)
  const who = item.asker ? (agents?.find((a) => a.id === item.asker)?.name ?? item.asker) : 'hive'
  const answer = async (name: string, a: ForYouAnswer): Promise<void> => {
    let failed: string | null = null
    await action.run(name, async () => {
      try {
        await call('tasks:answer', card.number, item.request, a)
      } catch (e) {
        failed = errorMessage(e)
      }
    })
    // Refused (answered or retired meanwhile, the card moved on): said, and the board read again.
    if (failed !== null) notify('error', tr(M.failed), failed)
    await loadTasks()
  }
  const decline = async (): Promise<void> => {
    const why = await prompt({ title: tr(M.declineTitle, { request: text }), message: tr(M.declineWhy), validate: (v) => (v.trim() ? null : tr(M.declineNeeds)) })
    if (why !== null) await answer('decline', { outcome: 'declined', reply: why.trim() })
  }
  const busy = (name: string): boolean => action.busy === name
  const limit = item.gate === ROUND_LIMIT_GATE
  const choose = (choice: RoundChoice): Promise<void> => answer(choice, { outcome: 'answered', choice, ...(choice === 'carryOn' ? { rounds: Number(rounds) } : {}) })
  const roundsOk = /^\d+$/.test(rounds) && Number(rounds) >= 1 && Number(rounds) <= LANE_MAX_ROUNDS
  return (
    <div className={cx('for-you-request', item.kind)} data-request={item.request}>
      <div className="for-you-text">
        <span className="for-you-kind">{kindText(item)}</span> {text}
      </div>
      <div className="faint for-you-asked">{tr(M.asked, { who, when: timeAgo(item.since) })}</div>
      {!!item.checklist?.length && (
        <div className="for-you-checklist">
          <div className="faint">{tr(M.checklist)}</div>
          <ul>
            {item.checklist.map((x, k) => (
              <li key={k}>{x}</li>
            ))}
          </ul>
        </div>
      )}
      {limit ? (
        <div className="for-you-actions">
          <label className="flex for-you-rounds">
            {tr(M.rounds)}
            <input className="input" type="number" min={1} max={LANE_MAX_ROUNDS} value={rounds} onChange={(e) => setRounds(e.target.value)} />
          </label>
          <BusyButton className="primary" busy={busy('carryOn')} busyLabel={tr(M.answering)} disabled={!!action.busy || !roundsOk} onClick={() => void choose('carryOn')}>
            {tr(ROUND_CHOICE, { choice: 'carryOn' })}
          </BusyButton>
          {(['split', 'accept', 'takeOver'] as const).map((c) => (
            <BusyButton key={c} busy={busy(c)} busyLabel={tr(M.answering)} disabled={!!action.busy} onClick={() => void choose(c)}>
              {tr(ROUND_CHOICE, { choice: c })}
            </BusyButton>
          ))}
        </div>
      ) : item.kind === 'approve' ? (
        <div className="for-you-actions">
          <BusyButton className="primary" busy={busy('approve')} busyLabel={tr(M.answering)} disabled={!!action.busy} onClick={() => void answer('approve', { outcome: 'approved' })}>
            {tr(M.approve)}
          </BusyButton>
          <BusyButton busy={busy('decline')} busyLabel={tr(M.answering)} disabled={!!action.busy} onClick={() => void decline()}>
            {tr(M.decline)}
          </BusyButton>
        </div>
      ) : (
        <>
          <textarea className="input for-you-reply" rows={2} aria-label={tr(M.reply)} placeholder={tr(M.reply)} value={reply} onChange={(e) => setReply(e.target.value)} />
          <div className="for-you-actions">
            <BusyButton className="primary" busy={busy('reply')} busyLabel={tr(M.answering)} disabled={!!action.busy || !reply.trim()} onClick={() => void answer('reply', { outcome: 'answered', reply: reply.trim() })}>
              {tr(M.send)}
            </BusyButton>
            <BusyButton busy={busy('decision')} busyLabel={tr(M.answering)} disabled={!!action.busy || !reply.trim()} onClick={() => void answer('decision', { outcome: 'answered', decision: reply.trim() })}>
              {tr(M.asDecision)}
            </BusyButton>
          </div>
        </>
      )}
    </div>
  )
}
