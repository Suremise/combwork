import { join } from 'path'
import { HISTORY, storedText } from '../shared/taskHistory'
import { msg } from '../shared/i18n'
import { withValues } from '../shared/advanced'
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
const HIVE = { kind: 'hive', name: 'Hive' } as const // i18n-ignore: the product's name, as a delivery's sender

/** What the Assistant is asked to do, by action (agent-facing: English). */
const NEED_WORDS: Record<AskActionKind, string> = { done: 'move it to Done', noCode: 'make it no code', unblock: 'unblock it', skipReview: 'skip its review' } // i18n-ignore: agent-facing (the Assistant's inbox)

const M = {
  title: msg({ id: 'service.answerRelay.title', defaultMessage: '{card}: nobody else has your answer', description: "A notification's title (a banner, a Windows notification): the user answered an agent's question on card {card} (its key, such as HI-12), and the Hive Assistant, which could act on it, couldn't be told." })
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
  const how = a.outcome === 'approved' ? 'approved' : a.outcome === 'declined' ? 'declined' : 'answered'
  // HI-2286: an approval's note is its reply and the card's decision too: said once.
  const words = a.reply && a.decision === a.reply ? `Their reply, whole, recorded as the card's decision too: <<<${a.reply}>>>` : [a.reply ? `Their reply, whole: <<<${a.reply}>>>` : '', a.decision ? `Recorded as the card's decision, whole: <<<${a.decision}>>>` : ''].filter(Boolean).join('. ') // i18n-ignore: agent-facing (the Assistant's inbox)
  const said = `the user ${how} ${a.askerName}'s question on ${a.key}. The question, whole: <<<${a.question}>>>.${words ? ` ${words}.` : a.outcome === 'answered' ? '' : ' Nothing was written with it.'} (Both stay on the card: hive_read_task ${a.key}.)` // i18n-ignore: agent-facing (the Assistant's inbox)
  if (a.outcome === 'declined') return `For your information: ${said} The user declined: nothing is to be done for it.` // i18n-ignore: agent-facing (the Assistant's inbox)
  const agrees = a.outcome === 'approved' ? 'Their approval is a yes, within any conditions its reply sets' : 'Do it only if the answer agrees, within any conditions it sets' // i18n-ignore: agent-facing (the Assistant's inbox)
  if (a.need) return `This needs you: ${said} ${a.askerName} can't ${NEED_WORDS[a.need]} by itself. ${agrees}, with the answer as the reason (hive_update_task).` // i18n-ignore: agent-facing (the Assistant's inbox)
  return `For you to check: ${said} If it grants a change ${a.askerName} can't make itself (Done past its rules, no code, skipping its review), make it, within any conditions it sets, with the answer as the reason; otherwise nothing is needed.` // i18n-ignore: agent-facing (the Assistant's inbox)
}

/**
 * Gives an answer to the Assistant (once per request), or, when it can't be told now, tells the user at once: on the
 * card and in a notice. Never throws: the answer itself is given whatever becomes of this.
 */
export async function relayAnswer(ws: WorkspaceService, a: AnswerToRelay): Promise<void> {
  try {
    if (!assistantCanAct(ws)) return await untold(ws, a.card, a.project, a.askerName, a.need)
    const meta = { card: a.card, project: a.project, askerName: a.askerName, ...(a.need ? { need: a.need } : {}) }
    await createDelivery(ws.assistantHome, { agentId: ASSISTANT, kind: 'control', from: HIVE, card: a.card, body: relayLine(a), source: SOURCE, ref: `#${a.card}/${a.request}`, meta })
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
    void untold(ws, m.card, m.project, typeof m.askerName === 'string' ? m.askerName : 'its agent', need) // i18n-ignore: a stand-in agent name, never shown (every relay keeps its asker's).catch((e) => log.warn('telling the user an answer reached nobody else', e))
  }
})
