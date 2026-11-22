import { useEffect, useState } from 'react'
import { HISTORY_COMMITS } from '@shared/gitRepo'
import type { FileCommits, FileRestored, FileRestorePlan, RestoreSource } from '@shared/gitFileRestore'
import { fmt, msg, tr } from '@shared/i18n'
import type { ProjectInfo } from '@shared/types'
import { errorMessage } from '../api'
import { attempt } from '../actions'
import { languageFor } from '../monacoLang'
import { repoOp } from '../repoOps'
import { bumpGit, confirm, notify } from '../store'
import { cx } from '../util'
import { Pager } from './DataTable'
import { DiffView } from './Editors'
import { commitPicks, type CommitPicks, type PickShown } from './commitPicks'
import { Icon } from './ui'

// HI-3477: the Files tab's Discard Changes… and Restore From… (SPEC §16.10.2, Discard and restore a file): each asks
// first, showing the file on disk now against what it becomes; its uncommitted changes go to a stash (Version Control →
// Changes → Stashes), never lost. Restore From → A Commit… lists the commits that changed the file, a page at a time,
// and shows the one picked. Main checks again, and refuses while anything works in the project folder.

export const FILE_RESTORE_TEXT = {
  discard: msg({ id: 'files.restore.discard', defaultMessage: 'Discard Changes…', description: "HI-3477: the Files tab's right-click menu, for a changed file: puts it back to the commit checked out, after showing what it would undo. Its changes go to a stash." }),
  restoreFrom: msg({ id: 'files.restore.from', defaultMessage: 'Restore From', description: "HI-3477: the Files tab's right-click menu, for a file git tracks: opens a menu of where to take the file's version from (the target branch, a commit)." }),
  fromTarget: msg({ id: 'files.restore.fromTarget', defaultMessage: 'Target Branch ({target})', description: "HI-3477: a choice under Restore From: the file's version on the project's target branch ({target}, its name)." }),
  fromCommit: msg({ id: 'files.restore.fromCommit', defaultMessage: 'A Commit…', description: 'HI-3477: a choice under Restore From: opens a list of the commits that changed the file, to pick one.' }),
  failed: msg({ id: 'files.restore.failed', defaultMessage: 'Could not restore the file', description: "Title of an error notification after the Files tab's Discard Changes… or Restore From… (HI-3477)." }),
  discardTitle: msg({ id: 'files.restore.discardTitle', defaultMessage: 'Discard the changes to "{name}"?', description: 'HI-3477: title of the confirmation before Discard Changes. {name} is the file.' }),
  discardMessage: msg({ id: 'files.restore.discardMessage', defaultMessage: 'It goes back to the commit checked out ({commit}). Its changes are kept in a stash: Apply in Version Control → Changes → Stashes brings them back.', description: 'HI-3477: the confirmation before Discard Changes. {commit} is a short commit id.' }),
  discardButton: msg({ id: 'files.restore.discardButton', defaultMessage: 'Discard Changes', description: 'HI-3477: the button of the confirmation before Discard Changes.' }),
  discarding: msg({ id: 'files.restore.discarding', defaultMessage: 'Discarding…', description: "HI-3477: Discard Changes' button while it runs." }),
  restoreTitle: msg({ id: 'files.restore.restoreTitle', defaultMessage: '{source, select, target {Restore "{name}" from {target}?} other {Restore "{name}" from a commit}}', description: 'HI-3477: title of the confirmation before Restore From. {name} is the file; target: from the target branch ({target}, its name); other: from a commit the user picks.' }),
  restoreMessage: msg({ id: 'files.restore.restoreMessage', defaultMessage: '{source, select, target {It becomes its version on {target} ({commit}),} other {It becomes its version in the commit you pick,}} as a change to commit. {changed, select, yes {Its uncommitted changes are kept in a stash first (Version Control → Changes → Stashes).} other {It has no uncommitted changes: nothing is lost.}}', description: 'HI-3477: the confirmation before Restore From. target: from the target branch ({target}, its name; {commit} a short commit id); other: from a commit the user picks in the list below. {changed}: yes when the file has uncommitted changes, which are stashed.' }),
  restoreButton: msg({ id: 'files.restore.restoreButton', defaultMessage: 'Restore', description: 'HI-3477: the button of the confirmation before Restore From.' }),
  restoring: msg({ id: 'files.restore.restoring', defaultMessage: 'Restoring…', description: "HI-3477: Restore From's button while it runs." }),
  missingTitle: msg({ id: 'files.restore.missingTitle', defaultMessage: '"{name}" isn\'t on {target}', description: 'HI-3477: title of the note Restore From → Target Branch shows when the file is not on the target branch ({target}, its name). {name} is the file.' }),
  missingMessage: msg({ id: 'files.restore.missingMessage', defaultMessage: 'The target ({commit}) has no file at this path: there is nothing to restore it from.', description: 'HI-3477: the note Restore From → Target Branch shows when the file is not on the target. {commit} is a short commit id.' }),
  missingInCommit: msg({ id: 'files.restore.missingInCommit', defaultMessage: "The file isn't in {commit} (that commit deleted it): pick another.", description: 'HI-3477: under the commit list of Restore From → A Commit…, when the commit picked ({commit}, a short id) has no file at this path.' }),
  pickFirst: msg({ id: 'files.restore.pickFirst', defaultMessage: 'Pick a commit first.', description: 'HI-3477: an error in Restore From → A Commit… when Restore is pressed before a commit is picked.' }),
  noCommits: msg({ id: 'files.restore.noCommits', defaultMessage: 'No commit on this branch changed this file.', description: 'HI-3477: in Restore From → A Commit… when the file has no commits on the branch checked out.' }),
  readFailed: msg({ id: 'files.restore.readFailed', defaultMessage: "Couldn't read it: {error}", description: 'HI-3477: in Restore From → A Commit… when reading the commits or a diff failed. {error} is why.' }),
  now: msg({ id: 'files.restore.now', defaultMessage: 'On disk now', description: "HI-3477: above the left side of the confirmation's diff: the file as it is now, what Discard or Restore replaces." }),
  becomes: msg({ id: 'files.restore.becomes', defaultMessage: 'After ({commit})', description: "HI-3477: above the right side of the confirmation's diff: the file as it will be, from that commit ({commit}, a short id)." }),
  same: msg({ id: 'files.restore.same', defaultMessage: 'No difference: the file on disk is already this version.', description: "HI-3477: in place of the confirmation's diff when the file on disk is the same as the version it would become." }),
  binary: msg({ id: 'files.restore.binary', defaultMessage: 'Binary file', description: "HI-3477: in place of the confirmation's diff when the file is binary." }),
  discarded: msg({ id: 'files.restore.discarded', defaultMessage: 'Discarded the changes to {name}.', description: 'HI-3477: notification after Discard Changes. {name} is the file.' }),
  restored: msg({ id: 'files.restore.restored', defaultMessage: 'Restored {name} from {commit}.', description: 'HI-3477: notification after Restore From. {name} is the file; {commit} a short commit id.' }),
  stashedNote: msg({ id: 'files.restore.stashedNote', defaultMessage: 'Its earlier changes are in Version Control → Changes → Stashes.', description: 'HI-3477: under the notification after Discard Changes or Restore From, when the file had changes, which were stashed.' })
}
const T = FILE_RESTORE_TEXT

/** The confirm's diff: the file on disk now (left) against what it becomes (right). */
function RestoreDiff({ plan }: { plan: FileRestorePlan }) {
  const d = plan.diff
  return (
    <div className="file-restore-diff" data-restore-diff={plan.short}>
      <div className="file-restore-sides faint">
        <span>{tr(T.now)}</span>
        <span>{tr(T.becomes, { commit: plan.short })}</span>
      </div>
      <div className="file-restore-editor">
        {d.binary ? <div className="empty-state">{d.modified || tr(T.binary)}</div> : d.original === d.modified ? <div className="empty-state">{tr(T.same)}</div> : <DiffView original={d.original} modified={d.modified} language={languageFor(d.path)} />}
      </div>
    </div>
  )
}

/** A Commit…'s list: the commits that changed the file, a page at a time; a click shows that commit's version. */
function CommitPicker({ project, rel, picks }: { project: ProjectInfo; rel: string; picks: CommitPicks<FileRestorePlan> }) {
  const [page, setPage] = useState(1)
  const [list, setList] = useState<{ page: number; data: FileCommits | null; error?: string } | null>(null)
  // What the picks show: the latest click's answer only, the same one Restore acts on (commitPicks.ts).
  const [plan, setPlan] = useState<PickShown<FileRestorePlan> | null>(picks.shown())
  useEffect(() => picks.watch(setPlan), [picks])
  useEffect(() => {
    let live = true
    void repoOp('files:gitFileCommits', project.path, rel, page).then(
      (data) => live && setList({ page, data }),
      (e) => live && setList({ page, data: null, error: errorMessage(e) })
    )
    return () => {
      live = false
    }
  }, [project.path, rel, page])
  const data = list?.data
  return (
    <div className="file-restore-picker" data-restore-picker="">
      {list?.error ? (
        <p className="hint">{tr(T.readFailed, { error: list.error })}</p>
      ) : !data ? (
        <Icon name="loading" spin />
      ) : data.commits.length === 0 ? (
        <p className="hint">{tr(T.noCommits)}</p>
      ) : (
        <div className="git-rows file-restore-commits">
          {data.commits.map((c) => (
            <button type="button" key={c.hash} className={cx('git-row', 'git-commit', plan?.commit === c.hash && 'current')} data-commit={c.short} onClick={() => picks.pick(c.hash)}>
              <code className="git-hash">{c.short}</code>
              <span className="git-subject">{c.subject}</span>
              <span className="git-meta faint">
                {c.author} · {fmt.dateTime(c.date)}
              </span>
            </button>
          ))}
        </div>
      )}
      {data && data.pages > 1 && <Pager page={data.page} pages={data.pages} from={(data.page - 1) * HISTORY_COMMITS + 1} to={Math.min(data.page * HISTORY_COMMITS, data.total)} total={data.total} onPage={setPage} />}
      {plan?.error ? (
        <p className="hint">{tr(T.readFailed, { error: plan.error })}</p>
      ) : plan && !plan.plan ? (
        <Icon name="loading" spin />
      ) : plan?.plan && !plan.plan.exists ? (
        <p className="hint">{tr(T.missingInCommit, { commit: plan.plan.short })}</p>
      ) : plan?.plan ? (
        <RestoreDiff plan={plan.plan} />
      ) : null}
    </div>
  )
}

const nameOf = (rel: string): string => rel.slice(rel.lastIndexOf('/') + 1)

/** Says what was done, and reads the tree and git again. */
function done(projectPath: string, rel: string, plan: FileRestorePlan, r: FileRestored, reload: () => void): void {
  reload()
  bumpGit(projectPath)
  const name = nameOf(rel)
  notify('success', plan.source === 'head' ? tr(T.discarded, { name }) : tr(T.restored, { name, commit: plan.short }), r.stashed ? tr(T.stashedNote) : undefined)
}

/** Discard Changes… (source head) or Restore From → Target Branch: the plan read, then its confirm. */
export async function restoreFile(project: ProjectInfo, rel: string, source: Exclude<RestoreSource, 'commit'>, reload: () => void): Promise<void> {
  const plan = await attempt(tr(T.failed), () => repoOp('files:gitRestorePlan', project.path, rel, source))
  if (!plan) return
  const name = nameOf(rel)
  if (!plan.exists) {
    await confirm({ title: tr(T.missingTitle, { name, target: plan.target ?? '' }), message: tr(T.missingMessage, { commit: plan.short }), okOnly: true })
    return
  }
  let result: FileRestored | null = null
  const head = source === 'head'
  const ok = await confirm({
    title: head ? tr(T.discardTitle, { name }) : tr(T.restoreTitle, { source: 'target', name, target: plan.target ?? '' }),
    message: head ? tr(T.discardMessage, { commit: plan.short }) : tr(T.restoreMessage, { source: 'target', target: plan.target ?? '', commit: plan.short, changed: plan.changed ? 'yes' : 'no' }),
    content: <RestoreDiff plan={plan} />,
    wide: true,
    danger: head,
    confirmLabel: tr(head ? T.discardButton : T.restoreButton),
    busyLabel: tr(head ? T.discarding : T.restoring),
    run: async () => {
      result = await repoOp('files:gitRestore', project.path, { rel: plan.rel, source, commit: plan.commit })
    }
  })
  const r = result as FileRestored | null
  if (ok && r) done(project.path, rel, plan, r, reload)
}

/** Restore From → A Commit…: the file's commits listed in the confirm, Restore acting on the one picked. */
export async function restoreFromCommit(project: ProjectInfo, rel: string, changed: boolean, reload: () => void): Promise<void> {
  const name = nameOf(rel)
  const picks = commitPicks((commit) => repoOp('files:gitRestorePlan', project.path, rel, 'commit', commit), errorMessage)
  let result: { plan: FileRestorePlan; r: FileRestored } | null = null
  const ok = await confirm({
    title: tr(T.restoreTitle, { source: 'commit', name, target: '' }),
    message: tr(T.restoreMessage, { source: 'commit', target: '', commit: '', changed: changed ? 'yes' : 'no' }),
    content: <CommitPicker project={project} rel={rel} picks={picks} />,
    wide: true,
    confirmLabel: tr(T.restoreButton),
    busyLabel: tr(T.restoring),
    run: async () => {
      const plan = picks.chosen()
      if (!plan) throw new Error(tr(T.pickFirst))
      result = { plan, r: await repoOp('files:gitRestore', project.path, { rel: plan.rel, source: 'commit', commit: plan.commit }) }
    }
  })
  const r = result as { plan: FileRestorePlan; r: FileRestored } | null
  if (ok && r) done(project.path, rel, r.plan, r.r, reload)
}
