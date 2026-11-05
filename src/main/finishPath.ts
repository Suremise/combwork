// What follows a card's Done (HI-2014, SPEC §16.4.7): the `finish` action every move into Done writes (workflow/finish.ts)
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

import { basename } from 'path'
import { cancelDeliveries } from './deliveries'
import { onCombworkEvent } from './events'
import { journalFact } from './journalService'
import { refresh as refreshLanes } from './lanes'
import { createLogger, userText } from './logger'
import { projectOfCard, settleSlotCards } from './slotCards'
import { commentAsCombwork } from './tasks'
import { openWorkspaces, type WorkspaceService } from './workspace'
import { onAction } from './workflow/actionWorker'
import { finishAccepts } from './workflow/finish'
import type { Workflow } from './workflow/runtime'
import { workflowFor } from './workflow/service'
import { agentMsg, inDefaultDialect, say } from '../shared/agentText'
import type { StoredText } from '../shared/types'
import { cardRef } from '../shared/projectKeys'
import { HISTORY, storedText } from '../shared/taskHistory'
import type { FinishHow, FinishStepId } from '../shared/workflow/facts'

const log = createLogger('finish')

/** The steps a finish records once each: one not recorded yet is owed. */
const STEPS: readonly FinishStepId[] = ['requests', 'dependents', 'lane', 'wake', 'journal']

/** What the finish writes for agents (dialects, HI-2438): stored, so said in the Default (Hive renders stored text when read). */
const A = {
  done: agentMsg({
    id: 'finish.journal.done',
    text: '{card} "{title}" is Done ({how, select, queue {merged by the merge queue} reported {merged, reported by its builder} unchecked {reported merged by its builder, not checked} accepted {accepted} override {moved there by an override} other {moved there on the board}}), by {byUser, select, yes {You} other {{by}}}',
    note: "The journal's fact of a card reaching Done (HI-2014), the Assistant's to read. how: how it got there (FinishHow: queue, reported, unchecked, accepted, override, board). byUser: yes when the user moved it; by: else who did (an agent's name, or hive). Written once per finish: its summary and detail are the once-check's key, so it is always the Default's."
  }),
  cancelled: agentMsg({
    id: 'finish.cancel.cardDone',
    text: 'its card reaching Done',
    note: "Who cancelled the Assistant's unread asks on a card that reached Done, as the delivery records it: cancelled by …"
  })
}

/** The journal's fact of a finish (stored: the Default's words, whatever scope it runs in). */
export const doneFact = (card: string, title: string, how: FinishHow, by: string): string => inDefaultDialect(() => say(A.done, doneValues(card, title, how, by)))
const doneValues = (card: string, title: string, how: FinishHow, by: string): Record<string, string> => ({ card, title, how, byUser: by === 'user' ? 'yes' : 'no', by })
/** The fact's message, stored beside its English summary, to be said in each reader's dialect when read (5b, 6b). */
export const doneFactText = (card: string, title: string, how: FinishHow, by: string): StoredText => ({ id: A.done.id, values: doneValues(card, title, how, by) })

/** The comment's id on a dependent for a finish (HI-2014): one per parent finish, so a retry finds it. */
export const dependentNoteId = (key: string, finish: number): string => `finish-${key}-${finish}`

/**
 * Runs what card n's finish `finish` owes, in its project's workflow: each step once (above). Never throws: a step that
 * fails is logged and left owed, run again at the next open.
 */
export async function runFinish(ws: WorkspaceService, wf: Workflow, projectPath: string, n: number, finish: number): Promise<void> {
  const card = wf.store.cardByKey(`#${n}`)
  if (!card) return
  // This finish, still the card's, in the workspace it began in: checked inside each effect's own write too (HR2's
  // round 1 finding 1), so a card reopened or finished again while one waits gets nothing of an old finish.
  const life = ws.lifetime
  const current = (): boolean => !life.aborted && ws.lifetime === life && wf.state(card).stage === 'done' && wf.state(card).finished?.seq === finish
  const at = wf.store.facts(n).find((f) => f.seq === finish)?.at ?? new Date().toISOString()
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
    await cancelDeliveries(ws.assistantHome, 'assistant', inDefaultDialect(() => say(A.cancelled)), undefined, (r) => r.source === 'assistant-ask' && r.card === n && r.created <= at && current())
  })
  await step('dependents', async () => {
    const f = wf.state(card).finished
    if (!f || !finishAccepts(f) || f.how !== 'override') return
    const key = card.key
    for (const dep of wf.store.cards()) {
      if (!dep.blockedBy.includes(n) || dep.stage === 'done' || wf.store.isArchived(dep.id)) continue
      await commentAsCombwork(dep.id, storedText(HISTORY.startsWithout, { card: key, reason: f.reason ?? '' }), ws, (c) => c.column !== 'done' && current(), dependentNoteId(key, finish))
    }
  })
  // The lane first: it ends as its last card is Done, never later for its slot (its next card waits on the slot itself,
  // laneStatus). Then the slot and its line, decided by the pass from what is there.
  await step('lane', () => refreshLanes(ws))
  // Its builder told it is Done (a loop's wake, once for its move: the queue's Done too, HR2's round 1 finding 2), and
  // the journal's fact of it, once for this finish (its link and detail: the finish).
  await step('wake', async () => void (await wf.finishWake(card, finish)))
  await step('journal', async () => {
    const f = wf.state(card).finished
    if (!f || !current()) return
    const by = wf.store.facts(n).find((x) => x.seq === finish)?.actor ?? 'combwork'
    // agent-protocol: the detail names the finish by its number, the once-check's key (writeEntryOnce)
    journalFact(ws, { summary: doneFact(cardRef(n), card.title, f.how, by), summaryText: doneFactText(cardRef(n), card.title, f.how, by), detail: `finish ${finish}`, project: basename(projectPath), links: [{ type: 'card', ref: String(n) }], tags: ['done'] }, { type: 'card', ref: String(n) }) // i18n-ignore: the journal's detail for agents, protocol (agent-protocol above)
  })
  await settleSlotCards(ws, projectPath).catch((e) => log.warn(`#${n}'s finish: its slot`, e))
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
  onCombworkEvent((e) => {
    if (e.type !== 'workspace-changed') return
    for (const ws of openWorkspaces()) {
      if (!ws.path || seen.has(ws.lifetime)) continue
      seen.add(ws.lifetime)
      void recover(ws).catch((x) => log.warn('running the cards’ finishes owed', x))
    }
  })
}
