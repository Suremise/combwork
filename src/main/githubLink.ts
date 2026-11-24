// A Git project's GitHub link (HI-3550): its GitHub host (HI-2779's setting: the project's, else the workspace's,
// githubHosts.ts), the repository there from its remotes (shared/githubRepo.ts: origin first, or the one the user
// chose), and gh's sign-in on that host (ghCli.ts). No link (no remote on the host): no GitHub feature shows.

import { combworkError } from './combworkError'
import { msg } from '../shared/i18n/msg'
import { githubRepoOf, githubRepoUrl, type GithubLink, type RemoteUrls } from '../shared/githubRepo'
import type { OpenPr, OpenPrsRead } from '../shared/githubSource'
import { gh as ghCall, ghStatus } from './ghCli'
import { lineRepoReads } from './platform/repoReadsPorts'
import { githubHostsFor } from './githubHosts'
import { createLogger, userText } from './logger'
import type { WorkspaceService } from './workspace'

const log = createLogger('github')

const NOT_A_REMOTE = msg({ id: 'github.link.notARemote', defaultMessage: 'That remote isn’t on this project’s GitHub host any more: choose again.', description: 'An error choosing the repository of a project’s GitHub link (HI-3550, Version Control → Workflow → GitHub): the remote chosen no longer points at a repository on the GitHub host.' })

/** The project's remotes, through the repository reads port (none when it isn't a repository, or git can't say). */
function remotesOf(projectPath: string): Promise<RemoteUrls[]> {
  return lineRepoReads().remotes(projectPath)
}

/** The project's chosen remote (project.json `githubRemote`), or null. */
async function chosenRemote(ws: WorkspaceService, projectPath: string): Promise<string | null> {
  try {
    const v = (await ws.projectConfig(projectPath)).githubRemote
    return typeof v === 'string' && v.trim() ? v.trim() : null
  } catch {
    return null
  }
}

/** The project's repository on its GitHub host, without asking gh (the later GitHub cards' first step). */
export async function githubRepoFor(ws: WorkspaceService, projectPath: string): Promise<{ host: string; owner: string; repo: string } | null> {
  const host = (await githubHostsFor(ws, projectPath, process.env)).repo.host
  const { linked } = githubRepoOf(await remotesOf(projectPath), host, await chosenRemote(ws, projectPath))
  return linked ? { host, owner: linked.owner, repo: linked.repo } : null
}

/** HI-3551: the project's link with its remote's name (a PR card's start fetches the PR from it), or null with none. */
export async function githubRemoteFor(ws: WorkspaceService, projectPath: string): Promise<{ remote: string; host: string; owner: string; repo: string } | null> {
  const host = (await githubHostsFor(ws, projectPath, process.env)).repo.host
  const { linked } = githubRepoOf(await remotesOf(projectPath), host, await chosenRemote(ws, projectPath))
  return linked ? { remote: linked.remote, host, owner: linked.owner, repo: linked.repo } : null
}

/** HI-3553: the most open pull requests From GitHub… lists (gh's `pr list --limit`), newest first. */
export const OPEN_PRS_LIMIT = 100

/**
 * HI-3553: the open pull requests of the project's GitHub repository (`gh pr list -R … --state open`), each with the
 * card not archived already about it, for the board's From GitHub…. Their titles are GitHub's, the window's to show.
 */
export async function openPrsOf(ws: WorkspaceService, projectPath: string): Promise<OpenPrsRead> {
  const repo = await githubRepoFor(ws, projectPath)
  if (!repo) return { repo: null, problem: 'noLink', detail: null }
  const r = await ghCall({ repo }, ['pr', 'list', '--state', 'open', '--limit', String(OPEN_PRS_LIMIT), '--json', 'number,title,url,author,headRefName,baseRefName,isCrossRepository,isDraft'], { json: true })
  if (!r.ok) return { repo, problem: r.problem, detail: r.detail }
  const { prSourceCards } = await import('./boardStore')
  const cards = new Map(prSourceCards(ws, repo).map((c) => [c.pr, c.n]))
  const rows = Array.isArray(r.json) ? (r.json as Record<string, unknown>[]) : []
  const str = (o: Record<string, unknown>, k: string): string => (typeof o[k] === 'string' ? (o[k] as string) : '')
  const prs = rows
    .filter((o) => o && typeof o === 'object' && Number.isInteger(o.number) && (o.number as number) > 0)
    .map((o): OpenPr => {
      const a = o.author as { login?: unknown } | undefined
      const number = o.number as number
      return { number, title: str(o, 'title'), url: str(o, 'url'), author: a && typeof a.login === 'string' ? a.login : null, headRef: str(o, 'headRefName'), baseRef: str(o, 'baseRefName'), crossRepository: o.isCrossRepository === true, draft: o.isDraft === true, card: cards.get(number) ?? null }
    })
  return { repo, prs }
}

/** The project's link, as Version Control → Workflow → GitHub shows it, with gh asked about its host now. */
export async function githubLinkOf(ws: WorkspaceService, projectPath: string): Promise<GithubLink> {
  const resolved = (await githubHostsFor(ws, projectPath, process.env)).repo
  const chosen = await chosenRemote(ws, projectPath)
  const [remotes, gh] = await Promise.all([remotesOf(projectPath), ghStatus(resolved.host)])
  const { candidates, linked } = githubRepoOf(remotes, resolved.host, chosen)
  return { host: resolved.host, hostOrigin: resolved.origin, candidates, linked: linked ? { ...linked, url: githubRepoUrl({ host: resolved.host, owner: linked.owner, repo: linked.repo }) } : null, chosen, gh }
}

/** The user's choice among the remotes on the host (null: back to origin, or the only one). Refused for another remote. */
export async function setGithubRemote(ws: WorkspaceService, projectPath: string, remote: string | null): Promise<GithubLink> {
  if (remote !== null) {
    const host = (await githubHostsFor(ws, projectPath, process.env)).repo.host
    const { candidates } = githubRepoOf(await remotesOf(projectPath), host)
    if (typeof remote !== 'string' || !candidates.some((c) => c.remote === remote)) throw combworkError(NOT_A_REMOTE, undefined, { kind: 'invalid' })
  }
  await ws.mutateProjectConfig(projectPath, () => ({ githubRemote: remote ?? undefined }))
  log.info(`GitHub link of ${userText(projectPath)}: remote ${remote === null ? 'by default' : userText(remote)}`)
  return githubLinkOf(ws, projectPath)
}
