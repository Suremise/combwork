// HI-3218: a card revision's own changes, in the card dialog: its files, and the one chosen shown in the diff editor from
// the submission's base to its revision (tasks:revisionDiff), never the working tree, so what is shown is what was
// submitted. Card HI-3219 adds line comments over it (DiffView's onEditor).
import { useEffect, useState } from 'react'
import type * as Monaco from 'monaco-editor'
import { msg, tr } from '@shared/i18n'
import type { GitDiff } from '@shared/types'
import type { WorkRevision } from '@shared/workflow/workView'
import type { LineCommentView } from '@shared/workflow/lineComments'
import { call, errorMessage } from '../api'
import { languageFor } from '../monacoLang'
import { cx } from '../util'
import { DiffView } from './Editors'
import { GitlinkDiff, GitlinkRow } from './GitlinkDiff'
import { CommentLayer } from './LineComments'
import { Icon, IconButton } from './ui'

const M = {
  reading: msg({ id: 'board.work.changes.reading', defaultMessage: 'Reading its changes…', description: "The card dialog's view of a revision's changes while the chosen file's diff is being read." }),
  failed: msg({ id: 'board.work.changes.failed', defaultMessage: 'Couldn’t read this file’s changes: {error}', description: "The card dialog's view of a revision's changes when the chosen file's diff couldn't be read. {error} is why, in the words of the error." }),
  retry: msg({ id: 'board.work.changes.retry', defaultMessage: 'Retry', description: "A button in the card dialog's view of a revision's changes, after a file's diff couldn't be read: reads it again." }),
  binary: msg({ id: 'board.work.changes.binary', defaultMessage: 'Binary file: no text to compare.', description: "In place of a file's diff in the card dialog's view of a revision's changes: the file is binary." }),
  between: msg({ id: 'board.work.changes.between', defaultMessage: '{base} ↔ {revision}', description: "Beside the file's name above its diff in the card dialog's view of a revision's changes: the two commits compared, the submission's base and its revision (short ids). Keep the arrow." }),
  files: msg({ id: 'board.work.changes.files', defaultMessage: 'Files in this revision', description: "The accessible name of the list of a revision's files in the card dialog's view of its changes: choosing one shows its diff." }),
  sideBySide: msg({ id: 'board.work.changes.sideBySide', defaultMessage: 'Side by side', description: "A button's tooltip above a file's diff in the card dialog's view of a revision's changes: shows the two versions side by side." }),
  openComments: msg({ id: 'board.work.changes.openComments', defaultMessage: '{n, plural, one {# open comment} other {# open comments}}', description: "Beside a file in the list of a revision's files in the card dialog (HI-3219): how many of the card's line comments on that file are open." }),
  inline: msg({ id: 'board.work.changes.inline', defaultMessage: 'Inline', description: "A button's tooltip above a file's diff in the card dialog's view of a revision's changes: shows the changes in one column." })
}

/** One revision's changes: its files (`r.files`), the chosen one's diff from base to revision, and its line comments (HI-3219). */
export function RevisionChanges({ card, r, short, comments, agentName }: { card: number; r: WorkRevision; short: (id: string) => string; comments: LineCommentView[]; agentName: (id: string | null) => string }) {
  const [editor, setEditor] = useState<Monaco.editor.IStandaloneDiffEditor | null>(null)
  const openOn = (p: string): number => comments.filter((c) => c.path === p && c.state === 'open').length
  const [path, setPath] = useState(r.files[0]?.path ?? '')
  const [diff, setDiff] = useState<GitDiff | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tries, setTries] = useState(0)
  const [inline, setInline] = useState(false)

  useEffect(() => {
    if (!path) return
    let live = true
    setDiff(null)
    setError(null)
    call('tasks:revisionDiff', card, r.submission, path).then(
      (d) => live && setDiff(d),
      (e) => live && setError(errorMessage(e))
    )
    return () => {
      live = false
    }
  }, [card, r.submission, path, tries])

  return (
    <div className="card-work-changes" data-revision-changes={r.submission}>
      <ul className="card-work-changes-files" aria-label={tr(M.files)}>
        {r.files.map((f) => (
          <li key={f.path}>
            <button type="button" className={cx('link', f.path === path && 'chosen')} aria-current={f.path === path || undefined} data-revision-file={f.path} onClick={() => setPath(f.path)}>
              <span className="card-work-file-status">{f.status}</span> {f.gitlink ? <GitlinkRow path={f.path} change={f.gitlink} className="gitlink-file" /> : f.path}
            </button>
            {openOn(f.path) > 0 && <span className="badge" data-file-comments={f.path}>{tr(M.openComments, { n: openOn(f.path) })}</span>}
          </li>
        ))}
      </ul>
      {diff ? (
        <>
          <div className="editor-toolbar compact">
            <Icon name="git-compare" />
            <span className="path">
              <strong>{diff.path}</strong> {r.base && r.revision && <span className="faint mono">{tr(M.between, { base: short(r.base), revision: short(r.revision) })}</span>}
            </span>
            <IconButton icon={inline ? 'split-horizontal' : 'list-flat'} title={tr(inline ? M.sideBySide : M.inline)} onClick={() => setInline(!inline)} />
          </div>
          {editor && !diff.binary && !diff.gitlink && <CommentLayer key={diff.path} editor={editor} card={card} submission={r.submission} path={diff.path} comments={comments.filter((c) => c.path === diff.path)} agentName={agentName} />}
          <div className="editor-host card-work-changes-diff" data-revision-diff={diff.path}>
            {diff.gitlink ? <GitlinkDiff diff={diff} change={diff.gitlink} inline={inline} /> : diff.binary ? <div className="empty-state">{diff.modified || tr(M.binary)}</div> : <DiffView original={diff.original} modified={diff.modified} language={languageFor(diff.path)} inline={inline} onEditor={setEditor} />}
          </div>
        </>
      ) : error ? (
        <div className="card-work-unread">
          <Icon name="error" /> {tr(M.failed, { error })}{' '}
          <button type="button" className="btn small" onClick={() => setTries((n) => n + 1)}>
            {tr(M.retry)}
          </button>
        </div>
      ) : (
        <div className="faint">{tr(M.reading)}</div>
      )}
    </div>
  )
}
