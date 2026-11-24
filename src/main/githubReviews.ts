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
import { gh, type GhResult } from './ghCli'
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
import { sameSource } from '../shared/githubSource'
import { approvalOf, boundedBody, foldGithubReviews, githubFooter, inHunks, inlineOf, listedComments, rowActions, stillAllowed, type DiffHunk, type GithubReviewRow, type GithubReviewsView, type InlineComment, type ThreadReply } from '../shared/githubReviews'
import { threadsOf } from '../shared/prFeedback'
import { githubFeedbackOf, githubFooterOf } from '../shared/workflow/options'
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
  approveChanged: msg({ id: 'github.review.approveChanged', defaultMessage: 'This card is now about another pull request than #{number} on {repo}, the one you confirmed: nothing was approved. Look at it again.', description: 'HI-3560: an error approving a card’s pull request: the card’s GitHub source changed while the user was asked (another window), so the pull request they confirmed isn’t the card’s now. {number} its number, {repo} owner/name.' }),
  approveFailed: msg({ id: 'github.review.approveFailed', defaultMessage: 'The GitHub CLI couldn’t approve pull request #{number}{why, select, none {} other {: {why}}}.', description: 'HI-3560: an error approving a card’s pull request on GitHub from its dialog. {number} its number; {why} the GitHub CLI’s own words (in English), or none (keep the select key).' }),
  noLink: msg({ id: 'github.review.noLink', defaultMessage: 'This project’s GitHub link no longer names {repo}, the pull request’s repository (Version Control → Workflow → GitHub).', description: 'HI-3559: an error posting a review: the project’s GitHub repository changed since the card’s pull request was set. {repo} is owner/name. Version Control → Workflow → GitHub is a place in the window.' })
}


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
  // HI-3560 (HR1's round 1): only an approval of the pull request the card is about now.
  const approved = approvalOf(facts, source)
  return { approved, feedback, footer: githubFooterOf(o), rows: rows.map((r) => ({ ...r, reviewerName: r.draft ? (who.get(r.draft.reviewer)?.name ?? null) : null, model: r.draft ? (who.get(r.draft.reviewer)?.model ?? null) : null, can: rowActions(feedback, 'user', r, { now: Date.now(), pending: !!r.draft && pendingPost(wf, card.id, r.draft.seq) }) })), openComments, canWrite: feedback !== 'agent', url: source.url }
}

/** Whether an automatic post of draft `draft` still waits to run (its action pending): no Post button for it meanwhile. */
const pendingPost = (wf: Workflow, card: number, draft: number): boolean => wf.store.pendingActions().some((a) => a.card === card && a.kind === 'postGithubReview' && Number(a.payload.draft) === draft)

/**
 * Posts a review to the card's pull request: row `row` (a draft's seq, or an own review's id to post it again; `body` the
 * text as the user has it now), or a new review of the user's (null). Claimed, posted, and its result written; the row as
 * it ends. Refused (thrown) when the option doesn't allow it, or it was posted or discarded, or is being posted.
 */
export async function postGithubReview(ws: WorkspaceService, n: number, req: { row: number | null; body?: string }, by: 'user' | 'combwork'): Promise<GithubReviewRow> {
  const { wf, projectPath } = await cardOf(ws, n)
  const row = await postReviewOn(wf, n, req, by, {
    link: async () => (await import('./githubLink')).githubRepoFor(ws, projectPath),
    comments: () => lineCommentsOf(ws, n),
    model: async (agent) => (await modelOf(ws, projectPath, agent)).model,
    reads: revisionReadsOf(platformIdOf(projectPath, (await ws.projectConfig(projectPath).catch(() => null))?.platform)),
    projectPath,
    gh,
    // HI-3554: a fix card's chosen review threads (its source's feedback), each replied to with the review.
    threads: async () => threadsOf((await (await import('./tasks')).getTask(n, ws)).sourceFeedback)
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
  /** The time now (tests: a posting's age). */
  now?: () => number
  /** HI-3554: the review threads (their first comments' ids) the card was made to address; none when absent. */
  threads?: () => Promise<number[]>
}

/** What came of sending: posted, refused by GitHub or never sent (safe to post again), or maybe on GitHub (check first). */
type Sent = { kind: 'posted'; url: string | null; body: string; comments: string[]; inline: number; listed: number; replies?: ThreadReply[] } | { kind: 'failed'; error: string } | { kind: 'uncertain'; error: string }

/** postGithubReview on card `n` of `wf`, with what it reads outside the facts given. */
export async function postReviewOn(wf: Workflow, n: number, req: { row: number | null; body?: string }, by: 'user' | 'combwork', deps: PostDeps): Promise<GithubReviewRow> {
  const card = wf.store.card(n)
  const source = card.source
  if (source?.kind !== 'pr') throw combworkError(M.notPr)
  const now = deps.now ?? Date.now
  const actor = by === 'combwork' ? 'combwork' : 'user'
  // Claimed under the store's lock, with the option read there too (HR1's round 1, finding 1): the row as it is, nothing
  // posting it already, and the text it sends kept with the claim (finding 3), so a failure keeps the user's edit.
  const claim = await wf.write(card, null, actor, (w) => {
    const feedback = githubFeedbackOf(wf.cfg.options())
    const rows = foldGithubReviews(w.tx.facts(card.id))
    const row = req.row === null ? null : (rows.find((r) => r.id === req.row) ?? null)
    if (req.row !== null && !row) throw combworkError(M.noDraft)
    if (row?.state === 'posted' || row?.state === 'discarded') throw combworkError(M.done, { state: row.state })
    const can = rowActions(feedback, by, row, { now: now(), pending: !!row?.draft && pendingPost(wf, card.id, row.draft.seq) })
    if (!can.post) {
      if (row?.state === 'posting') throw combworkError(M.done, { state: 'posting' })
      throw combworkError(M.notAllowed, { option: feedback, what: row?.draft ? 'draft' : 'own' })
    }
    const text = (req.body ?? row?.text ?? '').trim()
    const submission = row?.draft?.submission ?? row?.posting?.submission ?? w.state().latest?.id ?? null
    const posting = w.fact('GithubReviewPosting', { draft: row?.draft?.seq ?? null, ...(row && !row.draft ? { own: row.id } : {}), by, submission, body: text })
    return { posting: posting.seq, row, submission, text }
  })
  const draft = claim.row?.draft ?? null
  // Before each write to GitHub, with nothing awaited between it and the call: the option as it is now still allows it,
  // and this claim is still the row's latest (finding 1).
  const authority = (): string | null => {
    const row = foldGithubReviews(wf.store.facts(card.id)).find((r) => r.posting?.seq === claim.posting) ?? null
    const feedback = githubFeedbackOf(wf.cfg.options())
    return stillAllowed(feedback, by, row, claim.posting) ? null : combworkError(M.notAllowed, { option: feedback, what: draft ? 'draft' : 'own' }).message
  }
  let sent: Sent
  try {
    // The repository the card's pull request is on must still be the project's link: never posted elsewhere.
    const link = await deps.link()
    if (!link || link.host.toLowerCase() !== source.host.toLowerCase() || link.owner.toLowerCase() !== source.owner.toLowerCase() || link.repo.toLowerCase() !== source.repo.toLowerCase()) throw combworkError(M.noLink, { repo: `${source.owner}/${source.repo}` })
    const comments = claim.submission === null ? [] : deps.comments().filter((c) => c.state === 'open' && c.submission === claim.submission)
    if (!claim.text && !comments.length) throw combworkError(M.empty)
    const footer = draft && githubFooterOf(wf.cfg.options()) ? githubFooter((await deps.model(draft.reviewer)) ?? 'an AI agent') : null // i18n-ignore: posted to GitHub as written, in English
    sent = await send(wf, card.id, deps, source, claim.submission, claim.text, footer, comments, authority)
  } catch (e) {
    sent = { kind: 'failed', error: e instanceof Error ? e.message : String(e) }
  }
  // HI-3554: posted, a fix card's review also answers each review thread it was made to address, in that thread. Apart
  // from the review's own outcome (HR1's round 2): nothing a reply meets makes a posted review failed, or postable again.
  if (sent.kind === 'posted') {
    const threads = (await deps.threads?.().catch(() => [])) ?? []
    if (threads.length) sent.replies = await replyIn(deps, source, threads, sent.body, authority)
  }
  await wf.write(card, null, actor, (w) => {
    if (sent.kind === 'posted') {
      const { kind: _kind, ...done } = sent
      w.fact('GithubReviewPosted', { posting: claim.posting, ...done })
    } else w.fact('GithubReviewFailed', { posting: claim.posting, error: sent.error.slice(0, 1000), ...(sent.kind === 'uncertain' ? { uncertain: true as const } : {}) })
  })
  if (sent.kind !== 'posted') log.info(`#${n}'s review ${sent.kind === 'uncertain' ? 'may not have been' : 'not'} posted to GitHub: ${userText(sent.error)}`)
  const rows = foldGithubReviews(wf.store.facts(card.id))
  return rows.find((r) => r.posting?.seq === claim.posting)!
}

/** Discards a draft (never posted): the user's, while it isn't posted or being posted (one stuck in posting, after a while). */
export async function discardGithubReview(ws: WorkspaceService, n: number, draftSeq: number): Promise<void> {
  const { wf } = await cardOf(ws, n)
  await discardReviewOn(wf, n, draftSeq)
  boardChanged(ws)
}

/** discardGithubReview on card `n` of `wf` (`now`: a posting's age, for tests). */
export async function discardReviewOn(wf: Workflow, n: number, draftSeq: number, now: () => number = Date.now): Promise<void> {
  const card = wf.store.card(n)
  await wf.write(card, null, 'user', (w) => {
    const row = foldGithubReviews(w.tx.facts(card.id)).find((r) => r.draft?.seq === draftSeq)
    if (!row) throw combworkError(M.noDraft)
    const can = rowActions(githubFeedbackOf(wf.cfg.options()), 'user', row, { now: now(), pending: pendingPost(wf, card.id, draftSeq) })
    if (!can.discard) throw combworkError(M.done, { state: row.state === 'posted' || row.state === 'discarded' ? row.state : 'posting' })
    w.fact('GithubReviewDiscarded', { draft: draftSeq })
  })
}

/** gh's answer to a review's POST, read (HR1's round 1, finding 2): only a refusal GitHub said it made is safe to send again. */
function outcome(r: GhResult): { kind: 'posted'; url: string | null } | { kind: 'refused'; inline: boolean; error: string } | { kind: 'uncertain'; error: string } {
  if (r.ok) {
    try {
      const j = JSON.parse(r.stdout) as { html_url?: unknown; id?: unknown }
      if (j && typeof j === 'object') return { kind: 'posted', url: typeof j.html_url === 'string' ? j.html_url : null }
    } catch {
      // Below: GitHub took it, by gh's exit, but its answer can't be read.
    }
    return { kind: 'uncertain', error: M_UNREADABLE }
  }
  const error = r.detail ?? r.problem
  // Not sent at all: no gh, or no sign-in.
  if (r.problem === 'missing' || r.problem === 'signedOut') return { kind: 'refused', inline: false, error }
  // GitHub's own refusal (a 4xx): nothing made. 422 is its refusal of the request's contents, the inline comments too.
  if (r.problem === 'failed' && /\bHTTP 4\d\d\b/.test(error)) return { kind: 'refused', inline: /\bHTTP 422\b/.test(error), error }
  // Anything else (no answer in time, a server error, a broken connection): it may have been made.
  return { kind: 'uncertain', error }
}

/**
 * HI-3554 (the card's requirement, the Assistant on round 1): one reply per chosen review thread, on its first comment
 * (`POST …/pulls/<n>/comments/<id>/replies`, gh naming the host), its text the review's as posted, under the same
 * authority as the review (checked just before each). Each one's outcome kept; none is sent again by itself.
 */
async function replyIn(deps: PostDeps, source: { host: string; owner: string; repo: string; number: number }, threads: number[], body: string, authority: () => string | null): Promise<ThreadReply[]> {
  const out: ThreadReply[] = []
  for (const thread of threads) {
    let dir: string | null = null
    // Before gh was asked: refused (never sent); a throw from gh itself: it may have been sent.
    let asked = false
    try {
      dir = await mkdtemp(join(tmpdir(), 'combwork-reply-'))
      const file = join(dir, 'reply.json')
      await writeFile(file, JSON.stringify({ body }), 'utf8')
      const refused = authority()
      if (refused) {
        out.push({ thread, error: refused })
        continue
      }
      asked = true
      const said = outcome(await deps.gh({ host: source.host }, ['api', '--method', 'POST', `repos/${source.owner}/${source.repo}/pulls/${source.number}/comments/${thread}/replies`, '--input', file]))
      out.push(said.kind === 'posted' ? { thread, url: said.url } : { thread, error: said.error.slice(0, 500), ...(said.kind === 'uncertain' ? { uncertain: true as const } : {}) })
    } catch (e) {
      // Each reply's failure is its own (HR1's round 2): kept, the others still sent, the review posted as it was.
      out.push({ thread, error: (e instanceof Error ? e.message : String(e)).slice(0, 500), ...(asked ? { uncertain: true as const } : {}) })
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
  return out
}

/** Said when gh took a review but its answer couldn't be read (English: gh's own words are too, in the same field). */
const M_UNREADABLE = 'GitHub’s answer couldn’t be read: check the pull request before posting again.' // i18n-ignore: stored beside gh's own English words, shown as they are

/**
 * The review made and sent: the line comments that can sit on GitHub's diff inline (the reviewed revision is the pull
 * request's head as its start fetched it, and the lines are in a hunk of that file's change), the rest listed in the body.
 * GitHub refusing it as unprocessable (422) with inline comments sends it again with all listed; any other failure isn't
 * sent again. Each write is made only while `authority` holds, checked just before it.
 */
async function send(wf: Workflow, cardId: number, deps: PostDeps, source: { host: string; owner: string; repo: string; number: number }, submission: number | null, text: string, footer: string | null, comments: LineCommentView[], authority: () => string | null): Promise<Sent> {
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
    const body = boundedBody(text, listedComments(listed), footer)
    const payload: { body: string; event: 'COMMENT'; commit_id?: string; comments?: InlineComment[] } = { body, event: 'COMMENT', ...(on.length ? { commit_id: sub!.revision!, comments: on.map(inlineOf) } : {}) }
    const dir = await mkdtemp(join(tmpdir(), 'combwork-review-'))
    try {
      const file = join(dir, 'review.json')
      await writeFile(file, JSON.stringify(payload), 'utf8')
      const refused = authority()
      if (refused) return { body, listed, said: { kind: 'refused' as const, inline: false, error: refused } }
      const r = await deps.gh({ host: source.host }, ['api', '--method', 'POST', `repos/${source.owner}/${source.repo}/pulls/${source.number}/reviews`, '--input', file])
      return { body, listed, said: outcome(r) }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
  let sent = await post(inline)
  if (sent.said.kind === 'refused' && sent.said.inline && inline.length) sent = await post([])
  if (sent.said.kind === 'refused') return { kind: 'failed', error: sent.said.error }
  if (sent.said.kind === 'uncertain') return { kind: 'uncertain', error: sent.said.error }
  return { kind: 'posted', url: sent.said.url, body: sent.body, comments: comments.map((c) => c.id), inline: comments.length - sent.listed.length, listed: sent.listed.length }
}

/**
 * HI-3560 (HI-3541's decision: the user's accept): approves the card's pull request on GitHub as the user's own account
 * (`gh pr review <n> --approve -R host/owner/repo`), a fork's too; the user's alone (IPC), asked first in the window.
 * Only while the project's GitHub link still names the pull request's repository. Merging stays the user's, on GitHub:
 * Combwork never merges it. Written as a fact once GitHub took it; gh's words thrown otherwise.
 */
export async function approveGithubPr(ws: WorkspaceService, n: number, target: PrTarget): Promise<void> {
  const { wf, projectPath } = await cardOf(ws, n)
  await approveOn(wf, n, target, { link: async () => (await import('./githubLink')).githubRepoFor(ws, projectPath), gh })
  boardChanged(ws)
}

/** The pull request the user confirmed approving (HR1's round 1): its repository on its host, and its number. */
export interface PrTarget {
  host: string
  owner: string
  repo: string
  number: number
}

/**
 * approveGithubPr on card `n` of `wf`, with the link and gh given: only the pull request the user confirmed (`target`),
 * while the card is still about it (checked first, and again after the link's read, just before gh is asked), and
 * recorded with its whole identity.
 */
export async function approveOn(wf: Workflow, n: number, target: PrTarget, deps: Pick<PostDeps, 'link' | 'gh'>): Promise<void> {
  const still = (): void => {
    const source = wf.store.card(n).source
    if (source?.kind !== 'pr') throw combworkError(M.notPr)
    if (!sameSource(source, { kind: 'pr', ...target })) throw combworkError(M.approveChanged, { number: target.number, repo: `${target.owner}/${target.repo}` })
  }
  still()
  const link = await deps.link()
  if (!link || link.host.toLowerCase() !== target.host.toLowerCase() || link.owner.toLowerCase() !== target.owner.toLowerCase() || link.repo.toLowerCase() !== target.repo.toLowerCase()) throw combworkError(M.noLink, { repo: `${target.owner}/${target.repo}` })
  // The card's source again, nothing awaited between this and gh: a change meanwhile approves nothing.
  still()
  const r = await deps.gh({ repo: { host: target.host, owner: target.owner, repo: target.repo } }, ['pr', 'review', String(target.number), '--approve'])
  if (!r.ok) throw combworkError(M.approveFailed, { number: target.number, why: r.detail ?? 'none' }) // i18n-ignore: a select key (none), gh's own words otherwise
  await wf.write(wf.store.card(n), null, 'user', (w) => {
    w.fact('GithubPrApproved', { host: target.host, owner: target.owner, repo: target.repo, number: target.number })
  })
}

let started = false

/**
 * Registers the `postGithubReview` action (index.ts, once): an Agent verdict's draft, posted by Combwork once its write
 * commits, never sent again by itself. One that never ran (a close before it) shows Post on the card (rowActions).
 */
export function startGithubReviews(): void {
  if (started) return
  started = true
  onAction('postGithubReview', async (a, ws) => {
    const row = Number(a.payload.draft)
    if (!Number.isInteger(row)) return
    await postGithubReview(ws, a.card, { row }, 'combwork').catch((e: unknown) => log.info(`#${a.card}'s review not posted to GitHub: ${userText(e instanceof Error ? e.message : String(e))}`))
  })
}
