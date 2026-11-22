// HI-3477: the Files tab's Discard Changes… and Restore From… (SPEC §16.10.2, Discard and restore a file): what the
// confirm reads (`files:gitRestorePlan`, A Commit…'s `files:gitFileCommits`) and what it does (`files:gitRestore`), the
// user's click at a time, never an agent's tool. Only in the project folder (the Files tab's Git section is never an
// agent's slot), refused while a session runs there, as Stashes' Apply is (stashPanel.ts); the port checks again, under
// the repository lock and the folder's fence, that nothing of Combwork's or an agent's works there (gitFileRestore.ts).
import { isRestoreSource, restoreCommitOf, restoreRequestOf, type FileCommits, type FileRestored, type FileRestorePlan } from '../shared/gitFileRestore'
import { msg } from '../shared/i18n'
import { combworkError } from './combworkError'
import { containsPlace } from './fsutil'
import type { OpsFor } from './platform/repoOps'
import { lineRepoReads } from './platform/repoReadsPorts'
import { sessions } from './sessions'
import type { WorkspaceService } from './workspace'

const T = {
  session: msg({ id: 'service.gitRestore.session', defaultMessage: "{agent}'s session is in {folder}: nothing was done. Stop it first.", description: "HI-3477: an error from the Files tab's Discard Changes… or Restore From…: an agent's session ({agent}, its name) runs in the project folder ({folder}, a path), so Combwork doesn't change its files." }),
  invalid: msg({ id: 'service.gitRestore.request', defaultMessage: 'That was asked for wrongly: nothing was done.', description: "HI-3477: an error from the Files tab's Discard Changes… or Restore From…: the request was malformed (not reached from the window)." })
}

/** `files:gitRestorePlan`: what Discard (head) or Restore From (target, commit) would do to one file. */
export async function restorePlanAt(ws: WorkspaceService, projectPath: string, rel: unknown, source: unknown, commit: unknown, ops: OpsFor<'restoreFile'>): Promise<FileRestorePlan> {
  const p = ws.assertProject(projectPath)
  if (!isRestoreSource(source) || (source === 'commit' && !restoreCommitOf(commit))) throw combworkError(T.invalid, undefined, { kind: 'invalid' })
  const target = source === 'target' ? await lineRepoReads().workTarget(p) : null
  return ops.fileRestorePlan(p, rel, source, target, source === 'commit' ? restoreCommitOf(commit) : null)
}

/** `files:gitFileCommits`: A Commit…'s list, a page at a time. */
export function fileCommitsAt(ws: WorkspaceService, projectPath: string, rel: unknown, page: unknown, ops: OpsFor<'restoreFile'>): Promise<FileCommits> {
  return ops.fileCommits(ws.assertProject(projectPath), rel, page)
}

/** `files:gitRestore`: the Discard or Restore the confirm showed, refused while a session is in the project folder. */
export function restoreAt(ws: WorkspaceService, projectPath: string, raw: unknown, ops: OpsFor<'restoreFile'>): Promise<FileRestored> {
  const p = ws.assertProject(projectPath)
  const req = restoreRequestOf(raw)
  if (!req) throw combworkError(T.invalid, undefined, { kind: 'invalid' })
  const noSession = (): void => {
    const live = sessions.liveStates().find((x) => !!x.cwd && containsPlace(p, x.cwd))
    if (live) throw combworkError(T.session, { agent: live.agentName ?? live.agentId, folder: p })
  }
  return ops.restoreFile(p, req, noSession)
}
