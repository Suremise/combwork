// HI-2944: Commit and Set aside of a folder's uncommitted changes, the same wherever they are offered: a paused merge
// (the Merges tab, Version Control → Merge queue, the card's Work section), a start's warning (its notification's
// buttons) and Files' Commit it after a shared exclude. Main finds the folder and checks everything again; the window
// sends only what it showed (the files, and the pause as it was) and says what happened.
import type { FolderChangeAction, QueuePauseRef } from '@shared/types'
import type { QueuePauseInfo } from '@shared/workflow/queue'
import { msg, tr } from '@shared/i18n'
import * as actions from './actions'
import { offered, repoOp } from './repoOps'
import { bumpGit, notify, showVersionControl } from './store'

const T = {
  commitFailed: msg({ id: 'folderChanges.commitFailed', defaultMessage: 'Could not commit', description: "HI-2944: an error notification's title: Commit of a folder's uncommitted changes (a paused merge, a start's warning, Files' Commit it) was refused." }),
  setAsideFailed: msg({ id: 'folderChanges.setAsideFailed', defaultMessage: 'Could not set the changes aside', description: "HI-2944: an error notification's title: Set aside of a folder's uncommitted changes was refused." }),
  committed: msg({ id: 'folderChanges.committed', defaultMessage: '{count, plural, one {Committed # file} other {Committed # files}} on {branch}.', description: "HI-2944: a notification after Commit: the files committed in the folder's branch {branch}." }),
  setAside: msg({ id: 'folderChanges.setAside', defaultMessage: '{count, plural, one {Set # file aside} other {Set # files aside}} on {branch}.', description: 'HI-2944: a notification after Set aside: the files stashed in the branch {branch}.' }),
  setAsideDetail: msg({ id: 'folderChanges.setAsideDetail', defaultMessage: 'Git keeps them in a stash named "{name}": git stash pop brings them back.', description: 'HI-2944: under the notification after Set aside: where the changes are and how to get them back. {name} is the stash\'s message. Keep git stash pop as it is: a command.' }),
  resumed: msg({ id: 'folderChanges.resumed', defaultMessage: 'The merge goes on.', description: 'HI-2944: under the notification after Commit or Set aside on a paused merge: the merge queue resumed.' }),
  stillPaused: msg({ id: 'folderChanges.stillPaused', defaultMessage: 'The merge is still paused: see why on it.', description: 'HI-2944: under the notification after Commit or Set aside on a paused merge: the queue stays paused (something else still stops it, shown on the paused merge).' })
}

/**
 * Commit or Set aside exactly `files` in the folder `target` is checked out in. From a paused merge `pause` is that
 * pause as shown: main acts only while it is still the current one, and the merge goes on only if it then can.
 */
export async function settleFolderChanges(projectPath: string, target: string, action: FolderChangeAction, files: string[], pause: QueuePauseRef | null = null, folder: string | null = null): Promise<boolean> {
  const r = await actions.attempt(tr(action === 'commit' ? T.commitFailed : T.setAsideFailed), () => repoOp('queue:settleChanges', projectPath, target, action, files, pause, folder))
  if (!r) return false
  bumpGit(projectPath)
  const title = tr(action === 'commit' ? T.committed : T.setAside, { count: r.done.files.length, branch: r.done.branch })
  const parts = [action === 'setAside' ? tr(T.setAsideDetail, { name: r.done.message }) : null, pause ? tr(r.resumed ? T.resumed : T.stillPaused) : null]
  notify(pause && !r.resumed ? 'warning' : 'success', title, parts.filter(Boolean).join(' ') || undefined)
  return true
}

/** Files' Commit it: the top .gitignore as it is now, committed alone. */
export async function commitIgnore(projectPath: string): Promise<void> {
  const r = await actions.attempt(tr(T.commitFailed), () => repoOp('files:gitCommitIgnore', projectPath))
  if (!r) return
  bumpGit(projectPath)
  notify('success', tr(T.committed, { count: 1, branch: r.branch }))
}

/** Whether Commit and Set aside are offered here (the project's version control lists them). */
export const folderChangesOffered = (): boolean => offered('queue:settleChanges')

/** Show changes: the project's Version Control tab, its changes. */
export const showFolderChanges = (projectPath: string): void => showVersionControl(projectPath, 'changes')

/** A paused merge's pause, as the window has it, for Commit and Set aside to act only on it (null: one they don't act on). */
export const pauseRefOf = (p: QueuePauseInfo): QueuePauseRef | null => (p.card && p.at && SETTLED_PAUSES.has(p.reason) && p.files.length ? { card: p.card, reason: p.reason, at: p.at } : null)

/** The pauses Commit and Set aside are offered on: the target's folder has uncommitted (or staged) changes the merge needs. */
export const SETTLED_PAUSES: ReadonlySet<string> = new Set(['unstagedChanges', 'staged'])
