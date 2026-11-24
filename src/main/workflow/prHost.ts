// HI-3552: the pull request finish's host. A card whose project's finish is a pull request waits in Approved with a
// `PrRequested` (runtime.ts's requestPr: its approved revision, target, line and the project's GitHub repository, pinned
// when asked); this pushes that exact commit to the line on that repository and opens its pull request (a draft unless
// the project's options say ready), then moves it to PR open. Only Combwork pushes (HI-2843's decision): never forced,
// and only to a remote whose every push address is the pinned repository. A create whose reply was lost is found again
// (the cycle's pull request of that head and base, opened since its first request) rather than opened twice. A failure
// is recorded (`PrOpenFailed`) with a For you request to try again; the card stays in Approved.
//
// Following (followPr): GitHub can't tell a desktop app, so each card in PR open is read with gh when its board or card
// opens and on a timer: merged → Done (`Integrated`, GitHub's merge commit and the head it merged); closed without merging
// → Todo (`PrClosed`), its branch kept. Each transition is written under the workflow's lock, only while the card is
// still on the pull request that was read (its request), so a late reply from an earlier cycle changes nothing.
//
// Effects run once per card in this process at a time (`opening`, `following`); a second Combwork on the same workspace
// is held off by the writes (a pull request is recorded once per request) and by finding the one already opened.

import { gh, type GhResult, type GhTarget } from '../ghCli'
import { git } from '../git'
import { createLogger, userText } from '../logger'
import { platformLimits } from '../platform/limits'
import { parseGithubRemote } from '../../shared/githubRepo'
import { PR_RETRY_GATE, type CardState, type PrOpenedData, type PrOpenFailedData, type PrRequestData } from '../../shared/workflow/facts'
import { FOR_YOU, PR_PROBLEM, workflowText } from '../../shared/workflow/texts'
import { checksAtRevision, type Workflow } from './runtime'
import { agentMsg, say } from '../../shared/agentText'
import { inDefaultDialect } from '../../shared/agentText/asyncScope'
import { HISTORY, storedText } from '../../shared/taskHistory'
import type { PrView } from '../../shared/githubSource'

export type { PrView }

const log = createLogger('workflow')

/** The card's comment when its pull request closed without merging (HI-3552), as agents read it. */
const CLOSED = agentMsg({ id: 'runtime.pr.closed', text: 'Pull request #{number} was closed on GitHub without being merged: the card is back in Todo, its branch kept for its next start.', note: 'HI-3552: the comment on a card whose GitHub pull request was closed without merging. A statement of fact.' })

/** What runs gh: `gh` in the app, a stand-in in tests. */
export type GhPort = (target: GhTarget, args: string[], opts?: { json?: boolean; input?: string }) => Promise<GhResult>

/** What the host reaches outside: gh, and the push addresses of a remote (git's, insteadOf applied; tests' stand-ins). */
export interface PrPorts {
  gh: GhPort
  pushUrls: (project: string, remote: string) => Promise<string[] | null>
}

/** A remote's push addresses as git would push to them (`insteadOf` and `pushInsteadOf` applied), or null unread. */
export async function remotePushUrls(project: string, remote: string): Promise<string[] | null> {
  const got = await git(project, ['remote', 'get-url', '--push', '--all', '--', remote])
  return got.ok ? got.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : null
}

const PORTS: PrPorts = { gh, pushUrls: remotePushUrls }

/** A pull request as gh lists it (the fields asked for). */
interface Listed {
  number: number
  url: string
  createdAt: string
  headRefName: string
  baseRefName: string
  isCrossRepository: boolean
  isDraft?: boolean
}

const LIST_FIELDS = 'number,url,createdAt,headRefName,baseRefName,isCrossRepository,isDraft'
const VIEW_FIELDS = 'number,url,state,isDraft,reviewDecision,statusCheckRollup,headRefOid,mergeCommit,mergedAt,closedAt'

const running = new Map<string, Promise<unknown>>()
/** One run per card and kind in this process at a time: a second asks for the same run's result. */
function once<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const was = running.get(key) as Promise<T> | undefined
  if (was) return was
  const p = fn().finally(() => running.delete(key))
  running.set(key, p)
  return p
}
const keyOf = (wf: Workflow, kind: string, card: number): string => `${kind}:${wf.cfg.project.toLowerCase()}#${card}`

const pinned = (r: Pick<PrRequestData, 'host' | 'owner' | 'repo'>): GhTarget => ({ repo: { host: r.host, owner: r.owner, repo: r.repo } })
const sameRepo = (a: { host: string; owner: string; repo: string }, b: { host: string; owner: string; repo: string }): boolean => a.host.toLowerCase() === b.host.toLowerCase() && a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase()
const firstLine = (s: string): string | null => s.split(/\r?\n/).map((l) => l.trim()).find(Boolean)?.slice(0, 300) ?? null

/** A request still waiting to be opened: the card's newest, in Approved, with nothing opened or failed since. */
function waiting(s: CardState, request: string): PrRequestData | null {
  const p = s.pullRequest
  if (!p || p.requested.request !== request || p.opened || p.failed || s.stage !== 'approved') return null
  return p.requested
}

/** The pull request's body: the card, its builder's summary, the passing verdict, the checks that passed, the card's key. */
export function prBody(wf: Workflow, s: CardState, card: { key: string; title: string }, r: PrRequestData): string {
  const sub = s.submissions.find((x) => x.id === r.submission) ?? s.latest
  const pass = [...s.verdicts].reverse().find((v) => v.pass && v.submission === r.submission)
  const checks = checksAtRevision(s.checks, r.revision, wf.cfg.options().commands).filter((c) => c.result === 'passed').map((c) => c.name)
  // Posted to GitHub, in English as commit messages are (i18n-ignore below): the card's words are the user's own.
  const out = [`**${card.title}**`] // i18n-ignore: Markdown posted to GitHub
  if (sub?.summary.trim()) out.push('', sub.summary.trim())
  if (pass) out.push('', `Review: passed by ${pass.reviewer}. ${firstLine(pass.comment) ?? ''}`.trim()) // i18n-ignore: posted to GitHub, in English
  if (checks.length) out.push('', `Checks passed: ${checks.join(', ')}.`) // i18n-ignore: posted to GitHub, in English
  out.push('', `Combwork card ${card.key}.`) // i18n-ignore: posted to GitHub, in English
  return out.join('\n')
}

/** The pull request of this request's head and base on its repository, opened since its cycle's first request, if any. */
async function findOpened(run: GhPort, r: PrRequestData): Promise<Listed | null | GhResult> {
  const got = await run(pinned(r), ['pr', 'list', '--head', r.line, '--base', r.target, '--state', 'all', '--limit', '20', '--json', LIST_FIELDS], { json: true })
  if (!got.ok) return got
  const since = Date.parse(r.since)
  const ours = (Array.isArray(got.json) ? (got.json as Listed[]) : []).filter((p) => p && !p.isCrossRepository && p.headRefName === r.line && p.baseRefName === r.target && Date.parse(p.createdAt) >= since - 60_000)
  return ours.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0] ?? null
}

/** Whether every push address is the pinned repository (none read, or none: it isn't). Else nothing is pushed. */
export function pushesTo(urls: readonly string[] | null, r: Pick<PrRequestData, 'host' | 'owner' | 'repo'>): boolean {
  return !!urls && urls.length > 0 && urls.every((u) => {
    const at = parseGithubRemote(u)
    return !!at && sameRepo(at, r)
  })
}

const ghProblem = (g: Exclude<GhResult, { ok: true }>): PrOpenFailedData['problem'] => (g.problem === 'missing' ? 'ghMissing' : g.problem === 'signedOut' ? 'ghSignedOut' : 'other')

/**
 * Opens a request's pull request (the `openPr` action, and a workspace opening with one left waiting): see the top. Does
 * nothing for a request that is no longer the card's newest waiting one.
 */
export function openPr(wf: Workflow, cardId: number, request: string, ports: PrPorts = PORTS): Promise<void> {
  return once(keyOf(wf, 'open', cardId), () => opening(wf, cardId, request, ports))
}

async function opening(wf: Workflow, cardId: number, request: string, ports: PrPorts): Promise<void> {
  const run = ports.gh
  const r = waiting(wf.state(cardId), request)
  if (!r) return
  const fail = (problem: PrOpenFailedData['problem'], detail: string | null = null): Promise<void> => failed(wf, cardId, request, { request, problem, detail })
  if (!r.host || !r.remote) return fail('noLink')
  // Found already (a create whose reply was lost, another Combwork's): recorded, never opened again.
  const found = await findOpened(run, r)
  if (found && 'ok' in found) return fail(ghProblem(found as Exclude<GhResult, { ok: true }>), (found as { detail?: string | null }).detail ?? null)
  if (found) return opened(wf, cardId, r, { number: found.number, url: found.url, draft: !!found.isDraft, recovered: true })
  if (!pushesTo(await ports.pushUrls(wf.cfg.project, r.remote), r)) return fail('pushUrl')
  // Still the request it was (a decision, a new submission or a move may have come meanwhile): else nothing is pushed.
  if (!waiting(wf.state(cardId), request)) return
  // That exact commit, never the line as it is now; never forced, so commits there from outside refuse it.
  const push = await git(wf.cfg.project, ['push', '--porcelain', '--', r.remote, `${r.revision}:refs/heads/${r.line}`], undefined, undefined, { timeout: platformLimits.gitNetworkMs() })
  if (!push.ok) return fail('push', firstLine(push.err) ?? firstLine(push.out))
  if (!waiting(wf.state(cardId), request)) return
  const card = wf.store.card(cardId)
  const draft = wf.cfg.options().prDraft !== false
  const made = await run(pinned(r), ['pr', 'create', '--head', r.line, '--base', r.target, '--title', `${card.key}: ${card.title}`, '--body-file', '-', ...(draft ? ['--draft'] : [])], { input: prBody(wf, wf.state(cardId), card, r) })
  if (made.ok) {
    const url = made.stdout.trim().split(/\r?\n/).reverse().find((l) => /\/pull\/\d+/.test(l))?.trim() ?? ''
    const number = Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? NaN)
    if (Number.isInteger(number)) return opened(wf, cardId, r, { number, url, draft })
  }
  // Its reply lost or unreadable: the pull request may be open all the same. Found, it is recorded; else it failed.
  const again = await findOpened(run, r)
  if (again && !('ok' in again)) return opened(wf, cardId, r, { number: again.number, url: again.url, draft: !!again.isDraft, recovered: true })
  if (made.ok) return fail('other', firstLine(made.stdout))
  return fail(ghProblem(made), made.detail)
}

/** Records the request's pull request and moves the card to PR open: once, while it is still that request's. */
async function opened(wf: Workflow, cardId: number, r: PrRequestData, pr: { number: number; url: string; draft: boolean; recovered?: boolean }): Promise<void> {
  const data: PrOpenedData = { request: r.request, number: pr.number, url: pr.url, host: r.host, owner: r.owner, repo: r.repo, head: r.line, base: r.target, pushed: r.revision, draft: pr.draft, ...(pr.recovered ? { recovered: true as const } : {}) }
  await wf.write(wf.store.card(cardId), null, 'combwork', (w) => {
    if (!waiting(w.state(), r.request)) return
    w.fact('PrOpened', data) // i18n-ignore: a fact's kind, not text
    w.move('prOpen', 'derived')
  })
  log.info(`#${cardId}'s pull request #${pr.number} is open${pr.recovered ? ' (found again)' : ''}`)
}

async function failed(wf: Workflow, cardId: number, request: string, d: PrOpenFailedData): Promise<void> {
  await wf.write(wf.store.card(cardId), null, 'combwork', (w) => {
    const r = waiting(w.state(), request)
    if (!r) return
    w.fact('PrOpenFailed', d) // i18n-ignore: a fact's kind, not text
    const why = workflowText(PR_PROBLEM, { problem: d.problem, remote: r.remote, owner: r.owner, repo: r.repo, host: r.host, line: r.line, detail: d.detail ?? '' })
    // {why} is a stored text of its own, said in the reader's language with it (storedLineText's nesting).
    wf.askUser(w, 'approve', PR_RETRY_GATE, workflowText(FOR_YOU.prRetry, { card: w.card.key, why: why as unknown as string }))
  })
  log.info(`#${cardId}'s pull request wasn't opened: ${d.problem} ${userText(d.detail ?? '')}`)
}

const views = new Map<string, PrView>()
/** The last read of a card's pull request in this process, or null. */
export const prViewOf = (wf: Workflow, cardId: number): PrView | null => views.get(keyOf(wf, 'view', cardId)) ?? null

interface Viewed {
  number: number
  url: string
  state: string
  isDraft: boolean
  reviewDecision: string | null
  statusCheckRollup: { conclusion?: string | null; state?: string | null; status?: string | null }[] | null
  headRefOid: string
  mergeCommit: { oid: string } | null
  mergedAt: string | null
  closedAt: string | null
}

function checksOf(roll: Viewed['statusCheckRollup']): PrView['checks'] {
  const out = { passed: 0, failed: 0, pending: 0 }
  for (const c of roll ?? []) {
    const v = String(c.conclusion || c.state || c.status || '').toUpperCase()
    if (v === 'SUCCESS' || v === 'NEUTRAL' || v === 'SKIPPED') out.passed++
    else if (v === 'FAILURE' || v === 'ERROR' || v === 'CANCELLED' || v === 'TIMED_OUT' || v === 'ACTION_REQUIRED' || v === 'STARTUP_FAILURE') out.failed++
    else out.pending++
  }
  return out
}

/**
 * Reads a card's pull request in PR open and follows it (see the top): its view kept for the card, a merge or close
 * written. Null for a card with none to follow.
 */
export function followPr(wf: Workflow, cardId: number, ports: Pick<PrPorts, 'gh'> = PORTS): Promise<PrView | null> {
  return once(keyOf(wf, 'follow', cardId), () => following(wf, cardId, ports.gh))
}

async function following(wf: Workflow, cardId: number, run: GhPort): Promise<PrView | null> {
  const s = wf.state(cardId)
  const p = s.pullRequest?.opened
  if (s.stage !== 'prOpen' || !p) return null
  const key = keyOf(wf, 'view', cardId)
  const got = await run(pinned(p), ['pr', 'view', String(p.number), '--json', VIEW_FIELDS], { json: true })
  if (!got.ok || !got.json || typeof got.json !== 'object') {
    const was = views.get(key)
    const view: PrView = was ? { ...was, stale: true } : { number: p.number, url: p.url, host: p.host, owner: p.owner, repo: p.repo, state: 'unknown', draft: p.draft, review: null, checks: { passed: 0, failed: 0, pending: 0 }, outside: false, at: Date.now(), stale: true }
    views.set(key, view)
    return view
  }
  const v = got.json as Viewed
  const state = v.state === 'MERGED' ? 'merged' : v.state === 'CLOSED' ? 'closed' : 'open'
  const review = v.reviewDecision === 'APPROVED' ? 'approved' : v.reviewDecision === 'CHANGES_REQUESTED' ? 'changesRequested' : v.reviewDecision === 'REVIEW_REQUIRED' ? 'required' : null
  const view: PrView = { number: p.number, url: v.url || p.url, host: p.host, owner: p.owner, repo: p.repo, state, draft: !!v.isDraft, review, checks: checksOf(v.statusCheckRollup), outside: !!v.headRefOid && v.headRefOid !== p.pushed, at: Date.now() }
  views.set(key, view)
  if (state === 'open') return view
  await wf.write(wf.store.card(cardId), null, 'outside', (w) => {
    const now = w.state()
    // Still this pull request (the request read), in PR open: else a later cycle's, and nothing is written.
    if (now.stage !== 'prOpen' || now.pullRequest?.opened?.request !== p.request) return
    if (state === 'merged') {
      // What GitHub merged (its head, outside commits and all) and its merge commit; what Combwork pushed beside it.
      w.fact('Integrated', { revision: v.headRefOid || p.pushed, target: p.base, result: v.mergeCommit?.oid ?? v.headRefOid ?? p.pushed, method: 'pullRequest', by: 'github', platform: { pr: p.number, url: p.url, ...(p.notPushed ? { notPushed: true } : { pushed: p.pushed }) } }) // i18n-ignore: a fact's kind and codes, not text
      w.move('done', 'derived')
    } else {
      w.fact('PrClosed', { request: p.request, number: p.number, at: v.closedAt, by: null }) // i18n-ignore: a fact's kind, not text
      w.move('todo', 'derived')
      w.action('comment', { text: inDefaultDialect(() => say(CLOSED, { number: p.number })), shown: storedText(HISTORY.prClosed, { number: p.number }) })
    }
  })
  return view
}
