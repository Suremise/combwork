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
import { PR_RETRY_GATE, type CardState, type PrNotPushedWhy, type PrOpenedData, type PrOpenFailedData, type PrRequestData } from '../../shared/workflow/facts'
import { FOR_YOU, PR_PROBLEM, workflowText } from '../../shared/workflow/texts'
import { checksAtRevision, type Workflow } from './runtime'
import type { CardRecord } from './factStore'
import { notApproved } from '../../shared/workflow/guards'
import { agentMsg, say } from '../../shared/agentText'
import { inDefaultDialect } from '../../shared/agentText/asyncScope'
import { HISTORY, storedText } from '../../shared/taskHistory'
import { prRefs, type PrView } from '../../shared/githubSource'

export type { PrView }

const log = createLogger('workflow')

/** The card's comment when its pull request closed without merging (HI-3552), as agents read it. */
const CLOSED = agentMsg({ id: 'runtime.pr.closed', text: 'Pull request #{number} was closed on GitHub without being merged: the card is back in Todo, its branch kept for its next start.', note: 'HI-3552: the comment on a card whose GitHub pull request was closed without merging. A statement of fact.' })

/** What runs gh: `gh` in the app, a stand-in in tests. */
export type GhPort = (target: GhTarget, args: string[], opts?: { json?: boolean; input?: string }) => Promise<GhResult>

/**
 * What the host reaches outside: gh, the push addresses of a remote (git's, insteadOf applied), and where a fork's head
 * repository is pushed to (HI-3562): tests' stand-ins.
 */
export interface PrPorts {
  gh: GhPort
  pushUrls: (project: string, remote: string) => Promise<string[] | null>
  forkTarget?: (project: string, head: { host: string; owner: string; repo: string }) => Promise<PushRoute>
}

/** A remote's push addresses as git would push to them (`insteadOf` and `pushInsteadOf` applied), or null unread. */
export async function remotePushUrls(project: string, remote: string): Promise<string[] | null> {
  const got = await git(project, ['remote', 'get-url', '--push', '--all', '--', remote])
  return got.ok ? got.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : null
}

/**
 * Where a push goes (HI-3562): the remote or address git is given and the addresses git pushes that to (null: unread);
 * or, for a fork, `rewrite`: a git url rewrite that applies to its address (or `unreadable`), and nothing is pushed.
 */
export interface PushRoute {
  target: string
  urls: string[] | null
  rewrite?: string
}

/** A `url.<base>.insteadOf` or `.pushInsteadOf` rule: its config key (`url.<base>.<kind>`) and the prefix it rewrites. */
export interface UrlRewrite {
  key: string
  prefix: string
}

/**
 * The rewrite rules of `git config --null --get-regexp '^url\..*\.(pushinsteadof|insteadof)$'` (each `<key>\n<prefix>\0`:
 * a base may hold spaces, HR1's round 2), or null when any entry can't be read: a rule left unread is never taken for none.
 */
export function urlRewrites(out: string): UrlRewrite[] | null {
  const rules: UrlRewrite[] = []
  for (const entry of out.split('\0')) {
    if (!entry) continue
    const at = entry.indexOf('\n')
    if (at <= 0 || !/^url\..+\.(pushinsteadof|insteadof)$/i.test(entry.slice(0, at))) return null
    rules.push({ key: entry.slice(0, at), prefix: entry.slice(at + 1) })
  }
  return rules
}

/**
 * HI-3562: a fork's head repository, pushed to by its address on its host (no remote of the project's is one). Combwork
 * doesn't work out where a git url rewrite (insteadOf or pushInsteadOf) would send it (the round-2 decision): when one
 * applies to that address, or git's configuration can't be read, nothing is pushed (`rewrite`, naming the rule), and the
 * user can push by hand. Else the push goes to that address itself, the one checked.
 */
/** PushRoute's `rewrite` when git's url rewrites couldn't be read (no rule's key is: each starts `url.`). */
export const UNREADABLE = 'unreadable'

export async function forkAddress(project: string, head: { host: string; owner: string; repo: string }): Promise<PushRoute> {
  const target = `https://${head.host}/${head.owner}/${head.repo}.git`
  const got = await git(project, ['config', '--null', '--get-regexp', '^url\\..*\\.(pushinsteadof|insteadof)$'])
  // Exit 1: none set.
  const rules = got.ok ? urlRewrites(got.out) : got.code === 1 ? [] : null
  if (!rules) return { target, urls: null, rewrite: UNREADABLE }
  const applies = rules.find((r) => target.startsWith(r.prefix))
  return applies ? { target, urls: null, rewrite: applies.key } : { target, urls: [target] }
}

const PORTS: PrPorts = { gh, pushUrls: remotePushUrls, forkTarget: forkAddress }

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
/** HI-3562: a pull request's head as GitHub has it now, read before a push back. */
const HEAD_FIELDS = 'number,url,state,isDraft,headRefName,headRefOid,headRepository,headRepositoryOwner,isCrossRepository,maintainerCanModify'

/** The pull request's head as gh views it (HEAD_FIELDS). */
interface HeadViewed {
  number: number
  url: string
  state: string
  isDraft: boolean
  headRefName: string
  headRefOid: string
  headRepository: { name?: string } | null
  headRepositoryOwner: { login?: string } | null
  isCrossRepository: boolean
  maintainerCanModify: boolean
}

/**
 * Whether the run's owner still holds it (prHosts.ts: its workspace's lifetime, as the merge queue's host and the action
 * worker take it, and the host not stopped): checked after every wait, before each effect and in each write, so a
 * workspace closed or switched (or the host stopped) meanwhile pushes, opens, writes and keeps nothing more.
 */
export type Alive = () => boolean
const ALWAYS: Alive = () => true

const running = new Map<string, { p: Promise<unknown>; alive: Alive }>()
/**
 * One run per card and kind in this process at a time: a second asks for the same run's result, unless that run's owner
 * has gone (it stops at its next check), when the new owner's starts.
 */
function once<T>(key: string, alive: Alive, fn: () => Promise<T>): Promise<T> {
  const was = running.get(key)
  if (was && was.alive()) return was.p as Promise<T>
  const p = fn().finally(() => {
    if (running.get(key)?.p === p) running.delete(key)
  })
  running.set(key, { p, alive })
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

/**
 * The request's authority (HR1, s9 point 1): still waiting, its submission the card's newest, and the card approved at
 * the current decision generation, not stale (the merge queue's own test, stillApproved and startAdvance, §16.9.1). A
 * decision, a new submission, a pass gone stale or an approval revoked since the request takes it away.
 */
function authority(wf: Workflow, card: CardRecord, s: CardState, request: string): PrRequestData | null {
  const r = waiting(s, request)
  if (!r || s.latest?.id !== r.submission) return null
  const rules = wf.rulesetOf(card, s)
  return (rules.options.review === 'none' ? !s.stale : !notApproved(s, rules, card.labels)) ? r : null
}

/**
 * HI-3590: a finish's push sends the one branch it names and nothing else. `--no-follow-tags` overrides the user's
 * `push.followTags`, which would otherwise publish every annotated tag reachable from the pushed commit that the remote
 * lacks (tags the user never chose to publish).
 */
const ONLY_THE_BRANCH = ['--no-follow-tags'] as const

/** The request's authority read in the workflow's lock, on the facts as they are now: before each push and create. */
const holds = (wf: Workflow, cardId: number, request: string, alive: Alive): Promise<boolean> => (alive() ? wf.write(wf.store.card(cardId), null, 'combwork', (w) => alive() && !!authority(wf, w.card, w.state(), request)) : Promise.resolve(false))

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

/**
 * The pull request of this request's head and base on its repository, opened since its cycle's first request, if any:
 * never one recorded for the card before (`earlier`: an earlier cycle's, closed), whenever it was created.
 */
async function findOpened(run: GhPort, r: PrRequestData, earlier: readonly number[]): Promise<Listed | null | GhResult> {
  const got = await run(pinned(r), ['pr', 'list', '--head', r.line, '--base', r.target, '--state', 'all', '--limit', '20', '--json', LIST_FIELDS], { json: true })
  if (!got.ok) return got
  const since = Date.parse(r.since)
  const ours = (Array.isArray(got.json) ? (got.json as Listed[]) : []).filter((p) => p && !p.isCrossRepository && p.headRefName === r.line && p.baseRefName === r.target && !earlier.includes(p.number) && Date.parse(p.createdAt) >= since - 60_000)
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
export function openPr(wf: Workflow, cardId: number, request: string, ports: PrPorts = PORTS, alive: Alive = ALWAYS): Promise<void> {
  return once(keyOf(wf, 'open', cardId), alive, () => opening(wf, cardId, request, ports, alive))
}

async function opening(wf: Workflow, cardId: number, request: string, ports: PrPorts, alive: Alive): Promise<void> {
  const run = ports.gh
  const r = alive() ? authority(wf, wf.store.card(cardId), wf.state(cardId), request) : null
  if (!r) return
  const fail = (problem: PrOpenFailedData['problem'], detail: string | null = null): Promise<void> => failed(wf, cardId, request, { request, problem, detail }, alive)
  if (!r.host || !r.remote) return fail('noLink')
  if (r.source) return pushingBack(wf, cardId, r, r.source, ports, alive, fail)
  // Found already (a create whose reply was lost, another Combwork's): recorded, never opened again.
  const earlier = wf.state(cardId).prsRecorded
  const found = await findOpened(run, r, earlier)
  if (found && 'ok' in found) return fail(ghProblem(found as Exclude<GhResult, { ok: true }>), (found as { detail?: string | null }).detail ?? null)
  if (found) return opened(wf, cardId, r, { number: found.number, url: found.url, draft: !!found.isDraft, recovered: true }, alive)
  const urls = await ports.pushUrls(wf.cfg.project, r.remote)
  if (!alive()) return
  if (!pushesTo(urls, r)) return fail('pushUrl')
  // Still the request it was, with its authority (a decision, a new submission, a move or a revoked approval may have
  // come meanwhile), read in the lock: else nothing is pushed.
  if (!(await holds(wf, cardId, request, alive))) return
  // That exact commit, never the line as it is now; never forced, so commits there from outside refuse it.
  const push = await git(wf.cfg.project, ['push', '--porcelain', ...ONLY_THE_BRANCH, '--', r.remote, `${r.revision}:refs/heads/${r.line}`], undefined, undefined, { timeout: platformLimits.gitNetworkMs() })
  if (!push.ok) return fail('push', firstLine(push.err) ?? firstLine(push.out))
  if (!(await holds(wf, cardId, request, alive))) return
  const card = wf.store.card(cardId)
  const draft = wf.cfg.options().prDraft !== false
  const made = await run(pinned(r), ['pr', 'create', '--head', r.line, '--base', r.target, '--title', `${card.key}: ${card.title}`, '--body-file', '-', ...(draft ? ['--draft'] : [])], { input: prBody(wf, wf.state(cardId), card, r) })
  if (made.ok) {
    const url = made.stdout.trim().split(/\r?\n/).reverse().find((l) => /\/pull\/\d+/.test(l))?.trim() ?? ''
    const number = Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? NaN)
    if (Number.isInteger(number)) return opened(wf, cardId, r, { number, url, draft }, alive)
  }
  // Its reply lost or unreadable: the pull request may be open all the same. Found, it is recorded; else it failed.
  const again = await findOpened(run, r, earlier)
  if (!alive()) return
  if (again && !('ok' in again)) return opened(wf, cardId, r, { number: again.number, url: again.url, draft: !!again.isDraft, recovered: true }, alive)
  if (made.ok) return fail('other', firstLine(made.stdout))
  return fail(ghProblem(made), made.detail)
}

/**
 * HI-3562: a pull request's card's fixes pushed back to the pull request it is about (the request's `source`), opening
 * none. The pull request is read again with gh, naming its base repository (its identity): open, still on the head branch
 * the card started on, and its head repository (a fork's) letting maintainers push. The push goes to that repository
 * (its push addresses checked as a remote's are), and only when GitHub's head (fetched when it isn't here) is in the
 * approved commit, so nothing pushed from outside is overwritten; never forced, so a branch moved since refuses it. Where
 * it can't push, nothing is pushed and the card says why (`notPushedWhy`, and a comment), still following the pull
 * request in PR open. gh unreadable, a push address elsewhere or git failing otherwise: a failure, asked to try again.
 */
async function pushingBack(wf: Workflow, cardId: number, r: PrRequestData, src: NonNullable<PrRequestData['source']>, ports: PrPorts, alive: Alive, fail: (problem: PrOpenFailedData['problem'], detail?: string | null) => Promise<void>): Promise<void> {
  const project = wf.cfg.project
  const got = await ports.gh(pinned(r), ['pr', 'view', String(src.number), '--json', HEAD_FIELDS], { json: true })
  if (!alive()) return
  if (!got.ok) return fail(ghProblem(got), got.detail)
  const v = (got.json && typeof got.json === 'object' ? got.json : null) as HeadViewed | null
  if (!v || v.number !== src.number) return fail('other', firstLine(got.stdout))
  const url = v.url || `https://${r.host}/${r.owner}/${r.repo}/pull/${src.number}`
  const oid = /^[0-9a-f]{40}$/.test(String(v.headRefOid)) ? v.headRefOid : null
  // `pushed` with nothing pushed: GitHub's head as read, else the head the card started on (its fork deleted, say).
  const kept = (why: PrNotPushedWhy, detail: string | null = null): Promise<void> => opened(wf, cardId, r, { number: src.number, url, draft: !!v.isDraft, pushed: oid ?? wf.state(cardId).started?.pr?.headOid ?? '', notPushed: why, detail }, alive)
  // Merged or closed (HR1's round 1): followed as it is, whatever is left of its head (a deleted fork has none).
  if (v.state !== 'OPEN') return kept('notOpen')
  // Open: a push is possible, so its head must be whole.
  const headOwner = v.headRepositoryOwner?.login
  const headName = v.headRepository?.name
  if (!oid || !headOwner || !headName) return fail('other', firstLine(got.stdout))
  const head = { host: r.host, owner: headOwner, repo: headName }
  const fork = !sameRepo(head, r)
  if (v.headRefName !== src.headRef || fork !== !!v.isCrossRepository) return kept('changed')
  if (fork && !v.maintainerCanModify) return kept('fork')
  // GitHub's head here (fetched from the pull request's own ref when it isn't), and in the approved commit.
  const here = async (): Promise<boolean> => (await git(project, ['cat-file', '-e', `${oid}^{commit}`])).ok
  if (!(await here())) {
    const ref = prRefs(src.number).head
    const f = await git(project, ['fetch', '--no-tags', '--no-write-fetch-head', '--', r.remote, `+refs/pull/${src.number}/head:${ref}`], undefined, undefined, { timeout: platformLimits.gitNetworkMs() })
    if (!alive()) return
    if (!f.ok) return fail('push', firstLine(f.err) ?? firstLine(f.out))
    // Moved again since it was read: read it again on the next try.
    if (!(await here())) return fail('other', null)
  }
  const inApproved = await git(project, ['merge-base', '--is-ancestor', oid, r.revision])
  if (!alive()) return
  if (!inApproved.ok) return inApproved.code === 1 ? kept('outside') : fail('other', firstLine(inApproved.err))
  if (oid === r.revision) return opened(wf, cardId, r, { number: src.number, url, draft: !!v.isDraft, pushed: r.revision }, alive)
  // Where it goes, read just before the push: the pull request's own repository through the project's remote, or the
  // fork's own address; every push address that repository.
  const at: PushRoute = fork ? await (ports.forkTarget ?? forkAddress)(project, head) : { target: r.remote, urls: await ports.pushUrls(project, r.remote) }
  if (!alive()) return
  if (at.rewrite) return at.rewrite === UNREADABLE ? kept('config') : kept('rewrite', at.rewrite)
  if (!pushesTo(at.urls, head)) return fail('pushUrl')
  if (!(await holds(wf, cardId, r.request, alive))) return
  // That exact commit to its head branch, never forced: a branch that moved since it was read refuses it.
  const push = await git(project, ['push', '--porcelain', ...ONLY_THE_BRANCH, '--', at.target, `${r.revision}:refs/heads/${src.headRef}`], undefined, undefined, { timeout: platformLimits.gitNetworkMs() })
  if (!alive()) return
  if (!push.ok) {
    const said = `${push.out}\n${push.err}`
    if (/\[rejected\]|non-fast-forward|fetch first|\(stale info\)/i.test(said)) return kept('refused', firstLine(push.err) ?? firstLine(push.out))
    return fail('push', firstLine(push.err) ?? firstLine(push.out))
  }
  return opened(wf, cardId, r, { number: src.number, url, draft: !!v.isDraft, pushed: r.revision }, alive)
}

/** The card's comment when its fixes weren't pushed back to its pull request (HI-3562), as agents read it. */
const NOT_PUSHED = agentMsg({
  id: 'runtime.pr.notPushed',
  text: "{card}'s fixes weren't pushed to pull request #{number}: {why, select, fork {it is from a fork whose author doesn't allow maintainers to push to it} outside {its branch on GitHub has commits the approved commit lacks, pushed from outside} refused {the push was refused, its branch having moved since it was read} notOpen {it isn't open on GitHub} rewrite {a git url rewrite, {rule}, applies to its fork's address, and Combwork doesn't push through one} config {git's url rewrites couldn't be read, and Combwork doesn't push without them} other {its head isn't the branch the card started on}}. Nothing was pushed; the card follows the pull request in PR open.",
  note: "HI-3562: the comment on a pull request's card whose approved fixes Combwork couldn't push to the pull request it is about. {why}: fork, outside, refused, notOpen, changed, rewrite (then {rule}, the git config key of the url rewrite, the user's own) or config. A statement of fact."
})

/** The comment's text for agents (in the default dialect, as a card comment is stored), by why (HI-3562). */
export const notPushedNotice = (card: string, number: number, why: PrNotPushedWhy, rule = ''): string => inDefaultDialect(() => say(NOT_PUSHED, { card, number, why, rule }))

/** Records the request's pull request and moves the card to PR open: once, while it is still that request's. */
async function opened(wf: Workflow, cardId: number, r: PrRequestData, pr: { number: number; url: string; draft: boolean; recovered?: boolean; pushed?: string; notPushed?: PrNotPushedWhy; detail?: string | null }, alive: Alive): Promise<void> {
  if (!alive()) return
  const data: PrOpenedData = { request: r.request, number: pr.number, url: pr.url, host: r.host, owner: r.owner, repo: r.repo, head: r.line, base: r.target, pushed: pr.pushed ?? r.revision, draft: pr.draft, ...(pr.recovered ? { recovered: true as const } : {}), ...(pr.notPushed ? { notPushed: true as const, notPushedWhy: pr.notPushed, ...(pr.detail ? { notPushedDetail: pr.detail } : {}) } : {}) }
  await wf.write(wf.store.card(cardId), null, 'combwork', (w) => {
    if (!alive() || !waiting(w.state(), r.request)) return
    w.fact('PrOpened', data) // i18n-ignore: a fact's kind, not text
    w.move('prOpen', 'derived')
    const why = pr.notPushed
    const rule = why === 'rewrite' ? (pr.detail ?? '') : ''
    if (why) w.action('comment', { text: notPushedNotice(w.card.key, pr.number, why, rule), shown: storedText(HISTORY.prNotPushed, { number: pr.number, why, rule }) })
  })
  log.info(`#${cardId}'s pull request #${pr.number} is open${pr.recovered ? ' (found again)' : ''}${pr.notPushed ? `, nothing pushed (${pr.notPushed})` : ''}`)
}

async function failed(wf: Workflow, cardId: number, request: string, d: PrOpenFailedData, alive: Alive): Promise<void> {
  if (!alive()) return
  await wf.write(wf.store.card(cardId), null, 'combwork', (w) => {
    const r = alive() ? waiting(w.state(), request) : null
    if (!r) return
    w.fact('PrOpenFailed', d) // i18n-ignore: a fact's kind, not text
    const why = workflowText(PR_PROBLEM, { problem: d.problem, remote: r.remote, owner: r.owner, repo: r.repo, host: r.host, line: r.line, detail: d.detail ?? '' })
    // {why} is a stored text of its own, said in the reader's language with it (storedLineText's nesting).
    wf.askUser(w, 'approve', PR_RETRY_GATE, workflowText(FOR_YOU.prRetry, { card: w.card.key, why: why as unknown as string }))
  })
  log.info(`#${cardId}'s pull request wasn't opened: ${d.problem} ${userText(d.detail ?? '')}`)
}

/** The last read of each card's pull request in this process, with the request whose pull request it read. */
const views = new Map<string, { request: string; view: PrView }>()
/** The last read of a card's pull request in this process, or null: only of the one it is on now (none in another cycle). */
export function prViewOf(wf: Workflow, cardId: number): PrView | null {
  const key = keyOf(wf, 'view', cardId)
  const was = views.get(key)
  if (!was) return null
  if (was.request === wf.state(cardId).pullRequest?.opened?.request) return was.view
  views.delete(key)
  return null
}

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
export function followPr(wf: Workflow, cardId: number, ports: Pick<PrPorts, 'gh'> = PORTS, alive: Alive = ALWAYS): Promise<PrView | null> {
  return once(keyOf(wf, 'follow', cardId), alive, () => following(wf, cardId, ports.gh, alive))
}

async function following(wf: Workflow, cardId: number, run: GhPort, alive: Alive): Promise<PrView | null> {
  const s = wf.state(cardId)
  const p = s.pullRequest?.opened
  if (!alive() || s.stage !== 'prOpen' || !p) return null
  const key = keyOf(wf, 'view', cardId)
  const got = await run(pinned(p), ['pr', 'view', String(p.number), '--json', VIEW_FIELDS], { json: true })
  // A reply for a pull request the card isn't on now (a later cycle's, a move meanwhile), or for an owner gone (its
  // workspace closed or switched, the host stopped): kept nowhere, written nowhere.
  const after = wf.state(cardId)
  if (!alive() || after.stage !== 'prOpen' || after.pullRequest?.opened?.request !== p.request) return null
  if (!got.ok || !got.json || typeof got.json !== 'object') {
    const was = prViewOf(wf, cardId)
    const view: PrView = was ? { ...was, stale: true } : { number: p.number, url: p.url, host: p.host, owner: p.owner, repo: p.repo, state: 'unknown', draft: p.draft, review: null, checks: { passed: 0, failed: 0, pending: 0 }, outside: false, at: Date.now(), stale: true }
    views.set(key, { request: p.request, view })
    return view
  }
  const v = got.json as Viewed
  const state = v.state === 'MERGED' ? 'merged' : v.state === 'CLOSED' ? 'closed' : 'open'
  const review = v.reviewDecision === 'APPROVED' ? 'approved' : v.reviewDecision === 'CHANGES_REQUESTED' ? 'changesRequested' : v.reviewDecision === 'REVIEW_REQUIRED' ? 'required' : null
  const view: PrView = { number: p.number, url: v.url || p.url, host: p.host, owner: p.owner, repo: p.repo, state, draft: !!v.isDraft, review, checks: checksOf(v.statusCheckRollup), outside: !!v.headRefOid && v.headRefOid !== p.pushed, at: Date.now() }
  views.set(key, { request: p.request, view })
  if (state === 'open') return view
  await wf.write(wf.store.card(cardId), null, 'outside', (w) => {
    const now = w.state()
    // Still this pull request (the request read), in PR open: else a later cycle's, and nothing is written.
    if (!alive() || now.stage !== 'prOpen' || now.pullRequest?.opened?.request !== p.request) return
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
