// HI-3471: History's Commit dialog (SPEC §16.10.2, A commit's details): a commit's details, files and diffs, and
// Revert… and Cherry-pick… onto the branch the project folder has checked out, the user's click at a time, never an
// agent's tool. Each runs `git revert` or `git cherry-pick` (`-m 1` for a merge) with git's prepared message, under
// Commit's bound, in the project folder, under its branch's merge slot, the repository lock and the folder's fence,
// checked again just before git runs: refused on a detached HEAD, the branch moved since the user looked, the commit
// already in it (a pick) or not in it (a revert), uncommitted changes to tracked files, HI-3469's folder checks
// (projectFolderBusy) and the branch's (branchBusy). A conflict leaves git mid-operation, for HI-3470's panel.
import { shownText } from '../../../shared/advanced'
import { commitActionOf, commitCard, type CommitActionDone, type CommitActionRequest, type CommitDetail, type CommitFile } from '../../../shared/gitCommitView'
import { isCommitId } from '../../../shared/gitMoves'
import type { GitDiff } from '../../../shared/types'
import { msg, tr } from '../../../shared/i18n'
import { CombworkError, combworkError } from '../../combworkError'
import { changingFolder } from '../../folderFence'
import { git, gitErrorLine, type GitResult } from '../../git'
import { commitDiff } from '../../gitCompare'
import { operationSync } from '../../gitCommands'
import { repoSummary } from '../../gitRepo'
import { createLogger, userText } from '../../logger'
import { mergeSlots } from '../../mergeSlotHost'
import { withRepoLock } from '../../repoLock'
import { platformLimits } from '../limits'
import { branchBusy, projectFolderBusy } from './gitMoves'

const log = createLogger('git-commit')

export const COMMIT_TEXT = {
  invalid: msg({ id: 'service.gitCommit.invalid', defaultMessage: 'That was asked for wrongly: nothing was done.', description: "HI-3471: an error from History's Commit dialog: the request was malformed (not reached from the window)." }),
  noCommit: msg({ id: 'service.gitCommit.noCommit', defaultMessage: "Git has no commit {commit}: it may be gone. Look again.", description: "HI-3471: an error from History's Commit dialog: the commit ({commit}, a short id) isn't in the repository." }),
  detached: msg({ id: 'service.gitCommit.detached', defaultMessage: 'The project folder is on a detached HEAD: switch to a branch first.', description: "HI-3471: why Revert… or Cherry-pick… can't be done: the project folder has no branch checked out (git's detached HEAD)." }),
  moved: msg({ id: 'service.gitCommit.moved', defaultMessage: 'The project folder is no longer on {branch} at the commit you saw: nothing was done. Look again.', description: 'HI-3471: an error from Revert… or Cherry-pick…: the project folder switched branch, or its branch ({branch}) moved, since the dialog read it.' }),
  notIn: msg({ id: 'service.gitCommit.notIn', defaultMessage: "{branch} doesn't have this commit, so there is nothing of it to revert. Cherry-pick… brings it in.", description: "HI-3471: why Revert… can't be done: the project folder's branch ({branch}) doesn't contain the commit." }),
  alreadyIn: msg({ id: 'service.gitCommit.alreadyIn', defaultMessage: '{branch} has this commit already.', description: "HI-3471: why Cherry-pick… can't be done: the project folder's branch ({branch}) already contains the commit." }),
  dirty: msg({ id: 'service.gitCommit.dirty', defaultMessage: 'The project folder has uncommitted changes: commit them or set them aside first.', description: "HI-3471: why Revert… or Cherry-pick… can't be done: tracked files in the project folder have uncommitted changes (git would refuse, or mix them in)." }),
  failed: msg({ id: 'service.gitCommit.failed', defaultMessage: 'Git refused: {why}', description: "HI-3471: an error from Revert… or Cherry-pick…: git's own command failed; {why} is git's error line, in English." }),
  timedOut: msg({ id: 'service.gitCommit.timedOut', defaultMessage: 'Git was still running after {seconds, number} seconds, so Combwork ended it. Look at Version Control → Changes before you try again.', description: "HI-3471: an error from Revert… or Cherry-pick…: git ran past Settings → Advanced's longest commit time ({seconds}) and was ended." }),
  done: msg({ id: 'service.gitCommit.done', defaultMessage: '{action, select, revert {Reverted {commit} on {branch}} other {Cherry-picked {commit} onto {branch}}}: the new commit is {made}.', description: 'HI-3471: a notice after Revert… or Cherry-pick… committed. {commit} and {made} are short commit ids; {branch} the project folder\'s branch. Keep the select keys.' }),
  stopped: msg({ id: 'service.gitCommit.stopped', defaultMessage: "{action, select, revert {The revert} other {The cherry-pick}} of {commit} stopped on {count, plural, one {a conflict in # file} other {conflicts in # files}}: finish or abort it in Version Control → Changes.", description: "HI-3471: a notice after Revert… or Cherry-pick… stopped on a conflict: git is left mid-operation, and Changes' panel (HI-3470) continues or aborts it. {commit}: a short id. Keep the select keys." }),
  stoppedEmpty: msg({ id: 'service.gitCommit.stoppedEmpty', defaultMessage: "{action, select, revert {The revert} other {The cherry-pick}} of {commit} stopped: git says it would change nothing. Skip or abort it in Version Control → Changes.", description: "HI-3471: a notice after Revert… or Cherry-pick… stopped with no conflict (git found nothing to commit) and left the operation under way, for Changes' panel. Keep the select keys." })
}
const M = COMMIT_TEXT

/** What the folder fence says while it runs (the queue's log and its starts' wait). */
const FENCE = 'the user reverting or cherry-picking a commit' // i18n-ignore: the fence's name, in the log

const refused = (r: GitResult): CombworkError => combworkError(M.failed, { why: gitErrorLine(`${r.err}\n${r.out}`) || r.err.trim().slice(0, 400) || r.out.trim().slice(0, 400) })

const commitArg = (raw: unknown): string => {
  if (!isCommitId(raw)) throw combworkError(M.invalid, undefined, { kind: 'invalid' })
  return raw
}

/** Whether `commit` is in `head`'s history. */
async function contains(root: string, commit: string, head: string): Promise<boolean> {
  return (await git(root, ['merge-base', '--is-ancestor', commit, head])).ok
}

/** The tree a root commit is compared with: git's empty tree, as this repository's hash makes it. */
async function emptyTree(root: string): Promise<string> {
  const r = await git(root, ['hash-object', '-t', 'tree', '--stdin'], undefined, '')
  if (!r.ok) throw refused(r)
  return r.out.trim()
}

/** The project folder's tracked files with uncommitted changes (staged or not). */
async function trackedChanges(folder: string): Promise<boolean> {
  const r = await git(folder, ['status', '--porcelain', '--untracked-files=no'])
  if (!r.ok) throw refused(r)
  return !!r.out.trim()
}

/** Why `action` can't be done now (the first reason), or null; for `commit`, the folder on `branch` at `head`. */
async function refusalOf(projectPath: string, action: CommitActionRequest['action'], commit: string, branch: string | null, head: string | null): Promise<CombworkError | null> {
  if (!branch || !head) return combworkError(M.detached, undefined, { kind: 'conflict' })
  const has = await contains(projectPath, commit, head)
  if (action === 'revert' && !has) return combworkError(M.notIn, { branch }, { kind: 'conflict' })
  if (action === 'cherryPick' && has) return combworkError(M.alreadyIn, { branch }, { kind: 'conflict' })
  const busy = await branchBusy(projectPath, branch)
  if (busy) return busy
  const { refusal } = await projectFolderBusy(projectPath)
  if (refusal) return refusal
  if (await trackedChanges(projectPath)) return combworkError(M.dirty, undefined, { kind: 'conflict' })
  return null
}

/** HI-3471: one commit as the Commit dialog shows it, with whether Revert… and Cherry-pick… can be done now. */
export async function commitDetail(projectPath: string, raw: unknown): Promise<CommitDetail> {
  const commit = commitArg(raw)
  const r = await git(projectPath, ['show', '-s', '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%ct%x1f%P%x1f%s%x1f%(trailers:key=Combwork-Card,valueonly,separator=%x2C)%x1f%B', commit, '--'])
  if (!r.ok) throw combworkError(M.noCommit, { commit: commit.slice(0, 7) }, { kind: 'notFound' })
  const [hash, short, author, email, ct, parents, subject, trailer, ...body] = r.out.split('\x1f')
  const parentList = (parents ?? '').split(' ').filter(Boolean)
  const base = parentList[0] ?? (await emptyTree(projectPath))
  const d = await git(projectPath, ['diff', '--name-status', '--no-renames', '-z', base, hash, '--'])
  if (!d.ok) throw refused(d)
  const parts = d.out.split('\0').filter(Boolean)
  const files: CommitFile[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) files.push({ status: parts[i][0], path: parts[i + 1] })
  const summary = await repoSummary(projectPath)
  const branch = summary.branch
  const head = summary.head ? ((await git(projectPath, ['rev-parse', '--verify', '-q', 'HEAD'])).out.trim() || null) : null
  const why = async (a: CommitActionRequest['action']): Promise<string | null> => {
    const e = await refusalOf(projectPath, a, hash, branch, head)
    return e ? shownText(e.text) : null
  }
  return {
    hash,
    short,
    author,
    email,
    date: (Number(ct) || 0) * 1000,
    subject: subject ?? '',
    message: body.join('\x1f').trim(),
    parents: parentList,
    card: commitCard(trailer ?? '', subject ?? ''),
    files,
    branch,
    head,
    revert: await why('revert'),
    cherryPick: await why('cherryPick')
  }
}

/** HI-3471: one file of a commit, against its first parent (a root commit's, against nothing). */
export async function commitFileDiff(projectPath: string, raw: unknown, file: string): Promise<GitDiff> {
  const commit = commitArg(raw)
  const p = await git(projectPath, ['rev-parse', '--verify', '-q', `${commit}^1`])
  return commitDiff(projectPath, p.ok ? p.out.trim() : await emptyTree(projectPath), commit, file)
}

/** HI-3471: Revert… or Cherry-pick… of a commit onto the project folder's branch; what it did. */
export async function commitAction(projectPath: string, raw: unknown): Promise<CommitActionDone> {
  const req = commitActionOf(raw)
  if (!req) throw combworkError(M.invalid, undefined, { kind: 'invalid' })
  const { action, commit, branch, head } = req
  const run = async (): Promise<CommitActionDone> => {
    // Checked again under the locks: nothing changes between this and git starting.
    const s = await repoSummary(projectPath)
    const now = (await git(projectPath, ['rev-parse', '--verify', '-q', 'HEAD'])).out.trim()
    if (s.branch !== branch || now !== head) throw combworkError(M.moved, { branch }, { kind: 'conflict' })
    const shown = await git(projectPath, ['rev-list', '--parents', '-n', '1', commit, '--'])
    if (!shown.ok || !shown.out.trim()) throw combworkError(M.noCommit, { commit: commit.slice(0, 7) }, { kind: 'conflict' })
    const merge = shown.out.trim().split(' ').length > 2
    const e = await refusalOf(projectPath, action, commit, branch, head)
    if (e) throw e
    log.info(`The user's ${action} of ${commit.slice(0, 12)} on ${userText(branch)}`)
    const args = action === 'revert' ? ['revert', '--no-edit', ...(merge ? ['-m', '1'] : []), commit] : ['cherry-pick', ...(merge ? ['-m', '1'] : []), commit]
    // Git's prepared message, no editor; Commit's bound (Settings → Advanced, `cw.git.commitMinutes`): its hooks run.
    const r = await git(projectPath, args, undefined, undefined, { env: { ...process.env, GIT_EDITOR: 'true', GIT_TERMINAL_PROMPT: '0' }, timeout: platformLimits.gitCommitMs() })
    if (r.timedOut) {
      log.warn(`git ${args[0]} in ${userText(projectPath)} ran past its bound and was ended`)
      throw combworkError(M.timedOut, { seconds: Math.round(platformLimits.gitCommitMs() / 1000) })
    }
    const after = (await git(projectPath, ['rev-parse', '--verify', '-q', 'HEAD'])).out.trim()
    if (r.ok && after && after !== head) return { made: after, conflicts: [], notice: tr(M.done, { action, commit: commit.slice(0, 7), branch, made: after.slice(0, 7) }) }
    // Stopped: git is mid-operation (a conflict, or nothing to commit), for Changes' panel; else it refused outright.
    if (operationSync(projectPath)) {
      const u = await git(projectPath, ['diff', '--name-only', '--diff-filter=U', '-z'])
      const conflicts = [...new Set(u.ok ? u.out.split('\0').filter(Boolean) : [])].sort()
      log.info(`The user's ${action} of ${commit.slice(0, 12)} stopped${conflicts.length ? ` on ${conflicts.length} conflicted file(s)` : ''}`)
      return { made: null, conflicts, notice: conflicts.length ? tr(M.stopped, { action, commit: commit.slice(0, 7), count: conflicts.length }) : tr(M.stoppedEmpty, { action, commit: commit.slice(0, 7) }) }
    }
    throw refused(r)
  }
  return mergeSlots.asUser(projectPath, branch, () => withRepoLock(projectPath, () => changingFolder(projectPath, FENCE, run), { project: projectPath }))
}
