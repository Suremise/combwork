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

const list = (items: string[]): string => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`)

/** What the project's options ask of a lane's cards, a line each (none while the rules are off). */
export function laneRules(o: LaneBriefInput['options']): string[] {
  if (!o) return ['Workflow rules are off in this project: the cards move as you put them (hive_update_task).']
  const out: string[] = []
  const review = { none: 'No review is needed.', agent: 'A reviewer agent reviews each card before it is merged.', agentThenYou: 'A reviewer agent reviews each card, then the user does, before it is merged.', you: 'The user reviews each card before it is merged.' }[o.review]
  out.push(review)
  if (o.preChecks.length) out.push(`Checks that pass before review: ${list(o.preChecks)}. Run each as \`hive-progress --check <name> --card "<key>"\` before submitting.`)
  const finish = {
    hiveMerges: 'Hive merges each approved card.',
    agentMerges: 'The builder merges each approved card (merge-ready), then reports it with hive_report_merge; Hive checks it is in.',
    committed: 'A card is done once its work is committed.',
    notChecked: 'Hive does not check merges: report each one with hive_report_merge.',
    accept: 'An approved card is accepted where it is (no merge).'
  }[o.finish]
  out.push(finish)
  if (o.okBefore.mode === 'every') out.push("Every card waits for the user's OK before it is merged (Hive asks them).")
  if (o.okBefore.mode === 'labels' && o.okBefore.labels.length) out.push(`Cards labelled ${list(o.okBefore.labels)} wait for the user's OK before they are merged (Hive asks them).`)
  return out
}

/** The brief for a lane's builder or reviewer, as the prompt of its fresh conversation. */
export function laneBrief(i: LaneBriefInput, role: LaneRole): string {
  const cards = i.cards.map((c, n) => `${n + 1}. ${c.key} ${c.title}`)
  const where = i.builder.slot
    ? `${i.builder.name} works in ${i.builder.slot}, a new branch per card (Hive makes each card's branch there from the target and gives the card to ${i.builder.name} there)`
    : i.builder.folder
      ? `${i.builder.name} works in ${i.builder.folder}${i.builder.branch ? ` (branch ${i.builder.branch})` : ''}`
      : `${i.builder.name} works in the project folder`
  const target = i.options?.target ? `; work goes to ${i.options.target}` : ''
  const lines: string[] = []
  if (role === 'builder') {
    const reviewer = i.reviewer ? `, with ${i.reviewer.name} as the reviewer` : i.pool ? `, reviewed by the pool (${i.pool.length ? list(i.pool) : 'nobody in it yet'}): Hive gives each card you submit to a free reviewer of it, and its lane is registered already, so give hive_lane no reviewer` : ', with no reviewer'
    lines.push(`You are the builder of a lane in ${i.project} that the user started: use the card-loop skill as the builder${reviewer}; rounds: ${i.rounds}.`)
  } else {
    lines.push(`You are the reviewer of ${i.builder.name}'s lane in ${i.project} that the user started: use the card-loop skill as the reviewer; rounds: ${i.rounds}.`)
  }
  lines.push('', 'The cards, one at a time in this order:', ...cards, '', `${where}${target}.`)
  lines.push('', "The project's rules:", ...laneRules(i.options).map((l) => `- ${l}`))
  if (role === 'builder') {
    lines.push('', 'Ask Hive for your next card with hive_lane next. Move cards by what you did: hive_start_card, hive_submit with a summary, and hive_report_merge after a merge. A refused move says what to do next; do that. Questions for the user go through hive_ask_user, requests for the Hive Assistant through hive_ask_assistant, reports as comments on the card.')
  } else {
    lines.push('', 'Wait for each card in Review, then hive_start_review and hive_verdict on the revision it names. Questions for the builder go through hive_request_builder, for the user through hive_ask_user, for the Hive Assistant through hive_ask_assistant.')
  }
  const note = i.note.trim()
  if (note) lines.push('', `The user's note: ${note}`)
  return lines.join('\n')
}
