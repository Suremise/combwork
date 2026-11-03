// A batch card change (hive_update_tasks, #417): the request, checked, and the Hive Assistant's turn for it. The Agent
// API's route turns a refusal into its status; the rules live here, so the tests reach them without the API.
import { COLUMN_CHOICES, isTaskColumn } from '../shared/tasks'
import * as assistant from './assistantControl'
import { ChangeRefused } from './assistantControl'
import * as tasks from './tasks'
import { recordingChanges } from './assistantChanges'
import { cardAgent, knownAgent } from './activityTargets'
import { cardRef } from '../shared/projectKeys'
import { agentMsg, inDefaultDialect, say } from '../shared/agentText'

/** What a batch is called (HI-2450): said in the Assistant's scope in a refusal, in the Default where it is kept. */
const BATCH_WHAT = agentMsg({ id: 'activity.batch.update', text: 'change {n} {count, plural, one {card} other {cards}} on the board', note: "What the Assistant's batch of card changes is called (hive_update_tasks), lower case: in a refusal (\"…don't let you {what}\") and its activity line. {n} is the number of cards as digits; {count} the same number, choosing the word." })

/**
 * The fields a batch takes besides its card numbers and reply. A title, comment, decision or link is one card's: a batch
 * never archives, edits a decision or deletes (those stay the user's, on one card).
 */
const BATCH_FIELDS = ['numbers', 'column', 'position', 'blocked', 'labels', 'addLabels', 'removeLabels', 'agent', 'override', 'reply']

/** The card numbers and the fields of a batch request, checked before anything changes or is counted. */
export function batchRequest(body: any): { numbers: number[]; patch: tasks.BatchPatch } {
  const other = Object.keys(body ?? {}).filter((k) => !BATCH_FIELDS.includes(k))
  if (other.length) throw new ChangeRefused(400, `A batch sets column, position, blocked, labels, addLabels, removeLabels or agent on its cards: ${other.join(', ')} goes on one card (hive_update_task).`)
  const numbers = tasks.batchNumbers(body?.numbers)
  const patch: tasks.BatchPatch = {}
  if (body.column !== undefined) {
    if (!isTaskColumn(body.column)) throw new ChangeRefused(400, `Unknown column "${String(body.column)}": ${COLUMN_CHOICES}.`)
    patch.column = body.column
  }
  if (body.position !== undefined && body.position !== null && body.position !== '') {
    if (body.position !== 'top' && body.position !== 'bottom') throw new ChangeRefused(400, `Unknown position "${String(body.position)}": top or bottom.`)
    patch.position = body.position
  }
  if (body.blocked !== undefined) {
    if (body.blocked !== null && typeof body.blocked !== 'string') throw new ChangeRefused(400, 'blocked is the reason as text, or empty to clear it.')
    patch.blocked = body.blocked
  }
  if (body.labels !== undefined) {
    if (!Array.isArray(body.labels) || !body.labels.every((x: unknown) => typeof x === 'string')) throw new ChangeRefused(400, 'labels is a list of text.')
    patch.labels = body.labels
  }
  // #1131: labels added to or taken off each card, its other labels kept; beside labels, refused before any card changes.
  for (const k of ['addLabels', 'removeLabels'] as const) {
    if (body[k] === undefined) continue
    if (!Array.isArray(body[k]) || !body[k].every((x: unknown) => typeof x === 'string')) throw new ChangeRefused(400, `${k} is a list of text.`)
    if (body.labels !== undefined) throw new ChangeRefused(400, "labels replaces each card's labels: give it alone, or addLabels and removeLabels to change only those.")
    patch[k] = body[k]
  }
  if (body.agent !== undefined) patch.agent = body.agent ? String(body.agent) : null
  // The Assistant's reason for moving the cards across their workflow rules (#1265): one, for every card of the batch.
  if (body.override !== undefined && body.override !== null) {
    const reason = typeof body.override === 'object' ? body.override.reason : undefined
    if (typeof reason !== 'string' || !reason.trim()) throw new ChangeRefused(400, 'override is { "reason": "<why>" }, the reason not empty.')
    if (body.column === undefined) throw new ChangeRefused(400, 'override goes with column: it is the reason for moving the cards across their rules.')
    patch.override = { reason: reason.trim() }
  }
  if (!Object.keys(patch).length) throw new ChangeRefused(400, 'Give what to change on the cards: column, position, blocked, labels, addLabels, removeLabels or agent.')
  return { numbers, patch }
}

const clip = (s: string, max: number): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/**
 * A batch the Assistant asks for, through the Assistant's change boundary (assistantControl's admit, which assistantChange
 * uses for a single change too): its control level is checked before any card changes. Each
 * card is then written only if the guard still passes after its last read, under its own lock: the control level and the session that asked must still allow it (the user may have turned the
 * level down, or the Assistant been restarted, while the batch waited for a card). A card refused for any reason is left
 * as it was, and every card, changed or refused, is recorded in the activity list on its own. Returns each card's outcome, in the order given.
 */
export async function assistantBatch(ws: string, token: string, numbers: number[], patch: tasks.BatchPatch, actor: tasks.TaskActor): Promise<tasks.BatchItem[]> {
  const column = typeof patch.column === 'string' ? { column: patch.column } : {}
  const what = [BATCH_WHAT, { n: String(numbers.length), count: numbers.length }] as const
  const guard = assistant.admit(ws, token, 'agents', what, { kind: 'update-tasks', cards: numbers, ...column })
  // Each card's change recorded for undo as it is saved (#1282): a change of its own, in this message's group, kept in the Default.
  const items = await recordingChanges(ws, 'update-tasks', inDefaultDialect(() => say(...what)), () => tasks.updateTasks(numbers, patch, actor, { commit: guard }))
  // Each card's line names its card, its project and the agent it is with (#763): a viewer follows a bulk move card by
  // card. A refused card: the agent it was to be given, if there is one.
  for (const i of items) {
    if (i.card) {
      const agent = await cardAgent(i.card)
      assistant.record(ws, { kind: 'update-tasks', card: i.number, column: i.card.column, ...(i.card.project ? { project: i.card.project } : {}), ...(agent ? { agent } : {}) }, `${cardRef(i.number)} ${clip(i.card.title, 60)}: ${i.said.join(', ') || 'no change'}`)
    } else {
      const was = await tasks.getTask(i.number).catch(() => null)
      const agent = typeof patch.agent === 'string' ? await knownAgent(was?.project, patch.agent) : undefined
      assistant.record(ws, { kind: 'update-tasks', card: i.number, ...column, ...(was?.project ? { project: was.project } : {}), ...(agent ? { agent } : {}) }, `${cardRef(i.number)}: change`, i.error ?? 'refused', { reason: 'Refused' })
    }
  }
  return items
}
