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

/** The newest review comments read (GitHub's most per page), and the most earlier threads' first comments read beside them. */
export const INLINE_MAX = 100
export const ROOTS_MAX = 20

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
 * its review comments for its threads (the newest INLINE_MAX, and the first comments of up to ROOTS_MAX earlier threads
 * they reply in; gh api naming the host). feedbackOf keeps the newest FEEDBACK_MAX_ITEMS of all. Either failing: why.
 */
export async function readPrFeedback(target: FeedbackTarget, run: FeedbackGh = gh): Promise<PrFeedbackRead> {
  const repo = { host: target.host, owner: target.owner, repo: target.repo }
  const view = await run({ repo }, ['pr', 'view', String(target.number), '--json', 'state,comments,reviews'], { json: true })
  if (!view.ok) return { target, problem: view.problem, detail: view.detail }
  // HR1's round 1: the newest INLINE_MAX review comments (GitHub lists them oldest first unless asked), so a comment or
  // reply arriving on a busy pull request is never past the first page.
  const api = `repos/${target.owner}/${target.repo}/pulls`
  const inline = await run({ host: target.host }, ['api', `${api}/${target.number}/comments?sort=created&direction=desc&per_page=${INLINE_MAX}`], { json: true })
  if (!inline.ok) return { target, problem: inline.problem, detail: inline.detail }
  const list = Array.isArray(inline.json) ? (inline.json as Record<string, unknown>[]) : []
  // A reply among them whose thread began earlier: its first comment read on its own (at most ROOTS_MAX threads; a reply
  // whose first comment can't be read is left out, its thread with it).
  const have = new Set(list.map((c) => c?.id))
  const missing = [...new Set(list.map((c) => c?.in_reply_to_id).filter((id): id is number => Number.isInteger(id) && !have.has(id)))].slice(0, ROOTS_MAX)
  for (const id of missing) {
    const root = await run({ host: target.host }, ['api', `${api}/comments/${id}`], { json: true })
    if (root.ok && root.json && typeof root.json === 'object') list.push(root.json as Record<string, unknown>)
  }
  const state = view.json && typeof view.json === 'object' ? (view.json as { state?: unknown }).state : null
  return { target, open: state === 'OPEN', items: feedbackOf(view.json, list), at: Date.now() }
}

/** The card dialog's read (IPC `tasks:prFeedback`): card `n`'s pull request's feedback now, or why there is none. */
export async function prFeedbackOf(ws: WorkspaceService, n: number): Promise<PrFeedbackRead> {
  const { getTask } = await import('./tasks')
  const card = await getTask(n, ws)
  const target = await cardFeedbackTarget(ws, card)
  if (!target) return { target: null, problem: 'noPr', detail: null }
  return readPrFeedback(target)
}
