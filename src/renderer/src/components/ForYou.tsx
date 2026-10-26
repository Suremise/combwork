import { useLayoutEffect, useRef, useState } from 'react'
import { msg, tr } from '@shared/i18n'
import type { TaskCard } from '@shared/types'
import { LANE_MAX_ROUNDS } from '@shared/lanes'
import { QUEUE_STUCK_GATE, ROUND_LIMIT_GATE, type AskActionKind, type CardKind, type RoundChoice } from '@shared/workflow/facts'
import { FOR_YOU_KIND, ROUND_CHOICE, workflowLine } from '@shared/workflow/texts'
import { gist } from '@shared/gist'
import { askActionAvailable, type ForYouAnswer, type ForYouItem } from '@shared/workflow/workView'
import { call, errorMessage } from '../api'
import { MARKDOWN_CARDS } from '../cardLinks'
import { loadTasks, notify, prompt, useLanguage, useStore } from '../store'
import { cx, timeAgo } from '../util'
import { BusyButton, Icon, Markdown, Tooltip, useBusy } from './ui'
import { SHOW_QUEUE_WORK } from './CardQueue'

// For you in the window (#1276, SPEC §16.8.5): a card's requests for the user, as a chip on its tile and a section in
// its dialog where the user answers them (tasks:answer, #1269: only the user answers). Hive's own requests are shown
// through their messages (in the window's language), an agent's question in its own words.

const M = {
  chip: msg({ id: 'board.forYou.chip', defaultMessage: 'For you', description: "A chip on a board card: something on the card waits for the user (an approval, a decision, a question). Glossary: For you." }),
  chipTip: msg({ id: 'board.forYou.chipTip', defaultMessage: '{n, plural, one {Waits for you: {requests}} other {# requests wait for you: {requests}}}', description: "Accessible name of a card's For you chip: how many requests wait for the user ({n}) and each one, its kind and the start of what it asks ({requests}, separated by · ). Glossary: For you." }),
  tipAsks: msg({ id: 'board.forYou.tipAsks', defaultMessage: '{kind, select, approve {{who} asks for your OK} decide {{who} asks you to decide} test {{who} asks you to test} signIn {{who} asks you to sign in} other {{who} asks you}}', description: "The first line of a request in the tooltip of a card's For you chip: who asks ({who}: an agent's name, or Hive) and what for (the request's kind: approve, decide, test, sign in, or anything else). The start of the request follows on the next line. Keep the select keys as they are. Glossary: For you." }),
  tipMore: msg({ id: 'board.forYou.tipMore', defaultMessage: '{n, plural, one {and # more request} other {and # more requests}}', description: "In the tooltip of a card's For you chip, after the first requests shown: how many more wait for the user ({n})." }),
  tipOpen: msg({ id: 'board.forYou.tipOpen', defaultMessage: 'Click to open the card and answer under For you.', description: "The last line of the tooltip of a card's For you chip: a click opens the card, whose For you section shows each request in full with its answers. Glossary: For you." }),
  heading: msg({ id: 'board.forYou.heading', defaultMessage: 'For you', description: "A heading in the card dialog, above what on the card waits for the user (approvals, decisions, questions). Glossary: For you." }),
  asked: msg({ id: 'board.forYou.asked', defaultMessage: '{who, select, hive {Hive asks} other {{who} asks}} · {when}', description: "Under a request for the user in the card dialog: who asks (Hive, or an agent: its name {who}) and when ({when}: \"5 min ago\"). Keep the select keys as they are." }),
  approve: msg({ id: 'board.forYou.approve', defaultMessage: 'Approve', description: "A button under a request for the user's approval (For you): approves it. Glossary: approve." }),
  decline: msg({ id: 'board.forYou.decline', defaultMessage: 'Decline…', description: "A button under a request for the user's approval (For you): declines it, asking why first (…). For the user's review, the card goes back to its builder as a round." }),
  declineTitle: msg({ id: 'board.forYou.declineTitle', defaultMessage: 'Decline: {request}', description: 'Title of the question when the user declines a request (For you); {request} is what it asks.' }),
  declineWhy: msg({ id: 'board.forYou.declineWhy', defaultMessage: 'Why? The agent waiting on it reads your reason.', description: 'The question when the user declines a request for their approval: their reason, which the waiting agent is told.' }),
  declineNeeds: msg({ id: 'board.forYou.declineNeeds', defaultMessage: 'Say why, so the agent knows what to change.', description: 'An error in the question when the user declines a request without a reason: one is needed.' }),
  reply: msg({ id: 'board.forYou.reply', defaultMessage: 'Your answer', description: "The label (and placeholder) of the box under a question for the user (For you) in the card dialog: the user's answer, sent to the agent that asked." }),
  send: msg({ id: 'board.forYou.send', defaultMessage: 'Send Reply', description: "A button under a question for the user (For you): sends the answer typed above to the agent that asked." }),
  sendTip: msg({ id: 'board.forYou.sendTip', defaultMessage: 'Sends your answer to the agent that asked, and adds it to the card as your comment.', description: "Tooltip of the Send Reply button under a question for the user (For you): what it does." }),
  asDecision: msg({ id: 'board.forYou.asDecision', defaultMessage: 'Record as Decision', description: "A button under a question for the user (For you): records the answer typed above as one of the card's decisions (a new decision, which its agents read), and answers the question with it." }),
  asDecisionTip: msg({ id: 'board.forYou.asDecisionTip', defaultMessage: "Records your answer as one of the card's decisions, which its agents must follow from now on, and answers the question with it.", description: "Tooltip of the Record as Decision button under a question for the user (For you): what it does. Glossary: decision." }),
  offer: msg({ id: 'board.forYou.offer', defaultMessage: '{action, select, done {Move to Done} noCode {Make It No Code} other {Unblock}}', description: "A button under an agent's question for the user (For you): an action the agent offers on its card, done with one click. Keep the select keys as they are; translate each choice." }),
  offerTip: msg({ id: 'board.forYou.offerTip', defaultMessage: "{action, select, done {Moves the card to Done as you, skipping its project's rules where needed (recorded as an override, with the reason beside it), and answers the question.} noCode {Makes the card no code as you (recorded as an override, with the reason beside it), and answers the question.} other {Unblocks the card (the reason beside it is added as your comment), and answers the question.}}", description: "Tooltip of a button under an agent's question for the user (For you): what the action the agent offers does. Keep the select keys as they are. Glossary: override, no-code card." }),
  offerReason: msg({ id: 'board.forYou.offerReason', defaultMessage: 'Reason (optional)', description: "The label (and placeholder) of the field beside an action an agent's question offers (For you): why the user does it, filled with the agent's suggestion; it is recorded with the action." }),
  rounds: msg({ id: 'board.forYou.rounds', defaultMessage: 'More rounds', description: "The label of the number box beside Carry on, at a card loop's round limit: how many more review rounds the card gets." }),
  checklist: msg({ id: 'board.forYou.checklist', defaultMessage: 'To try:', description: 'Above the checklist of a Test request (For you): what the user is asked to try.' }),
  answering: msg({ id: 'board.forYou.answering', defaultMessage: 'Answering…', description: "A button while the user's answer to a request is being recorded." }),
  showAll: msg({ id: 'board.forYou.showAll', defaultMessage: '{all, select, yes {Show less} other {Show all}}', description: "A button under a long request for the user (For you) in the card dialog, shown only partly: shows all of it, or (yes) folds it again." }),
  failed: msg({ id: 'board.forYou.failed', defaultMessage: "Your answer wasn't taken", description: "An error toast's title: the user's answer to a request (For you) was refused, perhaps answered or retired meanwhile (a new submission, the card moved on). Its text says why." })
}

/** A request's text in the window: Hive's own by its message (the window's language), an agent's in its own words. */
export const requestText = (i: Pick<ForYouItem, 'shown' | 'text'>): string => (i.shown ? (workflowLine(i.shown, (m, values) => tr(m, values)) ?? i.text) : i.text)

/** A request's kind, as the window names it (Approve, Decide, Test, Sign in, Other). */
export const kindText = (i: Pick<ForYouItem, 'kind'>): string => tr(FOR_YOU_KIND, { kind: i.kind })

/** The requests a chip's tooltip shows; the others are counted. */
const TIP_REQUESTS = 2

/**
 * The chip on a card's tile: what waits for the user, by kind. Its tooltip is short (#1635): who asks for what, the
 * start of each request as plain text (an agent's question can be pages of Markdown) and where to answer it; the whole
 * is in the card's For you section.
 */
export function ForYouChip({ items }: { items: ForYouItem[] | undefined }) {
  const projects = useStore((s) => s.workspace?.projects)
  if (!items?.length) return null
  const who = (i: ForYouItem): string => (i.asker ? (projects?.find((p) => p.name.toLowerCase() === i.project.toLowerCase())?.agents.find((a) => a.id === i.asker)?.name ?? i.asker) : 'Hive') // i18n-ignore: the app's name
  const text = tr(M.chipTip, { n: items.length, requests: items.map((i) => `${kindText(i)}: ${gist(requestText(i), 100)}`).join(' · ') })
  const tip = (
    <div className="for-you-tip">
      {items.slice(0, TIP_REQUESTS).map((i) => (
        <div key={i.request} className="for-you-tip-request">
          <div className="for-you-tip-asks">{tr(M.tipAsks, { kind: i.kind, who: who(i) })}</div>
          <div>{gist(requestText(i))}</div>
        </div>
      ))}
      {items.length > TIP_REQUESTS && <div className="faint">{tr(M.tipMore, { n: items.length - TIP_REQUESTS })}</div>}
      <div className="faint">{tr(M.tipOpen)}</div>
    </div>
  )
  return (
    <Tooltip content={tip}>
      <span className="task-for-you" aria-label={text} data-for-you={items.map((i) => i.kind).join(' ')}>
        <Icon name="bell-dot" />
        <span className="task-chip-label">
          {tr(M.chip)}: {items.length === 1 ? kindText(items[0]) : items.length}
        </span>
      </span>
    </Tooltip>
  )
}

/**
 * The card dialog's For you section: each request with its answers. Nothing when nothing waits for the user. The answers
 * being written are the dialog's (`drafts`, by request), so closing it asks first; `setAnswering` says one is being sent.
 */
export function ForYouSection({ card, kind, items, drafts, setDraft, setAnswering }: { card: TaskCard; kind?: CardKind; items: ForYouItem[] | undefined; drafts: Record<string, string>; setDraft: (request: string, text: string) => void; setAnswering: (busy: boolean) => void }) {
  useLanguage()
  if (!items?.length) return null
  return (
    <div className="for-you-section" data-section="for-you">
      <div className="task-section-h">
        <Icon name="bell-dot" /> {tr(M.heading)}
      </div>
      {items.map((i) => (
        <ForYouRequest key={i.request} card={card} kind={kind} item={i} reply={drafts[i.request] ?? ''} setReply={(t) => setDraft(i.request, t)} setAnswering={setAnswering} />
      ))}
    </div>
  )
}

/**
 * Brings the card dialog's Work section into view at its merge queue part (the stopped merge's files and commands):
 * the Work section opens if it is folded, and shows it once read (HR3's #1357 round 1 finding 2).
 */
function showStuck(): void {
  window.dispatchEvent(new Event(SHOW_QUEUE_WORK))
}

/**
 * A request's text (#1637): Markdown, as card comments are (sanitized; lists, bold, code, card links), never the raw
 * marks, its line breaks kept; a long one is folded to about ten lines, with Show all.
 */
function RequestText({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [all, setAll] = useState(false)
  const [long, setLong] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (el && !all) setLong(el.scrollHeight > el.clientHeight + 1)
  }, [text, all])
  return (
    <>
      <div ref={ref} className={cx('for-you-question', !all && 'folded', !all && long && 'faded')}>
        <Markdown source={text} cards={MARKDOWN_CARDS} breaks />
      </div>
      {long && (
        <button type="button" className="btn subtle small for-you-more" aria-expanded={all} onClick={() => setAll(!all)}>
          {tr(M.showAll, { all: all ? 'yes' : 'no' })}
        </button>
      )}
    </>
  )
}

function ForYouRequest({ card, kind, item, reply, setReply, setAnswering }: { card: TaskCard; kind?: CardKind; item: ForYouItem; reply: string; setReply: (text: string) => void; setAnswering: (busy: boolean) => void }) {
  const agents = useStore((s) => s.workspace?.projects.find((p) => p.name.toLowerCase() === card.project.toLowerCase())?.agents)
  const [rounds, setRounds] = useState('1')
  // The actions the question offers that the card allows now (#1630), each with its reason (the agent's, as edited).
  const offered = (item.actions ?? []).filter((x) => askActionAvailable(x.kind, { ...card, ...(kind ? { kind } : {}) }))
  const [reasons, setReasons] = useState<Partial<Record<AskActionKind, string>>>({})
  const reasonOf = (x: { kind: AskActionKind; reason?: string }): string => reasons[x.kind] ?? x.reason ?? ''
  const action = useBusy()
  const text = requestText(item)
  const who = item.asker ? (agents?.find((a) => a.id === item.asker)?.name ?? item.asker) : 'hive'
  const answer = async (name: string, a: ForYouAnswer): Promise<void> => {
    let failed: string | null = null
    setAnswering(true)
    try {
      await action.run(name, async () => {
        try {
          await call('tasks:answer', card.number, item.request, a)
        } catch (e) {
          failed = errorMessage(e)
        }
      })
    } finally {
      setAnswering(false)
    }
    // Refused (answered or retired meanwhile, the card moved on): said, and the board read again; the answer written is
    // kept. Taken: it is sent, so nothing is left to lose.
    if (failed !== null) notify('error', tr(M.failed), failed)
    else setReply('')
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
        <span className="for-you-kind">{kindText(item)}</span>
      </div>
      <RequestText text={text} />
      <div className="faint for-you-asked">{tr(M.asked, { who, when: timeAgo(item.since) })}</div>
      {/* A merge stopped part way (#1357, the Assistant's requirement): its files and commands are one click away. */}
      {item.gate === QUEUE_STUCK_GATE && (
        <button type="button" className="btn small subtle for-you-show-work" data-action="show-stuck" onClick={showStuck}>
          <Icon name="list-flat" /> {tr(msg({ id: 'board.forYou.showStuck', defaultMessage: 'Show the files and commands', description: "A button on a For you request about a merge that stopped part way: shows the card's Work section, where each file and the commands that finish or undo the merge are listed." }))}
        </button>
      )}
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
      {!!offered.length && (
        <div className="for-you-offers">
          {offered.map((x) => (
            <div key={x.kind} className="for-you-offer" data-offer={x.kind}>
              <Tooltip content={tr(M.offerTip, { action: x.kind })}>
                <BusyButton className="primary" busy={busy(x.kind)} busyLabel={tr(M.answering)} disabled={!!action.busy} onClick={() => void answer(x.kind, { outcome: 'answered', action: x.kind, ...(reasonOf(x).trim() ? { reason: reasonOf(x).trim() } : {}) })}>
                  {tr(M.offer, { action: x.kind })}
                </BusyButton>
              </Tooltip>
              <input className="input" aria-label={tr(M.offerReason)} placeholder={tr(M.offerReason)} value={reasonOf(x)} onChange={(e) => setReasons((r) => ({ ...r, [x.kind]: e.target.value }))} />
            </div>
          ))}
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
            <Tooltip content={tr(M.sendTip)}>
              <BusyButton className={offered.length ? undefined : 'primary'} busy={busy('reply')} busyLabel={tr(M.answering)} disabled={!!action.busy || !reply.trim()} onClick={() => void answer('reply', { outcome: 'answered', reply: reply.trim() })}>
                {tr(M.send)}
              </BusyButton>
            </Tooltip>
            <Tooltip content={tr(M.asDecisionTip)}>
              <BusyButton busy={busy('decision')} busyLabel={tr(M.answering)} disabled={!!action.busy || !reply.trim()} onClick={() => void answer('decision', { outcome: 'answered', decision: reply.trim() })}>
                {tr(M.asDecision)}
              </BusyButton>
            </Tooltip>
          </div>
        </>
      )}
    </div>
  )
}
