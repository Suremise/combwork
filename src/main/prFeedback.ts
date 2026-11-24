// HI-3554: a pull request's comments on its card. The pull request is the card's GitHub source, or the one it opened
// while it is in PR open (HI-3552); its conversation comments, review bodies and inline review threads are read with gh,
// the repository and host named on each call (HI-2843's decision), when the card's dialog asks (as its PR state is read).
// Nothing is written to GitHub and nothing reaches an agent here: "Address feedback" (tasks.ts) makes a fix card of the
// ones the user chooses, read again.

import { join } from 'path'
import { gh, type GhResult, type GhTarget } from './ghCli'
import { feedbackOf, type FeedbackTarget, type PrFeedbackRead } from '../shared/prFeedback'
import type { TaskCard } from '../shared/types'
import type { CardState } from '../shared/workflow/facts'
import type { WorkspaceService } from './workspace'

/** What runs gh: `gh` in the app, a stand-in in tests. */
export type FeedbackGh = (target: GhTarget, args: string[], opts?: { json?: boolean }) => Promise<GhResult>

/** The pull request a card's feedback is read from: its source's, else the one it opened while in PR open; null: none. */
export function feedbackTarget(card: Pick<TaskCard, 'source'>, state: Pick<CardState, 'stage' | 'pullRequest'> | null): FeedbackTarget | null {
  const s = card.source
  if (s?.kind === 'pr') return { host: s.host, owner: s.owner, repo: s.repo, number: s.number }
  const p = state?.stage === 'prOpen' ? state.pullRequest?.opened : null
  return p ? { host: p.host, owner: p.owner, repo: p.repo, number: p.number } : null
}

/** The card's pull request as it is now (its board's card and workflow read), or null. */
export async function cardFeedbackTarget(ws: WorkspaceService, card: TaskCard): Promise<FeedbackTarget | null> {
  if (card.source?.kind === 'pr') return feedbackTarget(card, null)
  if (!card.project || card.archived) return null
  const { workflowFor } = await import('./workflow/service')
  const wf = await workflowFor(ws, ws.path ? join(ws.path, card.project) : card.project).catch(() => null)
  return feedbackTarget(card, wf ? wf.state(wf.store.card(card.number)) : null)
}

/**
 * A pull request's feedback read now: `pr view` for its state, conversation comments and reviews, and the REST list of
 * its review comments (the first 100, gh api naming the host) for its threads. Either failing: why, gh's own words.
 */
export async function readPrFeedback(target: FeedbackTarget, run: FeedbackGh = gh): Promise<PrFeedbackRead> {
  const repo = { host: target.host, owner: target.owner, repo: target.repo }
  const view = await run({ repo }, ['pr', 'view', String(target.number), '--json', 'state,comments,reviews'], { json: true })
  if (!view.ok) return { target, problem: view.problem, detail: view.detail }
  const inline = await run({ host: target.host }, ['api', `repos/${target.owner}/${target.repo}/pulls/${target.number}/comments?per_page=100`], { json: true })
  if (!inline.ok) return { target, problem: inline.problem, detail: inline.detail }
  const state = view.json && typeof view.json === 'object' ? (view.json as { state?: unknown }).state : null
  return { target, open: state === 'OPEN', items: feedbackOf(view.json, inline.json), at: Date.now() }
}

/** The card dialog's read (IPC `tasks:prFeedback`): card `n`'s pull request's feedback now, or why there is none. */
export async function prFeedbackOf(ws: WorkspaceService, n: number): Promise<PrFeedbackRead> {
  const { getTask } = await import('./tasks')
  const card = await getTask(n, ws)
  const target = await cardFeedbackTarget(ws, card)
  if (!target) return { target: null, problem: 'noPr', detail: null }
  return readPrFeedback(target)
}
