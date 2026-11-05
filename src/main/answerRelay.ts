import { join } from 'path'
import { HISTORY, storedText } from '../shared/taskHistory'
import { msg } from '../shared/i18n'
import { withValues } from '../shared/advanced'
import { agentMsg, inDialectOf, say } from '../shared/agentText'
import { cardRef } from '../shared/projectKeys'
import type { AskActionKind } from '../shared/workflow/facts'
import { allows } from './assistantControl'
import { agentReadsInbox, createDelivery, offerNow, registerSource } from './deliveries'
import { createLogger, userText } from './logger'
import { sessions } from './sessions'
import { noteOnCard } from './tasks'
import { workspaceFor, type WorkspaceService } from './workspace'

/**
 * The user's answer to an agent's question, given to the Assistant too (HI-1734): on 25 Oct Darren agreed to move
 * HI-1449 to Done in his answer to HB3's question, Hive told HB3, which can't move a card to Done, and the card sat in
 * Approved for two days. Every answer to an agent's own question that Hive didn't carry out itself (no action clicked)
 * reaches the Assistant as well as the asker, so someone who can act on it has it; Hive never reads consent into the
 * reply's text. Where the card shows something only the user or the Assistant can settle (`need`: an action the
 * question offered, a card in Passed or Approved its agent can't move on, an open proposal, a block), it says so.
 *
 * A delivery to the Assistant (`answer-relay`), checked when it is given: the Assistant's hive tools on and Settings →
 * Assistant → Control letting it change cards; otherwise it is cancelled, and one that ends unread (cancelled, refused,
 * expired) tells the user on the card and in a notice that the Assistant couldn't be told.
 */

const log = createLogger('answerRelay')

const SOURCE = 'answer-relay'
const ASSISTANT = 'assistant'
/** Hive's own deliveries come from it. */
const HIVE = { kind: 'combwork', name: 'Combwork' } as const // i18n-ignore: the product's name, as a delivery's sender

/** The Assistant's line for an answer (relayLine), said in its dialect (agent-facing). */
const T = {
  reply: agentMsg({ id: 'inbox.relay.reply', text: 'Their reply, whole: <<<{reply}>>>', note: "In the Assistant's line for the user's answer to an agent's question (HI-1734): the user's reply, never cut (a condition at its end must reach whoever acts on it)." }),
  decision: agentMsg({ id: 'inbox.relay.decision', text: "Recorded as the card's decision, whole: <<<{decision}>>>", note: "In the Assistant's line for the user's answer to an agent's question (HI-1734): the decision recorded on the card, never cut. After the reply (inbox.relay.reply), joined by \". \"." }),
  replyIsDecision: agentMsg({ id: 'inbox.relay.replyIsDecision', text: "Their reply, whole, recorded as the card's decision too: <<<{reply}>>>", note: "In the Assistant's line for the user's answer to an agent's question: an approval's note, which is its reply and the card's decision too, said once (HI-2286)." }),
  said: agentMsg({
    id: 'inbox.relay.said',
    text: "the user {outcome, select, approved {approved} declined {declined} other {answered}} {asker}'s question on {card}. The question, whole: <<<{question}>>>.{wrote, select, yes { {words}.} answered {} other { Nothing was written with it.}} (Both stay on the card: cw_read_task {card}.)",
    note: "What the user did with an agent's question, in the Assistant's line (HI-1734), after its opening (inbox.relay.declined, .needed, .check). asker: the asking agent's name; card: its card (HI-12); question: the question, whole; wrote: yes with words (the reply and decision: inbox.relay.reply, .decision), answered for an answer with none, no for a bare approval or decline."
  }),
  declined: agentMsg({ id: 'inbox.relay.declined', text: 'For your information: {said} The user declined: nothing is to be done for it.', note: "The Assistant's line when the user declined an agent's question (HI-1734): never worded as a grant. said: what the user did (inbox.relay.said)." }),
  needed: agentMsg({
    id: 'inbox.relay.needed',
    text: "This needs you: {said} {asker} can't {need, select, done {move it to Done} noCode {make it no code} unblock {unblock it} other {skip its review}} by itself. {outcome, select, approved {Their approval is a yes, within any conditions its reply sets} other {Do it only if the answer agrees, within any conditions it sets}}, with the answer as the reason (cw_update_task).",
    note: "The Assistant's line when the user answered or approved an agent's question on a card that needs what only the Assistant or the user can do (HI-1734). said: what the user did (inbox.relay.said); asker: the asking agent's name; need: done, noCode, unblock or skipReview; outcome: approved or answered."
  }),
  check: agentMsg({
    id: 'inbox.relay.check',
    text: "For you to check: {said} If it grants a change {asker} can't make itself (Done past its rules, no code, skipping its review), make it, within any conditions it sets, with the answer as the reason; otherwise nothing is needed.",
    note: "The Assistant's line when the user answered or approved an agent's question and nothing on the card says what is needed (HI-1734): Combwork never reads consent into a reply. said: what the user did (inbox.relay.said); asker: the asking agent's name."
  })
}

const M = {
  title: msg({ id: 'service.answerRelay.title', defaultMessage: '{card}: nobody else has your answer', description: "A notification's title (a banner, a Windows notification): the user answered an agent's question on card {card} (its key, such as HI-12), and the Combwork Assistant, which could act on it, couldn't be told." })
}

/** Whether the Assistant can be told an answer and act on it now: its hive tools on, and Control letting it change cards. */
export function assistantCanAct(ws: WorkspaceService): boolean {
  return !!ws.path && agentReadsInbox(ws.assistantHome, ASSISTANT) && allows('agents')
}

/** An answer to relay: its card, the agent that asked and the question, the user's answer, and what only someone else can do. */
export interface AnswerToRelay {
  card: number
  key: string
  project: string
  asker: string
  askerName: string
  request: string
  question: string
  /** How the user answered (an approval, a decline, or an answer to a question), kept apart from any words with it. */
  outcome: 'approved' | 'declined' | 'answered'
  /** The user's reply or decision, whole (a bare Approve or Decline has none). */
  reply?: string
  decision?: string
  need: AskActionKind | null
}

/**
 * The Assistant's line: how the user answered (approved, declined, answered) and what they wrote, each whole, never cut
 * (HR1's round 1: a condition at a reply's end must reach whoever acts on it; a delivery holds 100,000 characters, a
 * reply at most 20,000), where it stays on the board, and what to do. A decline is never worded as a grant. Agent-facing.
 */
export function relayLine(a: AnswerToRelay): string {
  // HI-2286: an approval's note is its reply and the card's decision too: said once.
  const words = a.reply && a.decision === a.reply ? say(T.replyIsDecision, { reply: a.reply }) : [a.reply ? say(T.reply, { reply: a.reply }) : '', a.decision ? say(T.decision, { decision: a.decision }) : ''].filter(Boolean).join('. ')
  const said = say(T.said, { outcome: a.outcome, asker: a.askerName, card: a.key, question: a.question, wrote: words ? 'yes' : a.outcome === 'answered' ? 'answered' : 'no', words })
  if (a.outcome === 'declined') return say(T.declined, { said })
  if (a.need) return say(T.needed, { said, asker: a.askerName, need: a.need, outcome: a.outcome })
  return say(T.check, { said, asker: a.askerName })
}

/**
 * Gives an answer to the Assistant (once per request), or, when it can't be told now, tells the user at once: on the
 * card and in a notice. Never throws: the answer itself is given whatever becomes of this.
 */
export async function relayAnswer(ws: WorkspaceService, a: AnswerToRelay): Promise<void> {
  try {
    if (!assistantCanAct(ws)) return await untold(ws, a.card, a.project, a.askerName, a.need)
    const meta = { card: a.card, project: a.project, askerName: a.askerName, ...(a.need ? { need: a.need } : {}) }
    await createDelivery(ws.assistantHome, { agentId: ASSISTANT, kind: 'control', from: HIVE, card: a.card, body: inDialectOf({ projectPath: ws.assistantHome, agentId: ASSISTANT }, () => relayLine(a)), source: SOURCE, ref: `#${a.card}/${a.request}`, meta })
    await offerNow(ws.assistantHome, ASSISTANT)
  } catch (e) {
    log.warn(`giving the Assistant the user's answer on #${a.card}`, e)
    await untold(ws, a.card, a.project, a.askerName, a.need).catch(() => undefined)
  }
}

/** The user told, on the card and in a notice, that the Assistant couldn't be told of their answer. */
async function untold(ws: WorkspaceService, card: number, project: string, askerName: string, need: AskActionKind | null): Promise<void> {
  const line = need ? storedText(HISTORY.answerUntoldNeed, { agent: askerName, action: need }) : storedText(HISTORY.answerUntold, { agent: askerName })
  await noteOnCard(card, line, ws)
  const body = need ? withValues(HISTORY.answerUntoldNeed, { agent: askerName, action: need }) : withValues(HISTORY.answerUntold, { agent: askerName })
  if (ws.path) sessions.notice(join(ws.path, project), withValues(M.title, { card: cardRef(card) }), body)
  log.info(`The Assistant couldn't be told of the user's answer on #${card} (${userText(askerName)}'s question)`)
}

registerSource(SOURCE, {
  // Given only while the Assistant can act on it (its Control may have been turned down since the answer).
  refresh: async (_r, host) => {
    const ws = workspaceFor(host)
    return ws && assistantCanAct(ws) ? null : { cancel: 'the Assistant may not act on it now' } // i18n-ignore: why a delivery was cancelled, for the log
  },
  holds: (_r, host) => {
    const ws = workspaceFor(host)
    return !!ws && assistantCanAct(ws)
  },
  // Ended unread (cancelled, refused, expired, stale): the user is told nobody else has their answer.
  ended: (r, host) => {
    const ws = workspaceFor(host)
    const m = r.meta ?? {}
    if (!ws || typeof m.card !== 'number' || typeof m.project !== 'string') return
    const need = typeof m.need === 'string' ? (m.need as AskActionKind) : null
    // agent-protocol: a stand-in asker's name for the user's note and notice (window text), never said to an agent
    void untold(ws, m.card, m.project, typeof m.askerName === 'string' ? m.askerName : 'its agent', need).catch((e) => log.warn('telling the user an answer reached nobody else', e)) // i18n-ignore: a stand-in agent name, never shown (every relay keeps its asker's)
  }
})
