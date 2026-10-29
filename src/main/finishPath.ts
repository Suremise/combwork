// What follows a card's Done (HI-2014, SPEC §16.4.6): the `finish` action every move into Done writes (workflow/finish.ts)
// runs one handler, whatever the route. Its steps are independent, each kept to once where its effect is made:
// - requests: the card's asked questions closed (`FinishStep` `requests`, in whose write closeSettled closes them) and
//   the Hive Assistant's unread asks on the card cancelled (cancelling one twice cancels nothing);
// - dependents: an override's Done counts as accepted (finishAccepts), and each card waiting on it is told it starts
//   without that card's work in the target, by a comment whose id is the finish's (written once on the card);
// - the slot and the line: the project's slot pass, which decides from what is on disk and in the pool each time (the
//   card's lease ended, its slot detached at the target's head when clean, its merged line deleted): never a mark;
// - the lane: read again (a lane whose cards are all Done ends; its next card waits until its slot is safe).
// A step whose finish is over (the card left Done, or finished again) is marked superseded and does nothing. A run cut
// short (a close, a crash) is run again as its workspace opens: each step finds what was done.

import { cancelDeliveries } from './deliveries'
import { onHiveEvent } from './events'
import { refresh as refreshLanes } from './lanes'
import { createLogger, userText } from './logger'
import { projectOfCard, settleSlotCards } from './slotCards'
import { commentAsHive } from './tasks'
import { openWorkspaces, type WorkspaceService } from './workspace'
import { onAction } from './workflow/actionWorker'
import { finishAccepts } from './workflow/finish'
import type { Workflow } from './workflow/runtime'
import { workflowFor } from './workflow/service'
import { HISTORY, storedText } from '../shared/taskHistory'
import type { FinishStepId } from '../shared/workflow/facts'

const log = createLogger('finish')

/** The steps a finish records once each: one not recorded yet is owed. */
const STEPS: readonly FinishStepId[] = ['requests', 'dependents', 'lane']

/** The comment's id on a dependent for a finish (HI-2014): one per parent finish, so a retry finds it. */
export const dependentNoteId = (key: string, finish: number): string => `finish-${key}-${finish}`

/**
 * Runs what card n's finish `finish` owes, in its project's workflow: each step once (above). Never throws: a step that
 * fails is logged and left owed, run again at the next open.
 */
export async function runFinish(ws: WorkspaceService, wf: Workflow, projectPath: string, n: number, finish: number): Promise<void> {
  const card = wf.store.cardByKey(`#${n}`)
  if (!card) return
  const step = async (id: FinishStepId, fn: () => Promise<void>): Promise<void> => {
    try {
      const s = wf.state(card)
      if (s.finished?.seq === finish && s.finished.steps.includes(id)) return
      if (s.finished?.seq === finish) await fn()
      await wf.finishStep(card, finish, id)
    } catch (e) {
      log.warn(`#${n}'s finish: its ${id} step`, e)
    }
  }
  await step('requests', async () => {
    if (!ws.assistantHome) return
    await cancelDeliveries(ws.assistantHome, 'assistant', 'its card reaching Done', undefined, (r) => r.source === 'assistant-ask' && r.card === n) // i18n-ignore: a delivery's cancel reason (agent-facing)
  })
  await step('dependents', async () => {
    const f = wf.state(card).finished
    if (!f || !finishAccepts(f) || f.how !== 'override') return
    const key = card.key
    for (const dep of wf.store.cards()) {
      if (!dep.blockedBy.includes(n) || dep.stage === 'done' || wf.store.isArchived(dep.id)) continue
      await commentAsHive(dep.id, storedText(HISTORY.startsWithout, { card: key, reason: f.reason ?? '' }), ws, (c) => c.column !== 'done', dependentNoteId(key, finish))
    }
  })
  // The slot and its line: decided by the pass from what is there (a lane's next card waits on it, below).
  await settleSlotCards(ws, projectPath).catch((e) => log.warn(`#${n}'s finish: its slot`, e))
  await step('lane', () => refreshLanes(ws))
}

/** Each open project's Done cards whose current finish still owes a step: run again (a workspace opening). */
async function recover(ws: WorkspaceService): Promise<void> {
  for (const p of ws.info()?.projects ?? []) {
    const wf = await workflowFor(ws, p.path).catch(() => null)
    if (!wf) continue
    for (const id of wf.store.cardsAt('done')) {
      const card = wf.store.cardByKey(`#${id}`)
      const f = card ? wf.state(card).finished : null
      if (!f || STEPS.every((s) => f.steps.includes(s))) continue
      log.info(`#${id}'s finish is owed ${STEPS.filter((s) => !f.steps.includes(s)).join(', ')}: run again (${userText(p.name)})`)
      await runFinish(ws, wf, p.path, id, f.seq)
    }
  }
}

let started = false

/** Registers the finish's handler and its recovery as workspaces open (index.ts, once). */
export function startFinishPath(): void {
  if (started) return
  started = true
  onAction(
    'finish',
    async (a, ws) => {
      const p = projectOfCard(ws, a.card)
      const wf = p ? await workflowFor(ws, p) : null
      if (p && wf) await runFinish(ws, wf, p, a.card, Number(a.payload.finish))
    },
    'repeatable'
  )
  const seen = new WeakSet<AbortSignal>()
  onHiveEvent((e) => {
    if (e.type !== 'workspace-changed') return
    for (const ws of openWorkspaces()) {
      if (!ws.path || seen.has(ws.lifetime)) continue
      seen.add(ws.lifetime)
      void recover(ws).catch((x) => log.warn('running the cards’ finishes owed', x))
    }
  })
}
