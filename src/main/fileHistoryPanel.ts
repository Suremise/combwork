// HI-3475: the Files tab's History (SPEC §8, A file's history) at its IPC boundary: a page of a file's or folder's
// commits in the folder the tab shows (the project folder, or an agent's slot or worktree), each with the card the
// commit itself names and the agent that submitted it; a commit's diff of the file, each side at its own path; and, asked
// for one commit at a time, the merge that brought it in. Reads only, the user's at a time, never an agent's tool.
//
// The card is the commit's own: its `Combwork-Card` trailer, else Combwork's attribution of it in the project folder
// (CommitAttributed: `folder_commits`), else a key starting its subject, and only a card of this project. Never one
// found through ancestry: "came in with" (introducedAt) is said apart, and gives no agent. The agent is "submitted by":
// the builder of the first of that card's submissions that holds the commit (its recorded commits in a shared folder,
// else its base..revision range), never the commit's author. Nothing here is kept between calls but the ranges, which
// never change: a new submission or attribution shows at the next read.
import { fileSideOf, historyPathOk, subjectKey, trailerKey, type CommitIntro, type FileCardHow, type FileHistoryCard, type FileHistoryPage, type FileHistoryRow, type FileVersions, type LoggedCommit } from '../shared/fileHistory'
import { isCommitId } from '../shared/gitMoves'
import { msg } from '../shared/i18n'
import type { Submission } from '../shared/workflow/facts'
import { combworkError } from './combworkError'
import { createLogger, userText } from './logger'
import { platformLimits } from './platform/limits'
import type { RepoReads } from './platform/repoReads'
import type { WorkspaceService } from './workspace'
import type { Workflow } from './workflow/runtime'
import { workflowFor } from './workflow/service'

const log = createLogger('file-history')

const T = {
  invalid: msg({ id: 'service.fileHistory.invalid', defaultMessage: 'That was asked for wrongly: nothing was read.', description: "HI-3475: an error from the Files tab's History panel: the request was malformed (not reached from the window)." }),
  unsupported: msg({ id: 'service.fileHistory.unsupported', defaultMessage: "This folder's version control has no history to show.", description: "HI-3475: an error from the Files tab's History panel: the folder's version control can't read a file's history." })
}

export type Reads = Required<Pick<RepoReads, 'fileLog' | 'fileVersions' | 'introducedBy' | 'rangeCommits'>>

/** The reads History needs, or refused when the folder's platform has none. */
export function readsOf(reads: RepoReads): Reads {
  const { fileLog, fileVersions, introducedBy, rangeCommits } = reads
  if (!fileLog || !fileVersions || !introducedBy || !rangeCommits) throw combworkError(T.unsupported, undefined, { kind: 'conflict' })
  return { fileLog, fileVersions, introducedBy, rangeCommits }
}

/** The project's workflow, or null when it has none to read (no board yet, a workspace closing): no cards, no agents. */
async function workflowOrNull(ws: WorkspaceService, project: string): Promise<Workflow | null> {
  try {
    return await workflowFor(ws, project)
  } catch (e) {
    log.info(`No workflow to name History's cards in ${userText(project)}: ${userText(String(e))}`)
    return null
  }
}

/** A card of this project by key, as History links it; null for none, or another project's. */
function cardNamed(wf: Workflow, key: string, how: FileCardHow): FileHistoryCard | null {
  const c = wf.store.cardByKey(key)
  return c ? { key: c.key, number: c.id, title: c.title, how } : null
}

/** The card a commit itself names: its trailer, Combwork's attribution of it in the project folder, a key starting its subject. */
function ownCard(wf: Workflow, project: string, c: Pick<LoggedCommit, 'hash' | 'trailer' | 'subject'>): FileHistoryCard | null {
  const t = trailerKey(c.trailer)
  const byTrailer = t ? cardNamed(wf, t, 'trailer') : null
  if (byTrailer) return byTrailer
  const attributed = wf.store.folderCommitCard(project, c.hash)
  if (typeof attributed === 'number') {
    const byRecord = cardNamed(wf, `#${attributed}`, 'attributed')
    if (byRecord) return byRecord
  }
  const s = subjectKey(c.subject)
  return s ? cardNamed(wf, s, 'subject') : null
}

/**
 * The builder of the first of the card's submissions holding `commit`, or null: none holds it, or its range can't be read
 * here (its commits gone). A range read past the page's deadline `at` is refused, as the page is.
 */
async function submitter(reads: Pick<Reads, 'rangeCommits'>, root: string, submissions: readonly Submission[], commit: string, at: number): Promise<string | null> {
  for (const s of submissions) {
    if (!s.by) continue
    if (s.commits) {
      if (s.commits.includes(commit)) return s.by
      continue
    }
    if (!s.base || !s.revision) continue
    if ((await reads.rangeCommits(root, s.base, s.revision, at))?.has(commit)) return s.by
  }
  return null
}

/** An agent's name now (its id when it is gone from the project). */
async function agentNames(ws: WorkspaceService, project: string): Promise<(id: string) => string> {
  const agents = (await ws.projectConfig(project).catch(() => null))?.agents ?? []
  return (id) => agents.find((a) => a.id === id)?.name ?? id
}

/** The folder shown (the project folder, an agent's slot or worktree) and its project, refused otherwise. */
export function rootOf(ws: WorkspaceService, root: unknown): { folder: string; project: string } {
  if (typeof root !== 'string' || !root) throw combworkError(T.invalid, undefined, { kind: 'invalid' })
  return ws.changesRootProject(root)
}

/**
 * `files:history`: a page of a file's (following renames) or folder's commits, pinned to page 1's head (a pin is a full
 * commit id, or none for page 1). The page's git reads, its commits' and its submissions' ranges, share one deadline
 * (Settings → Advanced's `cw.git.historySeconds`): past it the page is refused and its git ended.
 */
export async function fileHistoryAt(ws: WorkspaceService, rootRaw: unknown, rel: unknown, isDir: unknown, pinned: unknown, page: unknown, reads: RepoReads): Promise<FileHistoryPage> {
  const r = readsOf(reads)
  const { folder, project } = rootOf(ws, rootRaw)
  if (!historyPathOk(rel) || (rel === '' && isDir !== true) || (pinned != null && !isCommitId(pinned))) throw combworkError(T.invalid, undefined, { kind: 'invalid' })
  const at = Date.now() + platformLimits.gitHistoryMs()
  const got = await r.fileLog(folder, rel, isDir === true || rel === '', pinned ?? null, Number(page) || 1, at)
  const cards = await commitCards(ws, project, folder, got.commits, at, r)
  const rows: FileHistoryRow[] = got.commits.map((c) => ({ hash: c.hash, short: c.short, parent: c.parent, author: c.author, email: c.email, date: c.date, subject: c.subject, files: c.files, ...(cards.get(c.hash) ?? { card: null, submittedBy: null }) }))
  return { head: got.head, moved: got.moved, rows, page: got.page, more: got.more, repoPath: got.repoPath, prefix: got.prefix }
}

/** What a commit itself says of its card, and who submitted it in one of that card's submissions. */
export interface CommitCardOf {
  card: FileHistoryCard | null
  submittedBy: { agent: string; name: string } | null
}

/**
 * HI-3475/HI-3476: each commit's own card (ownCard) and its "submitted by" (submitter), for History's rows and blame's
 * annotations alike, read once per card. `at` bounds the submissions' range reads; past it this is refused, never answered
 * without them. No board to read (none yet, a workspace closing): no cards.
 */
export async function commitCards(ws: WorkspaceService, project: string, folder: string, commits: readonly Pick<LoggedCommit, 'hash' | 'trailer' | 'subject'>[], at: number, reads: Pick<Reads, 'rangeCommits'>): Promise<Map<string, CommitCardOf>> {
  const out = new Map<string, CommitCardOf>()
  const wf = commits.length ? await workflowOrNull(ws, project) : null
  if (!wf) return out
  const name = await agentNames(ws, project)
  const submissions = new Map<number, readonly Submission[]>()
  for (const c of commits) {
    const card = ownCard(wf, project, c)
    let submittedBy: CommitCardOf['submittedBy'] = null
    if (card) {
      let subs = submissions.get(card.number)
      if (!subs) submissions.set(card.number, (subs = wf.state(card.number).submissions))
      const agent = await submitter(reads, folder, subs, c.hash, at)
      if (agent) submittedBy = { agent, name: name(agent) }
    }
    out.set(c.hash, { card, submittedBy })
  }
  return out
}

/** `files:historyDiff`: a file at two commits, each side at its own path (a side null: there is none, as a root commit's parent). */
export async function fileHistoryDiffAt(ws: WorkspaceService, rootRaw: unknown, leftRaw: unknown, rightRaw: unknown, reads: RepoReads): Promise<FileVersions> {
  const r = readsOf(reads)
  const { folder } = rootOf(ws, rootRaw)
  const left = leftRaw == null ? null : fileSideOf(leftRaw, isCommitId)
  const right = rightRaw == null ? null : fileSideOf(rightRaw, isCommitId)
  if ((leftRaw != null && !left) || (rightRaw != null && !right) || (!left && !right)) throw combworkError(T.invalid, undefined, { kind: 'invalid' })
  return r.fileVersions(folder, left, right)
}

/** `files:historyIntro`: the merge that brought `commit` into `head`'s line, and the card that merge names; null when none can be said. */
export async function fileHistoryIntroAt(ws: WorkspaceService, rootRaw: unknown, head: unknown, commit: unknown, reads: RepoReads): Promise<CommitIntro | null> {
  const r = readsOf(reads)
  const { folder, project } = rootOf(ws, rootRaw)
  if (!isCommitId(head) || !isCommitId(commit)) throw combworkError(T.invalid, undefined, { kind: 'invalid' })
  const m = await r.introducedBy(folder, head, commit)
  if (!m) return null
  const wf = await workflowOrNull(ws, project)
  return { merge: m.merge, short: m.short, card: wf ? ownCard(wf, project, { hash: m.merge, trailer: m.trailer, subject: m.subject }) : null }
}
