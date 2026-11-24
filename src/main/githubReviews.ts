// HI-3559 (Feedback to GitHub; HI-3541's and HI-2843's decisions, HI-3553/r9 points 4 and 5): the reviews a pull
// request's card posts to GitHub, always a COMMENT review, through the gh service on the card's own pull request (its
// source; `gh api … --hostname <host>`), as the user's own account. A reviewer agent's verdict is drafted with it in the
// verdict's write (runtime.ts) under the option then: Agent's posted by Combwork through the `postGithubReview` action,
// Both's for the user to edit and post; under User only the user's own reviews are posted. Each post is claimed first
// (GithubReviewPosting) in a write that checks it isn't posted or being posted, so it is posted once; its result is
// written after (Posted, or Failed with gh's words). The user's open line comments on that submission go with it: inline
// where the reviewed revision is the pull request's head GitHub has and the lines sit in its diff's hunks, else listed in
// the body; GitHub refusing the inline ones posts it again with them listed. An agent's text ends with its footer when
// the option says so.

import { mkdtemp, rm, writeFile } from 'original-fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { combworkError } from './combworkError'
import { gh } from './ghCli'
import { createLogger, userText } from './logger'
import { platformIdOf } from './platform/registry'
import { revisionReadsOf } from './platform/revisionReadsPorts'
import { boardChanged } from './boardStore'
import { sessions } from './sessions'
import type { WorkspaceService } from './workspace'
import { onAction } from './workflow/actionWorker'
import { lineCommentsOf } from './workflow/lineComments'
import { projectPathOf } from './workflow/revisionDiff'
import { workflowFor } from './workflow/service'
import type { Workflow } from './workflow/runtime'
import type { RevisionReads } from './platform/revisionReads'
import { msg } from '../shared/i18n'
import { modelLabel, projectAgents } from '../shared/defaults'
import { providerDescriptor } from '../shared/providers'
import { foldGithubReviews, githubFooter, inHunks, inlineOf, listedComments, REVIEW_BODY_MAX, reviewBody, type DiffHunk, type GithubReviewRow, type GithubReviewsView, type InlineComment } from '../shared/githubReviews'
import { githubFeedbackOf, githubFooterOf, type GithubFeedback } from '../shared/workflow/options'
import type { Fact } from '../shared/workflow/facts'
import type { LineCommentView } from '../shared/workflow/lineComments'

const log = createLogger('github')

const M = {
  notPr: msg({ id: 'github.review.notPr', defaultMessage: 'This card isn’t about a pull request, so it has nothing to post to GitHub.', description: 'HI-3559: an error posting a review to GitHub from a card whose GitHub source isn’t a pull request.' }),
  noCard: msg({ id: 'github.review.noCard', defaultMessage: 'This card’s work can’t be read, so it can’t post to GitHub.', description: 'HI-3559: an error posting a review to GitHub: the card’s work record (its facts) can’t be read.' }),
  notAllowed: msg({ id: 'github.review.notAllowed', defaultMessage: 'Feedback to GitHub is “{option, select, agent {The agent} user {You} other {Both}}” for this project, which doesn’t post {what, select, draft {an agent’s draft} other {a review you write}} from here (Version Control → Workflow → GitHub).', description: 'HI-3559: an error posting a review to GitHub that the project’s Feedback to GitHub option doesn’t allow. Keep the select keys; the quoted values are the option’s values as the form names them, translated as there. Version Control → Workflow → GitHub is a place in the window.' }),
  noDraft: msg({ id: 'github.review.noDraft', defaultMessage: 'That draft is no longer on this card.', description: 'HI-3559: an error posting or discarding a review draft that isn’t on the card any more.' }),
  done: msg({ id: 'github.review.done', defaultMessage: 'That review was {state, select, posted {already posted} discarded {discarded} other {already being posted}}.', description: 'HI-3559: an error posting or discarding a review that was already posted, discarded, or is being posted. Keep the select keys.' }),
  empty: msg({ id: 'github.review.empty', defaultMessage: 'A review needs some text, or a line comment of yours to carry.', description: 'HI-3559: an error posting a review to GitHub with no text and no line comments.' }),
  noLink: msg({ id: 'github.review.noLink', defaultMessage: 'This project’s GitHub link no longer names {repo}, the pull request’s repository (Version Control → Workflow → GitHub).', description: 'HI-3559: an error posting a review: the project’s GitHub repository changed since the card’s pull request was set. {repo} is owner/name. Version Control → Workflow → GitHub is a place in the window.' })
}

/** A posting claimed longer ago than this with no result (a close or a crash mid-post) can be posted again. */
const STUCK_MS = 10 * 60_000

async function cardOf(ws: WorkspaceService, n: number) {
  const projectPath = projectPathOf(ws, n)
  const wf = await workflowFor(ws, projectPath).catch(() => null)
  const card = wf?.store.card(n) ?? null
  if (!wf || !card) throw combworkError(M.noCard)
  if (card.source?.kind !== 'pr') throw combworkError(M.notPr)
  return { wf, card, source: card.source, projectPath }
}

/** The model a reviewer agent runs, for the footer: its session's (as it reports it, or was launched with), else its CLI's name. */
async function modelOf(ws: WorkspaceService, projectPath: string, agent: string): Promise<{ name: string | null; model: string | null }> {
  const def = projectAgents(await ws.projectConfig(projectPath).catch(() => ({ agents: [] }))).find((a) => a.id === agent)
  const st = sessions.liveFor(projectPath, agent)
  const provider = st?.provider ?? def?.provider ?? null
  const id = st?.modelId ?? st?.launchedWith?.model ?? def?.model ?? null
  const model = id && provider ? modelLabel(id, provider) : provider ? providerDescriptor(provider).name : null
  return { name: def?.name ?? st?.agentName ?? null, model }
}

/** The card's reviews to GitHub, for its dialog. */
export async function githubReviewsView(ws: WorkspaceService, n: number): Promise<GithubReviewsView> {
  const { wf, card, source, projectPath } = await cardOf(ws, n)
  const o = wf.cfg.options()
  const facts = wf.store.facts(card.id)
  const rows = foldGithubReviews(facts)
  const who = new Map<string, { name: string | null; model: string | null }>()
  for (const r of rows) if (r.draft && !who.has(r.draft.reviewer)) who.set(r.draft.reviewer, await modelOf(ws, projectPath, r.draft.reviewer))
  const latest = wf.state(card).latest?.id ?? null
  const openComments = latest === null ? 0 : lineCommentsOf(ws, n).filter((c) => c.state === 'open' && c.submission === latest).length
  const feedback = githubFeedbackOf(o)
  return { feedback, footer: githubFooterOf(o), rows: rows.map((r) => ({ ...r, reviewerName: r.draft ? (who.get(r.draft.reviewer)?.name ?? null) : null, model: r.draft ? (who.get(r.draft.reviewer)?.model ?? null) : null })), openComments, canWrite: feedback !== 'agent', url: source.url }
}

/** Whether the option lets `by` post this (a draft, or the user's own review). */
function allowed(feedback: GithubFeedback, by: 'user' | 'combwork', row: GithubReviewRow | null): boolean {
  if (by === 'combwork') return !!row?.draft?.auto && feedback === 'agent'
  if (!row?.draft) return feedback !== 'agent'
  // Both: the user edits and posts a draft; Agent's own, posted by Combwork, only again by the user once it failed.
  return feedback === 'both' || (feedback === 'agent' && row.draft.auto && (row.state === 'failed' || row.state === 'posting'))
}

/**
 * Posts a review to the card's pull request: draft `draft` (its fact's seq; the user's edit of its text in `body`), or
 * the user's own (draft null). Claimed, posted, and its result written; the row as it ends. Refused (thrown) when the
 * option doesn't allow it, it was posted or discarded, or is being posted.
 */
export async function postGithubReview(ws: WorkspaceService, n: number, req: { draft: number | null; body?: string }, by: 'user' | 'combwork'): Promise<GithubReviewRow> {
  const { wf, projectPath } = await cardOf(ws, n)
  const row = await postReviewOn(wf, n, req, by, {
    link: async () => (await import('./githubLink')).githubRepoFor(ws, projectPath),
    comments: () => lineCommentsOf(ws, n),
    model: async (agent) => (await modelOf(ws, projectPath, agent)).model,
    reads: revisionReadsOf(platformIdOf(projectPath, (await ws.projectConfig(projectPath).catch(() => null))?.platform)),
    projectPath,
    gh
  })
  boardChanged(ws)
  return row
}

/** What posting a review reads outside the card's facts (main's own, or a test's). */
export interface PostDeps {
  /** The project's GitHub link now. */
  link: () => Promise<{ host: string; owner: string; repo: string } | null>
  /** The card's line comments. */
  comments: () => LineCommentView[]
  /** A reviewer agent's model, for its footer (null: unknown). */
  model: (agent: string) => Promise<string | null>
  reads: RevisionReads | null
  projectPath: string
  gh: typeof gh
}

/** postGithubReview on card `n` of `wf`, with what it reads outside the facts given. */
export async function postReviewOn(wf: Workflow, n: number, req: { draft: number | null; body?: string }, by: 'user' | 'combwork', deps: PostDeps): Promise<GithubReviewRow> {
  const card = wf.store.card(n)
  const source = card.source
  if (source?.kind !== 'pr') throw combworkError(M.notPr)
  const o = wf.cfg.options()
  const feedback = githubFeedbackOf(o)
  // Claimed under the store's lock: the draft as it is, the option as it is now, and nothing posting it already.
  const claim = await wf.write(card, null, by === 'combwork' ? 'combwork' : 'user', (w) => {
    const rows = foldGithubReviews(w.tx.facts(card.id))
    const row = req.draft === null ? null : (rows.find((r) => r.draft?.seq === req.draft) ?? null)
    if (req.draft !== null && !row) throw combworkError(M.noDraft)
    if (!allowed(feedback, by, row)) throw combworkError(M.notAllowed, { option: feedback, what: req.draft === null ? 'own' : 'draft' })
    if (row?.state === 'posted' || row?.state === 'discarded') throw combworkError(M.done, { state: row.state })
    if (row?.state === 'posting' && (by === 'combwork' || Date.now() - Date.parse(row.posting!.at) < STUCK_MS)) throw combworkError(M.done, { state: 'posting' })
    // Combwork posts an Agent draft once, as its action runs: one that failed waits for the user.
    if (by === 'combwork' && row?.state !== 'draft') throw combworkError(M.done, { state: 'posting' })
    const submission = row?.draft?.submission ?? w.state().latest?.id ?? null
    const posting = w.fact('GithubReviewPosting', { draft: req.draft, by, submission })
    return { posting: posting.seq, row, submission }
  })
  const draft = claim.row?.draft ?? null
  const text = (req.body ?? draft?.body ?? '').trim()
  let error: string | null = null
  let done: { url: string | null; body: string; comments: string[]; inline: number; listed: number } | null = null
  try {
    // The repository the card's pull request is on must still be the project's link: never posted elsewhere.
    const link = await deps.link()
    if (!link || link.host.toLowerCase() !== source.host.toLowerCase() || link.owner.toLowerCase() !== source.owner.toLowerCase() || link.repo.toLowerCase() !== source.repo.toLowerCase()) throw combworkError(M.noLink, { repo: `${source.owner}/${source.repo}` })
    const comments = claim.submission === null ? [] : deps.comments().filter((c) => c.state === 'open' && c.submission === claim.submission)
    if (!text && !comments.length) throw combworkError(M.empty)
    const footer = draft && githubFooterOf(o) ? githubFooter((await deps.model(draft.reviewer)) ?? 'an AI agent') : null // i18n-ignore: posted to GitHub as written, in English
    done = await send(wf, card.id, deps, source, claim.submission, text, footer, comments)
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  await wf.write(card, null, by === 'combwork' ? 'combwork' : 'user', (w) => {
    if (done) w.fact('GithubReviewPosted', { posting: claim.posting, ...done })
    else w.fact('GithubReviewFailed', { posting: claim.posting, error: (error ?? '').slice(0, 1000) })
  })
  if (!done) log.info(`#${n}'s review not posted to GitHub: ${userText(error ?? '')}`)
  const rows = foldGithubReviews(wf.store.facts(card.id))
  return rows.find((r) => r.posting?.seq === claim.posting)!
}

/** Discards a draft (never posted): the user's, while it isn't posted or being posted. */
export async function discardGithubReview(ws: WorkspaceService, n: number, draftSeq: number): Promise<void> {
  const { wf, card } = await cardOf(ws, n)
  await wf.write(card, null, 'user', (w) => {
    const row = foldGithubReviews(w.tx.facts(card.id)).find((r) => r.draft?.seq === draftSeq)
    if (!row) throw combworkError(M.noDraft)
    if (row.state !== 'draft' && row.state !== 'failed') throw combworkError(M.done, { state: row.state === 'posting' ? 'posting' : row.state })
    w.fact('GithubReviewDiscarded', { draft: draftSeq })
  })
  boardChanged(ws)
}

/**
 * The review made and sent: the line comments that can sit on GitHub's diff inline (the reviewed revision is the pull
 * request's head as its start fetched it, and the lines are in a hunk of that file's change), the rest listed in the body.
 * GitHub refusing it with inline comments (its head moved meanwhile, a line it won't take) sends it again with all listed.
 */
async function send(wf: Workflow, cardId: number, deps: PostDeps, source: { host: string; owner: string; repo: string; number: number }, submission: number | null, text: string, footer: string | null, comments: LineCommentView[]): Promise<{ url: string | null; body: string; comments: string[]; inline: number; listed: number }> {
  const facts = wf.store.facts(cardId)
  const sub = facts.find((f): f is Fact<'Submitted'> => f.kind === 'Submitted' && f.seq === submission)?.data
  const pr = wf.state(wf.store.card(cardId)).started?.pr
  const onHead = !!sub?.revision && !!sub.base && !!pr && sub.revision === pr.headOid
  const inline: LineCommentView[] = []
  if (onHead && comments.length) {
    const hunks = new Map<string, DiffHunk[]>()
    for (const c of comments) {
      if (!hunks.has(c.path)) hunks.set(c.path, deps.reads ? await deps.reads.fileHunks(deps.projectPath, sub!.base!, sub!.revision!, c.path).catch(() => []) : [])
      if (inHunks(hunks.get(c.path)!, c.side, c.from, c.to)) inline.push(c)
    }
  }
  const post = async (on: LineCommentView[]) => {
    const listed = comments.filter((c) => !on.includes(c))
    let body = reviewBody(text, listedComments(listed), footer)
    if (body.length > REVIEW_BODY_MAX) body = `${body.slice(0, REVIEW_BODY_MAX - 1)}…`
    const payload: { body: string; event: 'COMMENT'; commit_id?: string; comments?: InlineComment[] } = { body, event: 'COMMENT', ...(on.length ? { commit_id: sub!.revision!, comments: on.map(inlineOf) } : {}) }
    const dir = await mkdtemp(join(tmpdir(), 'combwork-review-'))
    try {
      const file = join(dir, 'review.json')
      await writeFile(file, JSON.stringify(payload), 'utf8')
      const r = await deps.gh({ host: source.host }, ['api', '--method', 'POST', `repos/${source.owner}/${source.repo}/pulls/${source.number}/reviews`, '--input', file], { json: true })
      return { r, body, listed }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
  let sent = await post(inline)
  if (!sent.r.ok && inline.length && sent.r.problem === 'failed') sent = await post([])
  if (!sent.r.ok) throw new Error(sent.r.detail ?? sent.r.problem)
  const j = (sent.r.json ?? {}) as { html_url?: unknown }
  const on = comments.length - sent.listed.length
  return { url: typeof j.html_url === 'string' ? j.html_url : null, body: sent.body, comments: comments.map((c) => c.id), inline: on, listed: sent.listed.length }
}

let started = false

/** Registers the `postGithubReview` action (index.ts, once): an Agent verdict's draft, posted by Combwork once its write commits. */
export function startGithubReviews(): void {
  if (started) return
  started = true
  onAction('postGithubReview', async (a, ws) => {
    const draft = Number(a.payload.draft)
    if (!Number.isInteger(draft)) return
    await postGithubReview(ws, a.card, { draft }, 'combwork').catch((e: unknown) => log.info(`#${a.card}'s review not posted to GitHub: ${userText(e instanceof Error ? e.message : String(e))}`))
  })
}
