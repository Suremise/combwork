import { useEffect, useState } from 'react'
import type { GitDiff, ProjectInfo } from '@shared/types'
import type { CommitAction, CommitDetail } from '@shared/gitCommitView'
import { formatDateTime } from '@shared/dates'
import { msg, tr } from '@shared/i18n'
import { call, errorMessage } from '../api'
import { attempt } from '../actions'
import { languageFor } from '../monacoLang'
import { cardNumberOf } from '../projectKeys'
import { offered, repoOp } from '../repoOps'
import { bumpGit, confirm, notify, set } from '../store'
import { cx } from '../util'
import { GitForm, tagForm, useFolderBusy, type OpenForm } from '../views/GitTab'
import { DiffView } from './Editors'
import { Icon, Modal, Tooltip } from './ui'

// HI-3471: History's Commit dialog (SPEC §16.10.2, A commit's details), opened from a commit in History or a move in
// Moves: the commit's hash (Copy hash), author, date, message and card, its files against its first parent with each
// one's diff, and Revert…, Cherry-pick… (onto the project folder's branch, asked first, checked again in main:
// gitCommitActions.ts), Branch from here… and Tag here… (New branch… and Create tag…'s own forms, at this commit).

export const COMMIT_TEXT = {
  title: msg({ id: 'git.commit.title', defaultMessage: 'Commit {commit}', description: "HI-3471: the title of History's Commit dialog. {commit} is a short commit id." }),
  loading: msg({ id: 'git.commit.loading', defaultMessage: 'Reading the commit…', description: 'HI-3471: the Commit dialog while it reads the commit.' }),
  loadFailed: msg({ id: 'git.commit.loadFailed', defaultMessage: "Couldn't read the commit: {error}", description: 'HI-3471: the Commit dialog when reading the commit failed. {error} is why.' }),
  meta: msg({ id: 'git.commit.meta', defaultMessage: '{author} · {when}', description: "HI-3471: under a commit's message in the Commit dialog: its author and when it was made (a date and time)." }),
  copy: msg({ id: 'git.commit.copy', defaultMessage: 'Copy hash', description: "HI-3471: the Commit dialog's button: copies the commit's full hash." }),
  copied: msg({ id: 'git.commit.copied', defaultMessage: 'Copied {commit}', description: "HI-3471: a notice after Copy hash. {commit} is the full hash." }),
  openCard: msg({ id: 'git.commit.openCard', defaultMessage: 'Open {card}', description: "HI-3471: the tooltip of the card key in the Commit dialog (from the commit's Combwork-Card trailer or its subject): opens the card." }),
  revert: msg({ id: 'git.commit.revert', defaultMessage: 'Revert…', description: "HI-3471: the Commit dialog's button: makes a commit on the project folder's branch that undoes this one, after asking (git revert)." }),
  cherryPick: msg({ id: 'git.commit.cherryPick', defaultMessage: 'Cherry-pick…', description: "HI-3471: the Commit dialog's button: copies this commit onto the project folder's branch, after asking (git cherry-pick). Git's word." }),
  branchHere: msg({ id: 'git.commit.branchHere', defaultMessage: 'Branch from here…', description: "HI-3471: the Commit dialog's button: opens New branch… starting at this commit." }),
  tagHere: msg({ id: 'git.commit.tagHere', defaultMessage: 'Tag here…', description: "HI-3471: the Commit dialog's button: opens Create tag… for this commit." }),
  actionTip: msg({ id: 'git.commit.actionTip', defaultMessage: '{action, select, revert {Makes a commit on {branch} in the project folder that undoes this one. Runs git revert.} other {Copies this commit onto {branch} in the project folder. Runs git cherry-pick.}}', description: "HI-3471: the tooltip of Revert… or Cherry-pick… when it can be done. {branch} is the project folder's branch. Keep the git commands as they are. Keep the select keys." }),
  askTitle: msg({ id: 'git.commit.askTitle', defaultMessage: '{action, select, revert {Revert {commit} on {branch}?} other {Cherry-pick {commit} onto {branch}?}}', description: "HI-3471: the question before Revert… or Cherry-pick…. {commit} is a short id; {branch} the project folder's branch. Keep the select keys." }),
  askMessage: msg({
    id: 'git.commit.askMessage',
    defaultMessage: '{action, select, revert {A new commit on {branch}, in the project folder, undoes “{subject}”{merge, select, yes { (what the merge brought in, against its first parent)} other {}}.} other {A new commit on {branch}, in the project folder, makes the changes of “{subject}”{merge, select, yes { (what the merge brought in, against its first parent)} other {}}.}} It uses git’s own message. If git stops on a conflict, Version Control → Changes finishes or aborts it.',
    description: "HI-3471: under git.commit.askTitle: what Revert… or Cherry-pick… does. {subject} is the commit's subject; merge yes for a merge commit. Keep the select keys."
  }),
  confirm: msg({ id: 'git.commit.confirm', defaultMessage: '{action, select, revert {Revert} other {Cherry-pick}}', description: 'HI-3471: the confirm button of the question before Revert… or Cherry-pick…. Keep the select keys.' }),
  failed: msg({ id: 'git.commit.failed', defaultMessage: "Git couldn't do that", description: 'HI-3471: the title of the error notice when Revert…, Cherry-pick… or reading a file failed or was refused.' }),
  openChanges: msg({ id: 'git.commit.openChanges', defaultMessage: 'Open in Changes', description: "HI-3471: a button on the notice after a revert or cherry-pick stopped: shows Version Control → Changes, whose panel finishes or aborts it. Changes is the section's name: keep it as it is named there." }),
  files: msg({ id: 'git.commit.files', defaultMessage: '{n, plural, one {# file} other {# files}}', description: "HI-3471: the heading of the commit's files in the Commit dialog." }),
  diffFailed: msg({ id: 'git.commit.diffFailed', defaultMessage: "Couldn't show the file's changes: {error}", description: "HI-3471: in place of a file's diff in the Commit dialog when reading it failed." }),
  binary: msg({ id: 'git.commit.binary', defaultMessage: 'Binary file', description: "HI-3471: in place of a file's diff in the Commit dialog when it is binary." }),
  close: msg({ id: 'git.commit.close', defaultMessage: 'Close', description: "HI-3471: the Commit dialog's close button." })
}
const T = COMMIT_TEXT

/** HI-3471: the Commit dialog for `commit` (in full), in `project`; `onClose` when it closes. */
export function CommitDialog({ project, commit, onClose }: { project: ProjectInfo; commit: string; onClose: () => void }) {
  const [detail, setDetail] = useState<{ data: CommitDetail | null; error?: string } | null>(null)
  const [reads, setReads] = useState(0)
  const [file, setFile] = useState<string | null>(null)
  const [diff, setDiff] = useState<{ for: string; diff: GitDiff | null; error?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState<OpenForm | null>(null)
  const folderBusy = useFolderBusy(project)

  useEffect(() => {
    let live = true
    void repoOp('git:commitDetail', project.path, commit).then(
      (data) => {
        if (!live) return
        setDetail({ data })
        setFile((f) => (f && data.files.some((x) => x.path === f) ? f : (data.files[0]?.path ?? null)))
      },
      (e) => live && setDetail({ data: null, error: errorMessage(e) })
    )
    return () => {
      live = false
    }
  }, [project.path, commit, reads])

  useEffect(() => {
    if (!file) return
    let live = true
    const key = `${commit}\0${file}`
    void repoOp('git:commitFileDiff', project.path, commit, file).then(
      (d) => live && setDiff({ for: key, diff: d }),
      (e) => live && setDiff({ for: key, diff: null, error: errorMessage(e) })
    )
    return () => {
      live = false
    }
  }, [project.path, commit, file])

  if (form) return <GitForm make={form.make} onClose={onClose} />
  const d = detail?.data ?? null
  const shownDiff = file && diff?.for === `${commit}\0${file}` ? diff : null

  const act = async (action: CommitAction): Promise<void> => {
    if (!d?.branch || !d.head || busy) return
    const req = { action, commit: d.hash, branch: d.branch, head: d.head }
    const ok = await confirm({
      title: tr(T.askTitle, { action, commit: d.short, branch: d.branch }),
      message: tr(T.askMessage, { action, branch: d.branch, subject: d.subject, merge: d.parents.length > 1 ? 'yes' : 'no' }),
      confirmLabel: tr(T.confirm, { action })
    })
    if (!ok) return
    setBusy(true)
    const done = await attempt(tr(T.failed), () => repoOp('git:commitAction', project.path, req))
    setBusy(false)
    bumpGit(project.path)
    setReads((n) => n + 1)
    if (!done) return
    if (done.made) notify('success', done.notice)
    else notify('warning', done.notice, done.conflicts.length ? done.conflicts.join(', ') : undefined, [{ label: tr(T.openChanges), command: 'git.openOperation', args: [project.path, project.path] }])
  }

  const branchHere = async (): Promise<void> => {
    if (!d) return
    const summary = await attempt(tr(T.failed), () => call('git:summary', project.path))
    if (!summary) return
    onClose()
    // Loaded when used: GitBranches reads GitTab's words as it loads, and GitTab loads this dialog (an import cycle).
    const { newBranchDialog } = await import('../views/GitBranches')
    await newBranchDialog(project, summary, d.hash, folderBusy('create'))
  }

  const tagHere = async (): Promise<void> => {
    if (!d) return
    const summary = await attempt(tr(T.failed), () => call('git:summary', project.path))
    if (!summary) return
    setForm({ make: () => tagForm(project, summary, { hash: d.hash, short: d.short, subject: d.subject }) })
  }

  const card = d?.card ?? null
  const n = card ? cardNumberOf(card) : null
  const actionButton = (action: CommitAction): React.ReactNode => {
    const why = d ? (action === 'revert' ? d.revert : d.cherryPick) : null
    return (
      <Tooltip content={why ?? tr(T.actionTip, { action, branch: d?.branch ?? '' })}>
        <button type="button" className="btn small" data-action={`commit-${action}`} data-why={why ? '' : undefined} disabled={!d || !!why || busy} onClick={() => void act(action)}>
          {busy && <Icon name="loading" spin />} {tr(action === 'revert' ? T.revert : T.cherryPick)}
        </button>
      </Tooltip>
    )
  }

  return (
    <Modal title={tr(T.title, { commit: d?.short ?? commit.slice(0, 7) })} icon="git-commit" onClose={onClose} wide footer={<button className="btn" onClick={onClose}>{tr(T.close)}</button>}>
      {detail?.error ? (
        <div className="banner warn" data-commit-error="">
          {tr(T.loadFailed, { error: detail.error })}
        </div>
      ) : !d ? (
        <p className="hint">
          <Icon name="loading" spin /> {tr(T.loading)}
        </p>
      ) : (
        <div className="commit-dialog" data-commit-dialog={d.hash}>
          <div className="commit-head">
            <strong className="commit-subject">{d.subject}</strong>
            {card && n !== null && (
              <Tooltip content={tr(T.openCard, { card })}>
                <button type="button" className="btn small subtle" data-action="commit-card" onClick={() => set({ taskOpen: n })}>
                  {card}
                </button>
              </Tooltip>
            )}
          </div>
          {d.message.split(/\r?\n/).slice(1).join('\n').trim() && <pre className="commit-body">{d.message.split(/\r?\n/).slice(1).join('\n').trim()}</pre>}
          <div className="commit-meta faint">
            <code data-commit-hash="">{d.hash}</code>
            <button type="button" className="btn small subtle" data-action="commit-copy" onClick={() => void navigator.clipboard.writeText(d.hash).then(() => notify('success', tr(T.copied, { commit: d.hash })))}>
              <Icon name="copy" /> {tr(T.copy)}
            </button>
            <span>{tr(T.meta, { author: d.author, when: formatDateTime(d.date) })}</span>
          </div>
          {offered('git:commitAction') && (
            <div className="commit-actions">
              {actionButton('revert')}
              {actionButton('cherryPick')}
              {offered('git:createBranch') && (
                <button type="button" className="btn small" data-action="commit-branch" onClick={() => void branchHere()}>
                  {tr(T.branchHere)}
                </button>
              )}
              {offered('git:createTag') && (
                <button type="button" className="btn small" data-action="commit-tag" onClick={() => void tagHere()}>
                  {tr(T.tagHere)}
                </button>
              )}
            </div>
          )}
          <div className="commit-body-split">
            <div className="commit-files" data-commit-files={d.files.length}>
              <div className="faint">{tr(T.files, { n: d.files.length })}</div>
              {d.files.map((f) => (
                <div key={f.path} className={cx('row', file === f.path && 'selected')} data-commit-file={f.path} onClick={() => setFile(f.path)}>
                  <span className="label">{f.path}</span>
                  <span className={cx('git-status', f.status)}>{f.status /* i18n-ignore: git's status letter */}</span>
                </div>
              ))}
            </div>
            <div className="commit-diff" data-commit-diff={file ?? ''}>
              {!file ? null : shownDiff?.error ? (
                <div className="empty-state">
                  <Icon name="error" /> {tr(T.diffFailed, { error: shownDiff.error })}
                </div>
              ) : !shownDiff?.diff ? (
                <div className="empty-state">
                  <Icon name="loading" spin />
                </div>
              ) : shownDiff.diff.binary ? (
                <div className="empty-state">{shownDiff.diff.modified || tr(T.binary)}</div>
              ) : (
                <div className="editor-host">
                  <DiffView original={shownDiff.diff.original} modified={shownDiff.diff.modified} language={languageFor(shownDiff.diff.path)} inline={false} />
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}
