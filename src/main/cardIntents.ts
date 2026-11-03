import { join } from 'path'
import type { StoredText, TaskCard, TaskPatch } from '../shared/types'
import type { IntentDone } from '../shared/toolReplies'
import type { AskAction, ForYouKind, LoopStepId } from '../shared/workflow/facts'
import type { FocusedTest } from '../shared/workflow/focused'
import { boardLock, getTask, loopStepNote, readTask, requestNote, runIntent, WorkflowRefusedError, type TaskActor } from './tasks'
import { actorOf } from './workflow/recorder'
import { isRefusal, type Moved, type Reply, type Workflow } from './workflow/runtime'
import { refusal } from '../shared/workflow/refusals'
import { workflowFor } from './workflow/service'
import { workspace, type WorkspaceService } from './workspace'
import { hiveError } from './hiveError'
import { msg } from '../shared/i18n'
import { LOOP_STEP_WAIT_MINUTES } from '../shared/lanes'
import { projectPreferences } from './workflow/preferences'
import { loopReviewerOf } from './loopReviewer'
import { cardRef } from '../shared/projectKeys'
import { HISTORY, storedText } from '../shared/taskHistory'
import { laneBuilds } from '../shared/lanes'
import { laneBuilderSkill } from '../shared/tasks'
import { rawLanes } from './lanes'
import { briefOf } from './laneBriefs'
import { placementDue } from './slotCards'
import { endWatchOf } from './watches'

/**
 * Agents act by intent (#1267, SPEC §16.8.1): start, put back, submit, declare paths, start review, verdict, report
 * merge, ask the user, couldn't within the rules, request to builder, a card loop's step. Each runs the card's runtime intent on the board's
 * one intent path (tasks.ts' runIntent, #1265), so its guards decide and its facts are written, and in each of its writes
 * the card's 0.9 fields follow (column, agent, its review, a comment), for the board, watches, lanes and the Agent API's
 * card. A refusal is the runtime's (§16.8.3), thrown as WorkflowRefusedError: the Agent API's 409 with the rule, what to
 * do next and who can override. With workflow rules off (Settings → Advanced) every intent runs with no guard.
 *
 * A card is named by its key (`HI-12`) or `#1061` (§16.12): an agent's plain number is refused, naming both forms (S48).
 */

export type CardIntent =
  | { kind: 'start' }
  | { kind: 'putBack'; why: string }
  | { kind: 'submit'; summary: string; revision?: string; note?: string; paths?: string[]; followUp?: boolean; tests?: FocusedTest[] }
  | { kind: 'declarePaths'; paths: string[] }
  | { kind: 'startReview'; submission?: number }
  | { kind: 'verdict'; submission?: number; pass: boolean; failKind?: 'content' | 'explanation'; comment: string }
  | { kind: 'reportMerge'; result?: string }
  | { kind: 'ask'; askKind: ForYouKind; text: string; revision?: string; checklist?: string[]; actions?: AskAction[] }
  | { kind: 'cannot'; rule: string; why: string }
  | { kind: 'request'; text: string }
  /** A card loop's step (#1382, #1467): a design or a follow-up for the reviewer's check, its answer, or going ahead unchecked. */
  | { kind: 'loopStep'; step: LoopStepId; text: string; design?: string }
  /** G20 (HI-1367): the card's reviewer decides on focused tests its merge skipped (`merge`: with them skipped, or returned). */
  | { kind: 'focusedSkip'; request: string; merge: boolean; why: string }
  /** The merge queue's controls (#1353): the user's, or the Assistant's with a reason (OP-9); never an agent's. */
  /** `guard`: the Assistant's change boundary, checked again inside the write. */
  | { kind: 'removeFromQueue'; reason: string; guard?: () => void }
  | { kind: 'retryMerge'; reason: string; guard?: () => void }

const M = {
  queueNotAgents: msg({ id: 'service.intent.queueNotAgents', defaultMessage: 'Only the user, or the Hive Assistant within Settings → Assistant → Control, takes a card out of the merge queue or retries its merge.', description: "An error: an agent or a script asked to remove a card from the merge queue or retry its merge, which only the user and the Hive Assistant (within its Control setting, a setting name: use it as Hive shows it) can do." }),
  noWorkflow: msg({ id: 'service.intent.noWorkflow', defaultMessage: '{card} has no workflow: it is a card about the workspace, or its project has no version control chosen yet. Move it on the board instead.', description: "An error: an intent (a card's start, submission, verdict…) was asked for a card that has no workflow, because it belongs to no project or its project's version control (Git or None) isn't chosen yet. {card} is the card's key (HI-12)." })
}

/** For unit tests (#1382): a pause before a card loop step's write, and inside it, before its reviewer is read. */
export const testHooks: { beforeDesignWrite?: () => Promise<void>; inDesignWrite?: () => Promise<void> } = {}

/** The card's number from a reference as the Agent API got it: `HI-12`, `#12`, or a plain number (`12`), and whether it was plain. */
export interface CardRefIn {
  n: number
  plain: boolean
}

/**
 * Runs an intent of a card for an actor (an agent by its own token, the Assistant, a script): the card read in the
 * caller's view (another project's is unknown to an agent), its runtime's intent with the card named as the runtime takes
 * it (an agent's plain number refused there), and the card's 0.9 fields in each write. Throws the runtime's refusal.
 * `commit`: a revocable caller's check (the Assistant's guard, HI-2420), made in each write just before it is saved.
 */
/** The intents after which a reply says what comes next (#1530): those that can change it. */
const NEXT_AFTER = new Set<CardIntent['kind']>(['start', 'putBack', 'submit', 'verdict', 'reportMerge', 'removeFromQueue', 'retryMerge'])

export async function runCardIntent(ref: CardRefIn, actor: TaskActor, intent: CardIntent, opts: { commit?: () => void } = {}): Promise<{ done: IntentDone; card: TaskCard }> {
  const ws = workspace
  const before = await readTask(ref.n, actor)
  const wf = ws.path && before.project ? await workflowFor(ws, join(ws.path, before.project)) : null
  if (!wf) throw hiveError(M.noWorkflow, { card: cardRef(ref.n) }, { kind: 'conflict' })
  const who = actorOf(actor)
  // How long a design waits for its check (#1382): the project's workflow option Design check wait (HI-1766), read
  // before the write; a step already waiting keeps the until it recorded.
  const cfg = (intent.kind === 'loopStep' || intent.kind === 'start') && ws.path ? await ws.projectConfig(join(ws.path, before.project)).catch(() => null) : null
  const stepWait = ws.path ? projectPreferences(ws, join(ws.path, before.project), cfg).loopStepWaitMinutes : LOOP_STEP_WAIT_MINUTES
  // A design's reviewer (#1382): the one rule loop wakes deliver by (loopReviewer.ts), read inside the step's own board
  // change (the runtime's prepare), where an agent's removal, published under the same lock, can't come between.
  const designReviewer = async (): Promise<string | null> => {
    await testHooks.inDesignWrite?.()
    const card = await getTask(ref.n, ws).catch(() => null)
    return card ? ((await loopReviewerOf(ws, card))?.id ?? null) : null
  }
  const self = actor.kind === 'agent' ? actor.self : undefined
  // An agent's plain number is refused, naming this card's own forms (S48, §16.12); a key or #N, and anyone else's number, aren't.
  if (ref.plain && self) throw new WorkflowRefusedError(refusal('card.plainNumber', { key: before.key ?? `#${ref.n}` }, null))
  const named = `#${ref.n}`
  if ((intent.kind === 'removeFromQueue' || intent.kind === 'retryMerge') && who !== 'user' && who !== 'assistant') throw hiveError(M.queueNotAgents, undefined, { kind: 'forbidden' })
  const by = who === 'assistant' ? 'assistant' : 'user'
  const call = (w: Workflow): Promise<Reply> => {
    switch (intent.kind) {
      case 'start':
        return w.start(named, who)
      case 'putBack':
        return w.putBack(named, who, { why: intent.why })
      case 'submit':
        return w.submit(named, who, { summary: intent.summary, ...(intent.revision ? { revision: intent.revision } : {}), ...(intent.note ? { note: intent.note } : {}), ...(intent.paths ? { paths: intent.paths } : {}), ...(intent.followUp ? { followUp: true } : {}), ...(intent.tests ? { tests: intent.tests } : {}) })
      case 'startReview':
        return w.startReview(named, who, { ...(intent.submission !== undefined ? { submission: intent.submission } : {}) })
      case 'verdict':
        return w.verdict(named, who, { pass: intent.pass, comment: intent.comment, ...(intent.submission !== undefined ? { submission: intent.submission } : {}), ...(intent.failKind ? { failKind: intent.failKind } : {}) })
      case 'reportMerge':
        return w.reportMerge(named, who, { ...(intent.result ? { result: intent.result } : {}) })
      case 'ask':
        return w.askTheUser(named, who, { kind: intent.askKind, text: intent.text, ...(intent.revision ? { revision: intent.revision } : {}), ...(intent.checklist?.length ? { checklist: intent.checklist } : {}), ...(intent.actions?.length ? { actions: intent.actions } : {}) })
      case 'cannot':
        return w.cannotWithinRules(named, who, { rule: intent.rule, why: intent.why })
      case 'request':
        return w.requestToBuilder(named, who, intent.text)
      case 'loopStep':
        return w.loopStep(named, who, intent.step, intent.text, { waitMinutes: stepWait, reviewer: designReviewer, ...(intent.design ? { design: intent.design } : {}) })
      case 'focusedSkip':
        return w.focusedSkip(named, who, intent.request, intent.merge, intent.why)
      case 'removeFromQueue':
        return w.removeFromQueue(named, intent.reason, by, intent.guard)
      case 'retryMerge':
        return w.retryMerge(named, intent.reason, by, intent.guard)
      default:
        throw new Error(`not an intent here: ${intent.kind}`) // i18n-ignore: a mistake in Hive's code, never shown
    }
  }

  // Declaring paths moves nothing: the runtime's own change of the card, in a change of the board.
  if (intent.kind === 'declarePaths') {
    const r = await boardLock(ws, () => wf.declarePaths(named, who, intent.paths, opts.commit))
    if (isRefusal(r)) throw new WorkflowRefusedError(r)
    const card = await readTask(ref.n, actor)
    return { done: { ok: true, card: card.key ?? `#${ref.n}`, from: '', to: '', data: { prefill: r.prefill, unclaimed: r.unclaimed, revision: r.revision } }, card }
  }

  // Every write keeps the card's agent as it is then, under the board's lock (an agent moving a card into Doing would take
  // it: a reviewer's failed verdict), but the start's, which gives the card to the agent that starts it. What else each
  // intent changes of the card's 0.9 fields (its review, a comment) goes with its first write.
  const zero9 = (w: { written: readonly { kind: string; data: unknown }[] }, first: boolean): { patch?: TaskPatch; opts?: { comment?: string; keepAgent?: boolean; note?: StoredText[] } } => {
    if (intent.kind === 'start') return first && self ? { patch: { agent: self.agentId } } : {}
    const keepAgent = true
    if (!first) return { opts: { keepAgent } }
    switch (intent.kind) {
      case 'putBack':
        return { opts: { keepAgent, comment: intent.why } }
      case 'submit': {
        // A follow-up's (HI-1832): no move to say it, so a line of its own, which its reviewer's watch and pendingStep read.
        const sub = w.written.findLast((f) => f.kind === 'Submitted')?.data as { followUp?: boolean; revision?: string | null } | undefined
        return { opts: { keepAgent, comment: intent.summary, ...(sub?.followUp ? { note: [storedText(HISTORY.followUpSubmitted, { revision: (sub.revision ?? '').slice(0, 7) })] } : {}) } }
      }
      case 'startReview':
        // The card marked as this reviewer's (an agent's own review; the Assistant and scripts don't review).
        return { ...(self ? { patch: { review: 'start' } } : {}), opts: { keepAgent } }
      case 'verdict':
        return { ...(self ? { patch: { review: intent.pass ? 'passed' : 'failed' } } : {}), opts: { keepAgent, comment: intent.comment } }
      case 'request':
        // Its history line too, which the builder's watch counts (#1272).
        return { opts: { keepAgent, comment: intent.text, note: [requestNote(intent.text)] } }
      case 'loopStep': {
        const step = w.written.findLast((f) => f.kind === 'LoopStep')?.data as { design?: string; until?: string; of?: string } | undefined
        // A design's or a follow-up's comment names it first (#1382, #1467): its first line is what a watch's wake and
        // latestComment show, so the reviewer has the id its answer names whichever way it is woken. A design's history line
        // keeps when its check is due, which the stall check reads (shared/tasks.ts' pendingStep); an answer's says what it checked.
        const asks = intent.step === 'design' ? 'Design' : intent.step === 'followUp' ? 'Follow-up' : null // i18n-ignore: Hive's line atop an agent's comment, agent-facing
        const comment = asks && step?.design ? `${asks} ${step.design}, for the reviewer's check (an answer names ${step.design}):\n\n${intent.text}` : intent.text // i18n-ignore: Hive's line atop an agent's comment, agent-facing
        return { opts: { keepAgent, comment, note: [loopStepNote(intent.step, intent.text, step?.until, step?.of)] } }
      }
      default:
        return { opts: { keepAgent } }
    }
  }
  if (intent.kind === 'loopStep') await testHooks.beforeDesignWrite?.()
  // `commit` (HI-2420): the Assistant's guard, checked again in each write as the card is saved (runIntent).
  const { reply, saved } = await runIntent(wf, ref.n, actor, call, zero9, opts.commit)
  if (isRefusal(reply)) throw new WorkflowRefusedError(reply)
  const card = saved ?? (await readTask(ref.n, actor))
  const m = reply as Moved
  // A start: how long a design waits for its check here (Card loops → Design check wait), for a watch set before posting one.
  if (intent.kind === 'start') m.data = { ...m.data, designWaitMinutes: stepWait }
  // Its own card to be given to it in a slot (HI-2197): a watch it has would hold that placement off ("waiting on cards"),
  // so it ends here, its wake cancelled, and the reply says so. Only once this start has left its placement due.
  if (intent.kind === 'start' && self && m.placed && ws.path && card.agent === self.agentId && (await placementDue(ws, join(ws.path, before.project), ref.n))) {
    const ended = await endWatchOf(join(ws.path, self.project), self.agentId, `Hive gives it ${card.key ?? `#${ref.n}`} in a slot`) // i18n-ignore: for the log and a cancelled wake
    if (ended) m.warnings = [...(m.warnings ?? []), `Your watch (${ended}) has ended: Hive gives you ${card.key ?? `#${ref.n}`} as a task, and a watch would hold it off.`] // i18n-ignore: agent-facing, the start's reply
  }
  const lane = intent.kind === 'start' && self && !m.placed && m.from !== m.to ? await laneStartWords(ws, before.project, self.agentId, ref.n, card.key ?? `#${ref.n}`) : null
  // What comes next on it (#1530), from its state and rules, after the intents that change what's next (a submit or a
  // verdict that leaves it where it was too: the agent merges, a quorum); the verdict after a review starts.
  const next = intent.kind === 'startReview' ? { step: 'intents' as const, intents: ['verdict'] } : NEXT_AFTER.has(intent.kind) ? wf.nextFor(ref.n) : null // i18n-ignore: an intent's name, agent-facing
  return { done: { ok: true, card: card.key ?? `#${ref.n}`, from: m.from, to: m.to, ...(m.data ? { data: m.data } : {}), ...(m.warnings?.length ? { warnings: m.warnings } : {}), ...(next ? { next } : {}), ...(lane ? { lane } : {}) }, card }
}

/**
 * A running lane's builder starting one of its lane's cards itself (HI-2092: Codex took its next card rather than end its
 * turn for Hive's start), outside a slot: the reply gives it what Hive's start would have (the start prompt's card-loop
 * line, and the lane's brief), so the lane's instructions reach it either way. Null for any other start. Agent-facing.
 */
async function laneStartWords(ws: WorkspaceService, project: string, agentId: string, n: number, key: string): Promise<string | null> {
  const lane = (await rawLanes(ws).catch(() => [])).find((l) => laneBuilds([l], project, agentId, n))
  if (!lane) return null
  const brief = briefOf(lane)
  return `${key} is a card of your lane (${lane.id}). ${laneBuilderSkill()}${brief ? `\n\n${brief}` : ''}` // i18n-ignore: agent-facing, the start's reply
}
