import { agentList, agentMsg, say } from './agentText'
import type { WorkflowOptions } from './workflow/options'

/**
 * The brief a lane started from the window gives its builder and its reviewer (#1280, SPEC §16.11.3): the cards in
 * order, where the builder works, the reviewer, what the project's options require, how to move cards and how to report,
 * and the user's note. Under 1.0 most of a lane's procedure is the rules themselves and the card-loop skill, so it is
 * short. Agent-facing English (the Assistant's lane briefs can reuse it later).
 */
export interface LaneBriefInput {
  /** The project's name. */
  project: string
  /** The cards in the order they are worked: each by its key (AL-12) and title. */
  cards: { key: string; title: string }[]
  /** Where the builder works: its slot (#1438: a new branch per card), else its folder and branch. */
  builder: { name: string; folder: string | null; branch: string | null; slot?: string | null }
  reviewer: { name: string } | null
  /** Reviewed by the project's reviewer pool (#1443, G17): its agents' names (`reviewer` null). */
  pool?: string[] | null
  /** The options in force, or null while workflow rules are off. */
  options: Pick<WorkflowOptions, 'review' | 'preChecks' | 'finish' | 'okBefore' | 'target'> | null
  rounds: number
  /** The user's note, as they wrote it (empty: none). */
  note: string
}

export type LaneRole = 'builder' | 'reviewer'

/** The brief's text (dialects, HI-2438): the project's rules a line each (brief.rule.*), and the brief's own lines (brief.lane.*). */
const B = {
  rulesOff: agentMsg({ id: 'brief.rule.off', text: 'Workflow rules are off in this project: the cards move as you put them (cw_update_task).', note: 'The only rule while workflow rules are off.' }),
  reviewNone: agentMsg({ id: 'brief.rule.review.none', text: 'No review is needed.', note: 'Review: none.' }),
  reviewAgent: agentMsg({ id: 'brief.rule.review.agent', text: 'A reviewer agent reviews each card before it is merged.', note: 'Review: an agent.' }),
  reviewAgentThenYou: agentMsg({ id: 'brief.rule.review.agentThenYou', text: 'A reviewer agent reviews each card, then the user does, before it is merged.', note: 'Review: an agent, then the user.' }),
  reviewYou: agentMsg({ id: 'brief.rule.review.you', text: 'The user reviews each card before it is merged.', note: 'Review: the user.' }),
  preChecks: agentMsg({
    id: 'brief.rule.preChecks',
    text: 'Checks that pass before review: {checks}. Run each as `cw-progress --check <name> --card "<key>"` before submitting.',
    note: 'The checks the project runs before review, by name, joined ("typecheck and lint").'
  }),
  finishHive: agentMsg({ id: 'brief.rule.finish.combworkMerges', text: 'Combwork merges each approved card.', note: 'Finish: Combwork merges.' }),
  finishAgent: agentMsg({ id: 'brief.rule.finish.agentMerges', text: 'The builder merges each approved card (merge-ready), then reports it with cw_report_merge; Combwork checks it is in.', note: 'Finish: the builder merges.' }),
  finishCommitted: agentMsg({ id: 'brief.rule.finish.committed', text: 'A card is done once its work is committed.', note: 'Finish: committed is done.' }),
  finishNotChecked: agentMsg({ id: 'brief.rule.finish.notChecked', text: 'Combwork does not check merges: report each one with cw_report_merge.', note: "Finish: merges aren't checked." }),
  finishAccept: agentMsg({ id: 'brief.rule.finish.accept', text: 'An approved card is accepted where it is (no merge).', note: 'Finish: accepted where it is.' }),
  okEvery: agentMsg({ id: 'brief.rule.okBefore.every', text: "Every card waits for the user's OK before it is merged (Combwork asks them).", note: "The user's OK before every merge." }),
  okLabels: agentMsg({ id: 'brief.rule.okBefore.labels', text: "Cards labelled {labels} wait for the user's OK before they are merged (Combwork asks them).", note: 'The user\'s OK before merging cards with these labels, joined ("ui and api").' }),
  builder: agentMsg({
    id: 'brief.lane.builder',
    text: 'You are the builder of a lane in {project} that the user started: use the card-loop skill as the builder{reviewer, select, agent {, with {reviewerName} as the reviewer} pool {, reviewed by the pool ({pool}): Combwork gives each card you submit to a free reviewer of it, and its lane is registered already, so give cw_lane no reviewer} other {, with no reviewer}}; rounds: {rounds}.',
    note: "#1280: the builder's brief's first line. reviewer: agent (reviewerName reviews), pool (#1443: the project's reviewer pool, its agents joined, or brief.lane.poolEmpty) or none."
  }),
  poolEmpty: agentMsg({ id: 'brief.lane.poolEmpty', text: 'nobody in it yet', note: 'The reviewer pool, with no agent in it yet: in brief.lane.builder.' }),
  reviewer: agentMsg({ id: 'brief.lane.reviewer', text: "You are the reviewer of {builder}'s lane in {project} that the user started: use the card-loop skill as the reviewer; rounds: {rounds}.", note: "#1280: the reviewer's brief's first line." }),
  cards: agentMsg({ id: 'brief.lane.cards', text: 'The cards, one at a time in this order:', note: 'Above the cards, one a line ("1. AL-1 Lane data").' }),
  where: agentMsg({
    id: 'brief.lane.where',
    text: '{place, select, slot {{builder} works in {slot}, a new branch per card (Combwork makes each card\'s branch there from the target and gives the card to {builder} there)} folder {{builder} works in {folder}{hasBranch, select, yes { (branch {branch})} other {}}} other {{builder} works in the project folder}}{hasTarget, select, yes {; work goes to {target}} other {}}.',
    note: '#1438: where the builder works: its slot (a new branch per card), its folder (and branch), or the project folder; and the target its work goes to.'
  }),
  rules: agentMsg({ id: 'brief.lane.rules', text: "The project's rules:", note: "Above the project's rules (brief.rule.*), a line each." }),
  builderMoves: agentMsg({
    id: 'brief.lane.builderMoves',
    text: 'Ask Combwork for your next card with cw_lane next. Move cards by what you did: cw_start_card, cw_submit with a summary, and cw_report_merge after a merge. A refused move says what to do next; do that. Questions for the user go through cw_ask_user, requests for the Assistant through cw_ask_assistant, reports as comments on the card.',
    note: "How the builder moves cards and asks: the intents, and where questions go."
  }),
  reviewerMoves: agentMsg({
    id: 'brief.lane.reviewerMoves',
    text: 'Wait for each card in Review, then cw_start_review and cw_verdict on the revision it names. Questions for the builder go through cw_request_builder, for the user through cw_ask_user, for the Assistant through cw_ask_assistant.',
    note: 'How the reviewer reviews and asks.'
  }),
  note: agentMsg({ id: 'brief.lane.note', text: "The user's note: {note}", note: 'The note the user wrote as they started the lane, as they wrote it.' })
}

/** What the project's options ask of a lane's cards, a line each (none while the rules are off). */
export function laneRules(o: LaneBriefInput['options']): string[] {
  if (!o) return [say(B.rulesOff)]
  const out: string[] = []
  out.push(say({ none: B.reviewNone, agent: B.reviewAgent, agentThenYou: B.reviewAgentThenYou, you: B.reviewYou }[o.review]))
  if (o.preChecks.length) out.push(say(B.preChecks, { checks: agentList(o.preChecks) }))
  out.push(say({ hiveMerges: B.finishHive, agentMerges: B.finishAgent, committed: B.finishCommitted, notChecked: B.finishNotChecked, accept: B.finishAccept }[o.finish]))
  if (o.okBefore.mode === 'every') out.push(say(B.okEvery))
  if (o.okBefore.mode === 'labels' && o.okBefore.labels.length) out.push(say(B.okLabels, { labels: agentList(o.okBefore.labels) }))
  return out
}

/** The brief for a lane's builder or reviewer, as the prompt of its fresh conversation. */
export function laneBrief(i: LaneBriefInput, role: LaneRole): string {
  const cards = i.cards.map((c, n) => `${n + 1}. ${c.key} ${c.title}`)
  const target = i.options?.target ?? ''
  const where = say(B.where, {
    place: i.builder.slot ? 'slot' : i.builder.folder ? 'folder' : 'project',
    builder: i.builder.name,
    slot: i.builder.slot ?? '',
    folder: i.builder.folder ?? '',
    hasBranch: i.builder.branch ? 'yes' : 'no',
    branch: i.builder.branch ?? '',
    hasTarget: target ? 'yes' : 'no',
    target
  })
  const lines: string[] = []
  if (role === 'builder') {
    const reviewer = i.reviewer ? 'agent' : i.pool ? 'pool' : 'none'
    const pool = i.pool?.length ? agentList(i.pool) : say(B.poolEmpty)
    lines.push(say(B.builder, { project: i.project, reviewer, reviewerName: i.reviewer?.name ?? '', pool, rounds: String(i.rounds) }))
  } else {
    lines.push(say(B.reviewer, { builder: i.builder.name, project: i.project, rounds: String(i.rounds) }))
  }
  lines.push('', say(B.cards), ...cards, '', where)
  lines.push('', say(B.rules), ...laneRules(i.options).map((l) => `- ${l}`))
  lines.push('', say(role === 'builder' ? B.builderMoves : B.reviewerMoves))
  const note = i.note.trim()
  if (note) lines.push('', say(B.note, { note }))
  return lines.join('\n')
}
