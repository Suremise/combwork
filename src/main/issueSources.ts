// A project's issue source (HI-3555, HI-2844's design; shared/issueSource.ts has the seam): only GitHub's, through the
// gh service (ghCli.ts) on the project's GitHub link (HI-3550). It lists open issues, reads one to pull it in as a card
// (tasks.ts' createFromIssue), and closes shipped ones "Fixed in <version>" once their release is published, which is
// the only write, and only from the user's click (Close Shipped Issues…). Nothing here comments on an issue as its card
// moves: issues are public, and gh posts as the user.

import { msg } from '../shared/i18n/msg'
import type { GithubRepoRef } from '../shared/githubRepo'
import { cleanSource, clipBody } from '../shared/githubSource'
import { cleanIssueQuery, cleanPreview, closeAuthorised, fixedInComment, issueCardLabels, OPEN_ISSUES_LIMIT, samePreview, versionOfLine, type CloseOutcome, type IssueSource, type OpenIssuesRead, type ReleasedLine, type ShippedIssue, type PreviewPairs, type ShippedIssuesRead, type ShippedPreview } from '../shared/issueSource'
import { combworkError } from './combworkError'
import { gh } from './ghCli'
import { githubRepoFor } from './githubLink'
import { createLogger, userText } from './logger'
import { isUnknown } from './platform/types'
import type { WorkspaceService } from './workspace'

const log = createLogger('github')

const sameRepo = (a: GithubRepoRef, b: GithubRepoRef): boolean => `${a.host}/${a.owner}/${a.repo}`.toLowerCase() === `${b.host}/${b.owner}/${b.repo}`.toLowerCase()

/** gh's words for a release or ref GitHub says isn't there (`release not found`, `HTTP 404`): positive evidence, unlike other failures. */
const NOT_FOUND = /release not found|HTTP 404|\(404\)|Not Found/i

const str = (o: Record<string, unknown>, k: string): string => (typeof o[k] === 'string' ? (o[k] as string) : '')
const loginOf = (v: unknown): string | null => (v && typeof v === 'object' && typeof (v as { login?: unknown }).login === 'string' ? (v as { login: string }).login : null)
const namesOf = (v: unknown, key: 'name' | 'login'): string[] => (Array.isArray(v) ? v.map((x) => (x && typeof x === 'object' && typeof (x as Record<string, unknown>)[key] === 'string' ? ((x as Record<string, unknown>)[key] as string) : '')).filter(Boolean) : [])

/** GitHub's issues of one repository, through gh: every call names the repository (`-R`) or its host. */
export function githubIssues(repo: GithubRepoRef): IssueSource {
  const name = `${repo.owner}/${repo.repo}`
  return {
    repo,
    async list(q) {
      const query = cleanIssueQuery(q)
      const args = ['issue', 'list', '--state', 'open', '--limit', String(OPEN_ISSUES_LIMIT), '--json', 'number,title,url,author,labels,assignees']
      if (query.search) args.push('--search', query.search)
      if (query.label) args.push('--label', query.label)
      if (query.assignee) args.push('--assignee', query.assignee)
      const r = await gh({ repo }, args, { json: true })
      if (!r.ok) return r
      const rows = Array.isArray(r.json) ? (r.json as Record<string, unknown>[]) : []
      const issues = rows
        .filter((o) => o && typeof o === 'object' && Number.isInteger(o.number) && (o.number as number) > 0)
        .map((o) => ({ number: o.number as number, title: str(o, 'title'), url: str(o, 'url'), author: loginOf(o.author), labels: namesOf(o.labels, 'name'), assignees: namesOf(o.assignees, 'login') }))
      return { ok: true, issues }
    },
    async read(number) {
      const r = await gh({ repo }, ['issue', 'view', String(number), '--json', 'number,title,url,author,body,labels,state,comments'], { json: true })
      if (!r.ok) return r
      const j = (r.json ?? {}) as Record<string, unknown>
      const login = loginOf(j.author)
      // The author's standing in the repository: the REST answer's author_association (gh's `issue view` doesn't give it).
      const association = login ? await gh({ host: repo.host }, ['api', `repos/${name}/issues/${number}`, '--jq', '.author_association']).then((a) => (a.ok && /^[A-Z_]{1,40}$/.test(a.stdout.trim()) ? a.stdout.trim() : null)) : null
      const source = cleanSource({ kind: 'issue', ...repo, number, url: str(j, 'url') || `https://${repo.host}/${name}/issues/${number}`, title: str(j, 'title'), ...(login ? { author: { login, association } } : {}) })
      if (!source || j.number !== number) return { ok: false, problem: 'failed', detail: null }
      return { ok: true, issue: { source, body: clipBody(j.body), labels: issueCardLabels(namesOf(j.labels, 'name')) }, state: String(j.state).toUpperCase() === 'CLOSED' ? 'closed' : 'open', comments: Array.isArray(j.comments) ? j.comments.map((c) => (c && typeof c === 'object' && typeof (c as { body?: unknown }).body === 'string' ? (c as { body: string }).body : '')) : [] }
    },
    async published(tag) {
      const r = await gh({ repo }, ['release', 'view', tag, '--json', 'isDraft,url'], { json: true })
      // HR1's round 2: only GitHub saying there is no such release is "not published"; any other failure (a 502, a rate
      // limit, a refusal, an answer that can't be read) can't tell, and stays unreadable.
      if (!r.ok) return r.problem === 'failed' && NOT_FOUND.test(r.detail ?? '') ? { ok: true, published: false, url: null, commit: null } : r
      const j = (r.json ?? {}) as Record<string, unknown>
      if (typeof j.isDraft !== 'boolean') return { ok: false, problem: 'failed', detail: null }
      // HR1's round 1: the commit GitHub's own tag names, peeled through annotated tag objects (a few at most).
      const ref = await gh({ host: repo.host }, ['api', `repos/${name}/git/ref/tags/${tag}`], { json: true })
      if (!ref.ok && !(ref.problem === 'failed' && NOT_FOUND.test(ref.detail ?? ''))) return ref
      let object = ref.ok ? ((ref.json as { object?: { type?: unknown; sha?: unknown } } | null)?.object ?? null) : null
      for (let i = 0; object && object.type === 'tag' && typeof object.sha === 'string' && i < 4; i++) {
        const t = await gh({ host: repo.host }, ['api', `repos/${name}/git/tags/${object.sha}`], { json: true })
        if (!t.ok) return t.problem === 'failed' ? { ok: false, problem: 'failed', detail: t.detail } : t
        object = (t.json as { object?: { type?: unknown; sha?: unknown } } | null)?.object ?? null
      }
      const commit = object && object.type === 'commit' && typeof object.sha === 'string' && /^[0-9a-f]{40}$/i.test(object.sha) ? object.sha.toLowerCase() : null
      return { ok: true, published: j.isDraft === false, url: str(j, 'url') || null, commit }
    },
    async close(number, comment) {
      const r = await gh({ repo }, ['issue', 'close', String(number), '--reason', 'completed', ...(comment === null ? [] : ['--comment', comment])])
      return r.ok ? { ok: true } : r
    }
  }
}

/** The project's issue source (its GitHub link's repository), or null with no link. */
export async function issueSourceFor(ws: WorkspaceService, projectPath: string): Promise<IssueSource | null> {
  const repo = await githubRepoFor(ws, projectPath)
  return repo ? githubIssues(repo) : null
}

/** The board's From GitHub… Issues tab: the open issues as narrowed, each with the card not archived already about it. */
export async function openIssuesOf(ws: WorkspaceService, projectPath: string, q: unknown): Promise<OpenIssuesRead> {
  const src = await issueSourceFor(ws, projectPath)
  if (!src) return { repo: null, problem: 'noLink', detail: null }
  const r = await src.list(cleanIssueQuery(q))
  if (!r.ok) return { repo: src.repo, problem: r.problem, detail: r.detail }
  const { issueSourceCards } = await import('./boardStore')
  const cards = new Map(issueSourceCards(ws, src.repo).filter((c) => !c.archived).map((c) => [c.issue, c.n]))
  return { repo: src.repo, issues: r.issues.map((i) => ({ ...i, card: cards.get(i.number) ?? null })) }
}

// --- Close at publish ----------------------------------------------------------------------------------------------

const T = {
  notReleased: msg({ id: 'github.issues.notReleased', defaultMessage: '{line} isn’t released: no tag v{line} or {line} in its history, merged into the default branch.', description: 'HI-3555: an error from Close Shipped Issues…: the branch chosen isn’t released yet (HI-3148’s reading: a tag named after it in its history, and merged into the default branch). {line} is a branch name such as 1.7.0.' }),
  notPublished: msg({ id: 'github.issues.notPublished', defaultMessage: 'The release {tag} isn’t published on GitHub yet: publish it first, then close its issues.', description: 'HI-3555: an error from Close Shipped Issues…: the release isn’t published on GitHub (a draft, or none), and issues are closed only once it is. {tag} is the release’s tag, such as v1.7.0.' }),
  tagMismatch: msg({ id: 'github.issues.tagMismatch', defaultMessage: 'The release {tag} on GitHub names another commit than this repository’s {tag}: fetch its tags, or look at the release, before closing its issues.', description: 'HI-3555: an error from Close Shipped Issues…: the published release’s tag on GitHub and the project’s own tag of that name are at different commits, so what it shipped can’t be told and nothing was closed. {tag} is the tag, such as v1.7.0.' }),
  changed: msg({ id: 'github.issues.changed', defaultMessage: 'What {line} shipped has changed since it was shown: look at it again.', description: 'HI-3555: an error from Close Shipped Issues…: the repository, the release’s tag or the cards it shipped changed after the list was shown, so nothing was closed. {line} is a branch name such as 1.7.0.' })
}

type Reads = NonNullable<ReturnType<typeof import('./platform/releaseReadsPorts').releaseReadsOf>>
type History = NonNullable<ReturnType<typeof import('./platform/historyPorts').historyOf>>

/** The project's release and history reads (null: a platform without them, where nothing is ever shipped). */
async function portsOf(ws: WorkspaceService, projectPath: string): Promise<{ reads: Reads; history: History } | null> {
  const { releaseReadsOf } = await import('./platform/releaseReadsPorts')
  const { historyOf } = await import('./platform/historyPorts')
  const { projectPlatform } = await import('./platform/registry')
  const id = projectPlatform(projectPath, (await ws.projectConfig(projectPath)).platform).id
  const reads = releaseReadsOf(id)
  const history = historyOf(id)
  return reads?.tagged && history ? { reads, history } : null
}

/** A Done card (archived ones too) of the project with an issue source on the repository, and its Integrated facts. */
interface IssueCard {
  card: number
  issue: number
  url: string
  integrated: { target: string; result: string }[]
}

async function issueCards(ws: WorkspaceService, projectPath: string, repo: GithubRepoRef): Promise<IssueCard[]> {
  const { issueSourceCards } = await import('./boardStore')
  const { workflowFor } = await import('./workflow/service')
  const { getTask } = await import('./tasks')
  const wf = await workflowFor(ws, projectPath).catch(() => null)
  if (!wf) return []
  const out: IssueCard[] = []
  for (const c of issueSourceCards(ws, repo)) {
    const card = await getTask(c.n, ws).catch(() => null)
    if (!card || card.column !== 'done' || !card.source || (card.project ?? '').toLowerCase() !== wf.store.scope.project.toLowerCase()) continue
    const integrated = wf.store.facts(c.n).flatMap((f) => {
      const d = f.data as { target?: unknown; result?: unknown }
      return f.kind === 'Integrated' && typeof d.target === 'string' && typeof d.result === 'string' && d.result ? [{ target: d.target, result: d.result }] : []
    })
    if (integrated.length) out.push({ card: c.n, issue: c.issue, url: card.source.url, integrated })
  }
  return out.sort((a, b) => a.card - b.card)
}

/**
 * A line's release, as Close Shipped Issues… takes it: released by HI-3148's reading, or, its branch deleted after its
 * release, its tag's commit in the main line; with the tag and the commit it names. Null: not released, or unreadable.
 */
async function releaseOf(p: { reads: Reads }, projectPath: string, line: string): Promise<ReleasedLine | null> {
  const t = await p.reads.tagged!(projectPath, line)
  if (isUnknown(t) || !t) return null
  const r = await p.reads.released(projectPath, line)
  if (isUnknown(r)) return null
  if (r) return r.tag === t.tag ? { line, tag: t.tag, commit: t.commit } : null
  const there = await p.reads.exists(projectPath, line)
  return !isUnknown(there) && !there && t.inMain ? { line, tag: t.tag, commit: t.commit } : null
}

/**
 * The project's released lines Close Shipped Issues… offers: Work merges into, Other branches work can merge into, and
 * every line a card with an issue source was integrated into (a release branch taken off the options, or deleted, still
 * counts by its tag).
 */
export async function releasedLines(ws: WorkspaceService, projectPath: string, repo: GithubRepoRef): Promise<ReleasedLine[]> {
  const p = await portsOf(ws, projectPath)
  if (!p) return []
  const { projectTargets } = await import('./workflow/targets')
  const t = await projectTargets(ws, projectPath).catch(() => null)
  const lines = new Set<string>(t ? [t.default, ...t.others] : [])
  for (const c of await issueCards(ws, projectPath, repo)) for (const i of c.integrated) lines.add(i.target)
  // HR1 on s16: the release tags themselves, so a release no option or card names (a patch tagged on main) is found.
  const tagged = p.reads.releaseTagLines ? await p.reads.releaseTagLines(projectPath) : []
  if (!isUnknown(tagged)) for (const l of tagged) lines.add(l)
  const out: ReleasedLine[] = []
  for (const line of lines) {
    const r = await releaseOf(p, projectPath, line)
    if (r) out.push(r)
  }
  return out
}

/**
 * The cards that shipped in `release` (HR1 on s9: against the tagged commit, never a branch name): each Done issue card
 * some Integrated result of which is in the release's commit, whatever line it merged into (a patch merged into main
 * counts), and none of which is in an earlier release's (the tag of another line it merged into, or of another released
 * line, that is itself in this one), so a later release never takes what an earlier one shipped. A containment that
 * can't be read leaves the card out (never closed on doubt). By card number.
 */
async function shippedCards(ws: WorkspaceService, projectPath: string, p: { reads: Reads; history: History }, src: IssueSource, release: ReleasedLine, lines: ReleasedLine[]): Promise<IssueCard[]> {
  const repo = src.repo
  const known = new Map<string, boolean | null>()
  const contains = async (commit: string, a: string): Promise<boolean | null> => {
    const k = `${a}>${commit}`
    if (!known.has(k)) {
      const r = await p.history.isAncestor(projectPath, a, commit)
      known.set(k, isUnknown(r) ? null : r)
    }
    return known.get(k)!
  }
  const tags = new Map<string, { tag: string; commit: string } | null>(lines.map((l) => [l.line, { tag: l.tag, commit: l.commit }]))
  const tagOf = async (line: string): Promise<{ tag: string; commit: string } | null> => {
    if (!tags.has(line)) {
      const t = await p.reads.tagged!(projectPath, line)
      tags.set(line, !isUnknown(t) && t ? { tag: t.tag, commit: t.commit } : null)
    }
    return tags.get(line)!
  }
  /**
   * HR1's round 1: an earlier release counts only once GitHub proves it published, its tag there at the same commit (a
   * draft, an RC never published, a tag GitHub hasn't: not a release, so it takes nothing away). Null: can't be told.
   */
  const releasedBefore = new Map<string, boolean | null>()
  const isReleasedBefore = async (t: { tag: string; commit: string }): Promise<boolean | null> => {
    if (!releasedBefore.has(t.tag)) {
      const r = await src.published(t.tag)
      releasedBefore.set(t.tag, !r.ok ? null : !r.published ? false : r.commit === t.commit.toLowerCase() ? true : null)
    }
    return releasedBefore.get(t.tag)!
  }
  const out: IssueCard[] = []
  next: for (const c of await issueCards(ws, projectPath, repo)) {
    let inThis = false
    for (const i of c.integrated) {
      const r = await contains(release.commit, i.result)
      if (r === null) continue next
      inThis ||= r
    }
    if (!inThis) continue
    const others = new Set<string>([...c.integrated.map((i) => i.target), ...lines.map((l) => l.line)])
    others.delete(release.line)
    for (const o of others) {
      const t = await tagOf(o)
      if (!t || t.commit === release.commit) continue
      const earlier = await contains(release.commit, t.commit)
      if (earlier === null) continue next
      if (!earlier) continue
      let inIt = false
      for (const i of c.integrated) {
        const r = await contains(t.commit, i.result)
        if (r === null) continue next
        inIt ||= r
      }
      if (!inIt) continue
      // In an earlier tag: left out if that release is published, kept if it isn't, left out on doubt.
      const shipped = await isReleasedBefore(t)
      if (shipped !== false) continue next
    }
    out.push(c)
  }
  return out
}

/** Close Shipped Issues… for `line`: its release (tag, commit, published on GitHub or not) and its shipped issues now. */
export async function shippedIssuesOf(ws: WorkspaceService, projectPath: string, line: string): Promise<ShippedIssuesRead> {
  const src = await issueSourceFor(ws, projectPath)
  if (!src) return { repo: null, problem: 'noLink', detail: null }
  const p = await portsOf(ws, projectPath)
  const lines = await releasedLines(ws, projectPath, src.repo)
  const rel = lines.find((r) => r.line === line)
  if (!p || !rel) return { repo: src.repo, problem: 'notReleased', detail: null }
  const pub = await src.published(rel.tag)
  if (!pub.ok) return { repo: src.repo, problem: pub.problem, detail: pub.detail }
  // HR1's round 1: a published release is judged by GitHub's own tag, which must be the commit containment is read at.
  if (pub.published && pub.commit !== rel.commit.toLowerCase()) return { repo: src.repo, problem: 'tagMismatch', detail: null }
  const issues: ShippedIssue[] = []
  for (const c of await shippedCards(ws, projectPath, p, src, rel, lines)) {
    const r = await src.read(c.issue)
    issues.push({ card: c.card, issue: c.issue, url: c.url, state: r.ok ? r.state : 'unknown' })
  }
  return { repo: src.repo, line, tag: rel.tag, commit: rel.commit, version: versionOfLine(line), published: pub.published, releaseUrl: pub.url, issues }
}

/** One close at a time per project: a second click waits for the first, then finds its work done (read back). */
const closing = new Map<string, Promise<unknown>>()

/**
 * The close at publish (HI-2844's decision; the user's click only, never an agent's or the Assistant's): the issues of
 * `preview`, the list the user was shown, each closed "Fixed in <version>". Refused, nothing written, unless the workspace
 * is still open, the project still links that repository, the line's release is still that tag at that commit and is
 * published on GitHub (that repository's), and the shipped cards are those shown. Each issue (one per number, however
 * many cards link it) is read back first: closed already is left; one the preview showed closed (not counted on the
 * button) and open now is stopped, unwritten (HI-3588); a "Fixed in <version>" comment already there (an
 * attempt that commented but didn't close) closes it without another; after a failure it is read again, and only a
 * closed read counts as closed (unreadable: unknown). One failure doesn't stop the rest.
 */
export async function closeShippedIssues(ws: WorkspaceService, projectPath: string, raw: unknown): Promise<CloseOutcome[]> {
  const preview = cleanPreview(raw)
  if (!preview) throw combworkError(T.changed, { line: '?' }, { kind: 'invalid' })
  // HR1's round 1: the caller's workspace, taken now, before the turn waits: one closed meanwhile stays closed, even reopened.
  const owner = { life: ws.lifetime, path: ws.path }
  const key = projectPath.toLowerCase()
  const before = closing.get(key) ?? Promise.resolve()
  const turn = before.catch(() => undefined).then(() => closeLocked(ws, projectPath, preview, owner))
  closing.set(key, turn)
  try {
    return await turn
  } finally {
    if (closing.get(key) === turn) closing.delete(key)
  }
}

async function closeLocked(ws: WorkspaceService, projectPath: string, preview: ShippedPreview, owner: { life: AbortSignal; path: string | null }): Promise<CloseOutcome[]> {
  const open = (): boolean => !owner.life.aborted && ws.lifetime === owner.life && ws.path === owner.path
  const { line } = preview
  const src = await issueSourceFor(ws, projectPath)
  const p = await portsOf(ws, projectPath)
  if (!src || !p || !open()) throw combworkError(T.changed, { line }, { kind: 'conflict' })
  // The link is the preview's repository still (a number is never taken for another repository's issue).
  if (!sameRepo(src.repo, preview.repo)) throw combworkError(T.changed, { line }, { kind: 'conflict' })
  const lines = await releasedLines(ws, projectPath, src.repo)
  const rel = lines.find((r) => r.line === line)
  if (!rel) throw combworkError(T.notReleased, { line }, { kind: 'conflict' })
  const now: PreviewPairs = { repo: src.repo, line, tag: rel.tag, commit: rel.commit, issues: (await shippedCards(ws, projectPath, p, src, rel, lines)).map((c) => ({ card: c.card, issue: c.issue })) }
  if (!samePreview(now, preview)) throw combworkError(T.changed, { line }, { kind: 'conflict' })
  // The release guard asks the repository every write names (the link is the preview's, checked just above), and
  // (HR1's round 1) GitHub's own tag must name the preview's commit.
  const pub = await src.published(rel.tag)
  if (!pub.ok || !pub.published) throw combworkError(T.notPublished, { tag: rel.tag }, { kind: 'conflict' })
  if (pub.commit !== preview.commit.toLowerCase()) throw combworkError(T.tagMismatch, { tag: rel.tag }, { kind: 'conflict' })
  if (!open()) throw combworkError(T.changed, { line }, { kind: 'conflict' })
  const comment = fixedInComment(versionOfLine(line))
  const out: CloseOutcome[] = []
  const seen = new Set<number>()
  /**
   * HR1 on s16: the batch's check is no lasting authority. Before each write, after the reads that came before it: the
   * same workspace still open, the link still the preview's repository, the line's tag still at the preview's commit,
   * and the card still Done about that issue there. Otherwise this issue and those after it are stopped, unwritten.
   */
  const stillSo = async (card: number, issue: number): Promise<boolean> => {
    if (!open()) return false
    const link = await githubRepoFor(ws, projectPath).catch(() => null)
    if (!link || !sameRepo(link, preview.repo) || !open()) return false
    const t = await p.reads.tagged!(projectPath, line)
    if (isUnknown(t) || !t || t.tag !== preview.tag || t.commit !== preview.commit || !open()) return false
    const pubNow = await src.published(preview.tag)
    if (!pubNow.ok || !pubNow.published || pubNow.commit !== preview.commit.toLowerCase() || !open()) return false
    const { getTask } = await import('./tasks')
    const c = await getTask(card, ws).catch(() => null)
    return !!c && c.column === 'done' && c.source?.kind === 'issue' && c.source.number === issue && sameRepo(c.source, preview.repo) && open()
  }
  const order = [...now.issues].sort((a, b) => a.issue - b.issue || a.card - b.card).filter((x, i, all) => all.findIndex((y) => y.issue === x.issue) === i)
  for (const [k, { card, issue }] of order.entries()) {
    const at = (outcome: CloseOutcome['outcome'], detail: string | null = null): number => out.push({ issue, card, outcome, detail })
    if (!seen.size && !open()) break
    seen.add(issue)
    const read = await src.read(issue)
    if (!read.ok) {
      at('unknown', read.detail ?? read.problem)
      continue
    }
    if (read.state === 'closed') {
      at('alreadyClosed')
      continue
    }
    // HI-3588: shown closed, so not counted on the button, and open now (reopened since): not this click's to close.
    if (!closeAuthorised(preview, issue)) {
      at('stopped')
      continue
    }
    if (!(await stillSo(card, issue))) {
      // The workspace closed: nothing more is written, its window gone with it. Anything else: the rest say stopped.
      if (open()) for (const x of order.slice(k)) out.push({ issue: x.issue, card: x.card, outcome: 'stopped', detail: null })
      break
    }
    const r = await src.close(issue, read.comments.some((c) => c.trim() === comment) ? null : comment)
    if (r.ok) {
      at('closed')
      continue
    }
    // Its reply lost or a step failed: what GitHub has now says.
    const back = await src.read(issue)
    if (back.ok && back.state === 'closed') at('closed')
    else if (back.ok) at('failed', r.detail ?? r.problem)
    else at('unknown', r.detail ?? r.problem)
  }
  log.info(`closed shipped issues of ${userText(line)} on ${userText(`${src.repo.owner}/${src.repo.repo}`)}: ${out.map((o) => `#${o.issue} ${o.outcome}`).join(', ') || 'none'}`)
  return out
}
