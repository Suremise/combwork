import { agentMsg, inDialectOf, say } from '../shared/agentText'
import { assistantCanAct } from './answerRelay'
import { createDelivery, offerNow, registerSource } from './deliveries'
import type { DeliveryRecord } from '../shared/deliveries'
import { createLogger } from './logger'
import { workspaceFor, type WorkspaceService } from './workspace'
import { workflowNow } from './workflow/service'
import type { Workflow } from './workflow/runtime'

/**
 * HI-3188 (Q4): a card's simplify check is told to the Assistant first, when it is set up and may act on
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

/**
 * HI-3370: whether the question a `churn-simplify` delivery tells of is still open on its card (its ref's request among
 * the card's open requests, For you): the user may have answered it, or the setting retired it, since it was made, and the
 * Assistant is then never told to answer a question that no longer exists. `wf`: the project's runtime, else unknown
 * (null), which gives it as before.
 */
export function simplifyQuestionOpen(wf: Pick<Workflow, 'state' | 'store'> | null, r: Pick<DeliveryRecord, 'ref' | 'meta'>): boolean | null {
  const card = typeof r.meta?.card === 'number' ? r.meta.card : null
  const request = r.ref?.slice(r.ref.indexOf('/') + 1) ?? ''
  if (!wf || card === null || !request || !r.ref?.includes('/')) return null
  try {
    return wf.state(wf.store.card(card)).requests.some((q) => q.request === request)
  } catch {
    // A card gone from the board: its question with it.
    return false
  }
}

/** The delivery's project folder, by the name it was made with (its meta), in its workspace now; null when it isn't there. */
function projectPathOf(ws: WorkspaceService, r: Pick<DeliveryRecord, 'meta'>): string | null {
  const name = typeof r.meta?.project === 'string' ? r.meta.project.toLowerCase() : null
  return (name && ws.info()?.projects.find((p) => p.name.toLowerCase() === name)?.path) || null
}

const GONE = 'its question was answered or retired' // i18n-ignore: why a delivery was cancelled, for the log

/** The source's checks (exported for tests, HI-3370): given only while the Assistant may act and the question is open. */
export const churnSimplifySource = {
  // Given only while the Assistant can act on it (its Control may have been turned down since), and its question is still
  // open (HI-3370: the user's answer, or the setting retiring it, ends it): its project's runtime read for that.
  refresh: async (r: DeliveryRecord, host: string): Promise<{ cancel: string } | null> => {
    const ws = workspaceFor(host)
    if (!ws || !assistantCanAct(ws)) return { cancel: 'the Assistant may not act on it now' } // i18n-ignore: why a delivery was cancelled, for the log
    const path = projectPathOf(ws, r)
    const wf = path ? await (await import('./workflow/service')).workflowFor(ws, path).catch(() => null) : null
    return simplifyQuestionOpen(wf, r) === false ? { cancel: GONE } : null
  },
  // At hand-out, synchronously: the runtime as this workspace already has it (workflowNow), else as before.
  holds: (r: DeliveryRecord, host: string): boolean => {
    const ws = workspaceFor(host)
    if (!ws || !assistantCanAct(ws)) return false
    const path = projectPathOf(ws, r)
    return simplifyQuestionOpen(path ? workflowNow(ws, path) : null, r) !== false
  }
}

registerSource(SOURCE, churnSimplifySource)
