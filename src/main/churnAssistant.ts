import { agentMsg, inDialectOf, say } from '../shared/agentText'
import { assistantCanAct } from './answerRelay'
import { createDelivery, offerNow, registerSource } from './deliveries'
import { createLogger } from './logger'
import { workspaceFor, type WorkspaceService } from './workspace'

/**
 * HI-3188 (Darren's Q4, 14 Nov): a card's simplify check is told to the Assistant first, when it is set up and may act on
 * cards (assistantCanAct): it may answer carry on or simplify itself (`cw_answer_simplify`), and leaves cutting scope to
 * the user. The question stays under For you meanwhile, and the first answer wins. A delivery (`churn-simplify`), one per
 * question (its ref), cancelled when it is given if the Assistant can't act by then; nothing more is needed when it ends
 * unread, since the user has the question already.
 */

const log = createLogger('churnAssistant')

const SOURCE = 'churn-simplify'
const ASSISTANT = 'assistant'
/** Combwork's own deliveries come from it. */
const COMBWORK = { kind: 'combwork', name: 'Combwork' } as const // i18n-ignore: the product's name, as a delivery's sender

const T = {
  line: agentMsg({
    id: 'inbox.churn.simplify',
    text: "{key} reached its simplify check: {churn} rounds of back-and-forth (failed reviews, designs, requests, questions). Its loop is paused, and the user has the question ({request}) under For you. If it's clear, answer it yourself with cw_answer_simplify: carry on (what still comes up is worth handling) or simplify (drop what isn't). Cutting scope is the user's: otherwise leave it to them.",
    note: "HI-3188: Combwork's line to the Assistant when a card reaches its simplify check (Workflow → Card loops). {key}: the card's key; {churn}: its count (a number); {request}: the question's id (AM-12/r40). cw_answer_simplify is a tool's name."
  })
}

/** A simplify check to tell the Assistant of. */
export interface SimplifyAsked {
  card: number
  key: string
  project: string
  request: string
  churn: number
}

/** Tells the Assistant of a card's simplify check, when it can act on it now; never throws. */
export async function tellAssistantSimplify(ws: WorkspaceService, q: SimplifyAsked): Promise<void> {
  try {
    if (!assistantCanAct(ws)) return
    const body = inDialectOf({ projectPath: ws.assistantHome, agentId: ASSISTANT }, () => say(T.line, { key: q.key, churn: q.churn, request: q.request }))
    await createDelivery(ws.assistantHome, { agentId: ASSISTANT, kind: 'control', from: COMBWORK, card: q.card, body, source: SOURCE, ref: `#${q.card}/${q.request}`, meta: { card: q.card, project: q.project } })
    await offerNow(ws.assistantHome, ASSISTANT)
  } catch (e) {
    log.warn(`telling the Assistant of #${q.card}'s simplify check`, e)
  }
}

registerSource(SOURCE, {
  // Given only while the Assistant can act on it (its Control may have been turned down since).
  refresh: async (_r, host) => {
    const ws = workspaceFor(host)
    return ws && assistantCanAct(ws) ? null : { cancel: 'the Assistant may not act on it now' } // i18n-ignore: why a delivery was cancelled, for the log
  },
  holds: (_r, host) => {
    const ws = workspaceFor(host)
    return !!ws && assistantCanAct(ws)
  }
})
