import { watchText } from './agentWatch'
import { fmt, msg, tr } from './i18n'
import { shownStatusMessage } from './runtime'
import { columnName } from './tasks'
import type { LiveSessionState } from './types'

/**
 * The Assistant panel's status line (#312), from what Combwork knows of its session: "Working", "Idle", "Waiting for you",
 * "Waiting for #271, #273 → Review (watch until 22:22)". A card watch's cards are kept apart (`cards`, between `text`
 * and `after`) so each can be a chip that opens its card. `tone`: attention when it needs the user, busy while it works,
 * calm while it is idle or waits on cards or tasks, off when it isn't running. `approvals`: the titles of Combwork's questions
 * its actions wait on (stopping a busy agent…), shown under the line: waiting for the user's answer comes first, over
 * working, idle and a card watch; sign-in and an error keep their words, with it added.
 *
 * Window text, in the language shown (#885): the line is only ever shown, never read by the Assistant.
 */
export interface AssistantStatusLine {
  text: string
  cards: number[]
  after: string
  tone: 'attention' | 'busy' | 'calm' | 'off'
}

/** Where a card watch's cards go in the line's words: it is cut there, the chips go between. */
const CARDS = '\u0001'

const M = {
  notRunning: msg({ id: 'assistant.status.notRunning', defaultMessage: 'Not running', description: "The Assistant panel's status line (after \"Status:\"): its session isn't running." }),
  approval: msg({ id: 'assistant.status.approval', defaultMessage: 'Waiting for your approval: {title}', description: "The Assistant panel's status line: an action of the Assistant waits for the user's answer to one of Combwork's questions ({title}: the question, e.g. \"Stop a busy agent?\")." }),
  approvals: msg({ id: 'assistant.status.approvals', defaultMessage: '{n, plural, one {Waiting for your approval (# question)} other {Waiting for your approval (# questions)}}', description: "The Assistant panel's status line: its actions wait for the user's answers to {n} of Combwork's questions (always two or more)." }),
  untaken: msg({ id: 'assistant.status.untaken', defaultMessage: "A line Combwork typed wasn't taken: press Enter in its terminal", description: "The Assistant panel's status line: a line Combwork typed into the Assistant's terminal is still waiting there; the user presses Enter in it." }),
  waiting: msg({ id: 'assistant.status.waiting', defaultMessage: 'Waiting for you', description: "The Assistant panel's status line: it asks the user something, or a permission." }),
  signin: msg({ id: 'assistant.status.signin', defaultMessage: 'Waiting for you to sign in', description: "The Assistant panel's status line: its CLI needs the user to sign in." }),
  error: msg({ id: 'assistant.status.error', defaultMessage: '{message, select, none {Error} other {Error: {message}}}', description: "The Assistant panel's status line: its CLI failed, with what it said ({message}; none: nothing said, leave the colon out)." }),
  watch: msg({ id: 'assistant.status.watch', defaultMessage: '{watch}{until, select, none {} other { (watch until {until})}}', description: "The Assistant panel's status line while it watches agents or card loops: what it waits for ({watch}: \"Waiting for B6 to finish\"), and until when ({until}: a time; none: leave that branch empty)." }),
  cards: msg({ id: 'assistant.status.cards', defaultMessage: 'Waiting for {cards}{until, select, none {} other { (watch until {until})}}', description: "The Assistant panel's status line while it watches cards: the cards ({cards}: each a chip, \"#12 #13\") and until when ({until}: a time; none: leave that branch empty)." }),
  cardsInto: msg({ id: 'assistant.status.cardsInto', defaultMessage: 'Waiting for {cards} → {column}{until, select, none {} other { (watch until {until})}}', description: "The Assistant panel's status line while it watches cards move into a board column: the cards ({cards}: each a chip, \"#12 #13\"), the column ({column}) and until when ({until}: a time; none: leave that branch empty)." }),
  onCards: msg({ id: 'assistant.status.onCards', defaultMessage: 'Waiting on cards', description: "The Assistant panel's status line: it waits for cards to change (a card watch)." }),
  background: msg({ id: 'assistant.status.background', defaultMessage: '{n, plural, one {Waiting on # background task} other {Waiting on # background tasks}}', description: "The Assistant panel's status line: its turn ended while {n} background tasks it started still run." }),
  starting: msg({ id: 'assistant.status.starting', defaultMessage: 'Starting…', description: "The Assistant panel's status line: its session is starting." }),
  working: msg({ id: 'assistant.status.working', defaultMessage: 'Working', description: "The Assistant panel's status line: it is working on a turn." }),
  idle: msg({ id: 'assistant.status.idle', defaultMessage: '{n, plural, =0 {Idle} one {Idle · # background task running} other {Idle · # background tasks running}}', description: "The Assistant panel's status line: its turn has ended, with {n} background tasks it started still running (0: none)." }),
  also: msg({ id: 'assistant.status.also', defaultMessage: '{line} · {also, select, approval {waiting for your approval} other {has a question for you}}', description: "The Assistant panel's status line ({line}: what it is doing) with the user also wanted: one of Combwork's questions waits for their answer (approval), or the Assistant asked them something it works on through." })
}

export function assistantStatusLine(live: Pick<LiveSessionState, 'status' | 'statusMessage' | 'statusText' | 'backgroundTasks' | 'question' | 'watch' | 'untakenLine'> | null | undefined, time: (iso: string) => string, approvals: readonly string[] = []): AssistantStatusLine {
  const line = (text: string, tone: AssistantStatusLine['tone'], cards: number[] = []): AssistantStatusLine => {
    const [before, after = ''] = text.split(CARDS)
    return { text: before, cards, after, tone }
  }
  if (!live || live.status === 'stopped') return line(tr(M.notRunning), 'off')
  const approval = approvals.length === 1 ? tr(M.approval, { title: approvals[0] }) : approvals.length ? tr(M.approvals, { n: approvals.length }) : ''
  if (approval && live.status !== 'signin' && live.status !== 'error') return line(approval, 'attention')
  // A wake it didn't take (#430): the user presses Enter in its terminal.
  if (live.untakenLine) return line(tr(M.untaken), 'attention')
  const n = live.backgroundTasks ?? 0
  // Combwork's own words in the language shown (#847), or the CLI's as they came.
  const said = shownStatusMessage(live)
  const base = ((): AssistantStatusLine => {
    switch (live.status) {
      case 'waiting':
        return line(tr(M.waiting), 'attention')
      case 'signin':
        return line(tr(M.signin), 'attention')
      case 'error':
        return line(tr(M.error, { message: said || 'none' }), 'attention') // i18n-ignore: an ICU select's key
      case 'watching':
        if (live.watch) {
          const until = time(live.watch.limitAt) || 'none'
          // An agent watch (#416) or a lane watch (#531): what it follows, in words.
          if (live.watch.agents || live.watch.lanes) return line(tr(M.watch, { watch: watchText(live.watch, tr, (l) => fmt.list(l, 'unit')), until }), 'calm')
          if (live.watch.column) return line(tr(M.cardsInto, { cards: CARDS, column: columnName(live.watch.column, tr), until }), 'calm', live.watch.cards)
          return line(tr(M.cards, { cards: CARDS, until }), 'calm', live.watch.cards)
        }
        return line(tr(M.onCards), 'calm')
      case 'background':
        return line(tr(M.background, { n }), 'calm')
      case 'starting':
        return line(said || tr(M.starting), 'busy')
      case 'working':
        return line(said || tr(M.working), 'busy')
      default:
        return line(tr(M.idle, { n }), 'calm')
    }
  })()
  // A question it doesn't stop for: it works on meanwhile, and the user is wanted.
  const also = approval ? 'approval' : live.question && live.status !== 'waiting' ? 'question' : null
  if (!also) return base
  const whole = tr(M.also, { line: `${base.text}${base.cards.length ? CARDS : ''}${base.after}`, also })
  return line(whole, 'attention', base.cards)
}
