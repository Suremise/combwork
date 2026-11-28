import { useEffect, useRef, useState } from 'react'
import type { ProjectInfo } from '@shared/types'
import type { CommitIntro, FileHistoryFile, FileHistoryPage, FileHistoryRow, FileSide, FileVersions } from '@shared/fileHistory'
import { formatDateTime } from '@shared/dates'
import { msg, tr } from '@shared/i18n'
import { call, errorMessage } from '../api'
import { languageFor } from '../monacoLang'
import { set } from '../store'
import { cx, timeAgo } from '../util'
import { DiffView } from './Editors'
import { PaneResizer, usePaneSize } from './Resizer'
import { Icon, IconButton, Tooltip } from './ui'

// HI-3475: the Files tab's History panel (SPEC §8, A file's history): the commits that changed the file (following its
// renames) or folder shown, on the folder's checked-out line, newest first, read from one commit pinned on its first
// page. Each row has the card its commit names (opening it) and the agent that submitted it, with the author and date;
// a row's diff of the file opens over the editor (HistoryDiff), which keeps the file's edits; Open commit shows the
// Commit dialog in the project folder. A commit naming no card can say which merge brought it in, asked for row by row.

export const FILE_HISTORY_TEXT = {
  title: msg({ id: 'files.history.title', defaultMessage: 'History', description: "HI-3475: the heading of the Files tab's History panel: the commits that changed the file or folder selected." }),
  toggle: msg({ id: 'files.history.toggle', defaultMessage: 'History', description: "HI-3475: the Files tab's toolbar button (and right-click menu item) that shows or hides the History panel: the commits that changed the file or folder." }),
  toggleTip: msg({ id: 'files.history.toggleTip', defaultMessage: 'The commits that changed this, with their cards', description: "HI-3475: the tooltip of the Files tab's History button." }),
  close: msg({ id: 'files.history.close', defaultMessage: 'Close History', description: "HI-3475: the tooltip of the History panel's close button." }),
  refresh: msg({ id: 'files.history.refresh', defaultMessage: 'Refresh', description: "HI-3475: the History panel's button: reads the history again from the folder's current commit." }),
  pick: msg({ id: 'files.history.pick', defaultMessage: 'Select one file or folder to see its history.', description: "HI-3475: the History panel when nothing, or several items, are selected in the Files tab." }),
  loading: msg({ id: 'files.history.loading', defaultMessage: 'Reading the history…', description: 'HI-3475: the History panel while it reads the commits.' }),
  failed: msg({ id: 'files.history.failed', defaultMessage: "Couldn't read the history: {error}", description: 'HI-3475: the History panel when reading it failed. {error} is why.' }),
  retry: msg({ id: 'files.history.retry', defaultMessage: 'Try again', description: "HI-3475: the History panel's button after reading failed." }),
  none: msg({ id: 'files.history.none', defaultMessage: 'No commit has changed this yet.', description: 'HI-3475: the History panel for a file or folder no commit has changed (new, or not tracked by git).' }),
  more: msg({ id: 'files.history.more', defaultMessage: 'Show more', description: "HI-3475: the button at the end of the History panel's list: reads the next page of older commits." }),
  moved: msg({ id: 'files.history.moved', defaultMessage: 'The branch has moved since this list was read.', description: "HI-3475: a bar atop the History panel: the folder's checked-out commit changed (a commit, a switch) since the list was read; Refresh reads it again." }),
  openCard: msg({ id: 'files.history.openCard', defaultMessage: 'Open {card}: {title}', description: "HI-3475: the tooltip of a commit's card in the History panel. {card} is its key (HI-12), {title} its title." }),
  cardHow: msg({ id: 'files.history.cardHow', defaultMessage: '{how, select, trailer {Named by the commit’s Combwork-Card trailer.} attributed {Combwork recorded this commit as the card’s when it was made.} other {Named at the start of the commit’s message.}}', description: "HI-3475: under the card's tooltip in the History panel: how the commit was linked to the card. Combwork-Card is a commit trailer's name: keep it. Keep the select keys." }),
  submittedBy: msg({ id: 'files.history.submittedBy', defaultMessage: 'submitted by {agent}', description: "HI-3475: in a History row, after the card: the agent ({agent}, its name) that submitted this commit for review in one of the card's submissions. Not who wrote it." }),
  submittedByTip: msg({ id: 'files.history.submittedByTip', defaultMessage: "{agent} submitted this commit for review in one of {card}'s submissions. It doesn't say who wrote it: git records one author for everyone here.", description: "HI-3475: the tooltip of 'submitted by' in a History row. {agent} is the agent's name, {card} the card's key." }),
  meta: msg({ id: 'files.history.meta', defaultMessage: '{author} · {when}', description: "HI-3475: in a History row: the commit's author and how long ago it was made (\"3 days ago\")." }),
  renamed: msg({ id: 'files.history.renamed', defaultMessage: 'Renamed from {path}', description: "HI-3475: in a History row: this commit renamed the file; {path} is the path it had before." }),
  files: msg({ id: 'files.history.files', defaultMessage: '{n, plural, one {# file} other {# files}}', description: "HI-3475: in a folder's History row: how many files under the folder the commit changed (click to list them)." }),
  findMerge: msg({ id: 'files.history.findMerge', defaultMessage: 'Find its merge', description: "HI-3475: a History row's button for a commit naming no card: looks for the merge that brought it into the branch, and that merge's card." }),
  findMergeTip: msg({ id: 'files.history.findMergeTip', defaultMessage: "This commit names no card. Looks for the merge that brought it into the branch, and the card that merge names. It doesn't say the card made this commit.", description: "HI-3475: the tooltip of a History row's Find its merge button." }),
  cameIn: msg({ id: 'files.history.cameIn', defaultMessage: "Came in with {card}'s merge", description: "HI-3475: a History row, after Find its merge: the merge that brought the commit into the branch names the card {card} (its key). The card merged it, it didn't necessarily make it." }),
  cameInPlain: msg({ id: 'files.history.cameInPlain', defaultMessage: 'Came in with merge {commit}, which names no card', description: "HI-3475: a History row, after Find its merge: the merge that brought the commit in ({commit}, a short id) names no card." }),
  noMerge: msg({ id: 'files.history.noMerge', defaultMessage: 'No merge brought it in that Combwork can name', description: "HI-3475: a History row, after Find its merge: the commit was made on the branch itself, or how it came in isn't clear (several branches merged at once), so nothing is said." }),
  compareThis: msg({ id: 'files.history.compareThis', defaultMessage: 'Compare with this version', description: "HI-3478: a History row's button (a file's history): compares the file as the editor has it with its version at this commit." }),
  openCommit: msg({ id: 'files.history.openCommit', defaultMessage: 'Open commit', description: "HI-3475: a History row's button: opens the Commit dialog (the commit's message, files and actions)." }),
  copyHash: msg({ id: 'files.history.copyHash', defaultMessage: 'Copy hash {commit}', description: "HI-3475: the tooltip of a History row's short commit id: copies the full hash. {commit} is the full hash." }),
  back: msg({ id: 'files.history.back', defaultMessage: 'Back to file', description: "HI-3475: the button atop a commit's diff opened from History: shows the file's editor again, as it was left (unsaved edits kept)." }),
  diffTitle: msg({ id: 'files.history.diffTitle', defaultMessage: '{commit} · {subject}', description: "HI-3475: the heading of a commit's diff of a file opened from History: its short id and its message's first line." }),
  diffPaths: msg({ id: 'files.history.diffPaths', defaultMessage: '{from} → {to}', description: "HI-3475: under a commit's diff from History, when the commit renamed the file: its path before and after." }),
  notThere: msg({ id: 'files.history.notThere', defaultMessage: '{side, select, left {Before this commit: not in that version} other {After this commit: not in that version}}', description: "HI-3475: above a commit's diff from History when one side has no file: the commit added the file (left) or deleted it (right). Keep the select keys." }),
  notFile: msg({ id: 'files.history.notFile', defaultMessage: '{side, select, left {Before this commit: a folder or submodule, not a file} other {After this commit: a folder or submodule, not a file}}', description: "HI-3475: above a commit's diff from History when one side is a folder or a submodule at that path. Keep the select keys." }),
  diffFailed: msg({ id: 'files.history.diffFailed', defaultMessage: "Couldn't show the commit's changes: {error}", description: "HI-3475: in place of a commit's diff from History when reading it failed. {error} is why." }),
  binary: msg({ id: 'files.history.binary', defaultMessage: 'Binary file', description: "HI-3475: in place of a commit's diff from History when the file is binary." })
}
const T = FILE_HISTORY_TEXT

/** A row's file and the commit's diff of it, as History opened it. */
export interface HistoryPick {
  row: FileHistoryRow
  file: FileHistoryFile
}

/** What a page of History was read from: the folder, the item and the commit pinned; a later page adds to it only when the same. */
const stampOf = (root: string, rel: string, head: string | null): string => `${root}\n${rel}\n${head ?? ''}`

/** HI-3475: the History panel of `rel` (a file or folder, null: nothing to show) in the folder shown. */
export function FileHistoryPanel({
  project,
  item,
  picked,
  onPick,
  onOpenCommit,
  onCompare,
  onClose
}: {
  project: ProjectInfo
  item: { rel: string; isDir: boolean } | null
  picked: HistoryPick | null
  onPick: (p: HistoryPick) => void
  /** Null: the folder shown isn't the project folder, where the Commit dialog works. */
  onOpenCommit: ((row: FileHistoryRow, file: FileHistoryFile | null) => void) | null
  /** HI-3478: Compare with this version (a file's history only): the row's commit at the path it had there. */
  onCompare?: ((row: FileHistoryRow, file: FileHistoryFile) => void) | null
  onClose: () => void
}) {
  const width = usePaneSize('fileHistory', 340)
  const [pages, setPages] = useState<{ stamp: string; head: string | null; moved: boolean; rows: FileHistoryRow[]; page: number; more: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [reads, setReads] = useState(0)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [intros, setIntros] = useState<Record<string, CommitIntro | null | 'loading' | { error: string }>>({})
  // Each item (or Refresh) is a new generation: a reply to an earlier one (another file, another folder) is dropped.
  const gen = useRef(0)
  const root = project.path
  const rel = item?.rel ?? null
  const isDir = !!item?.isDir

  const read = async (page: number, head: string | null): Promise<void> => {
    if (rel === null) return
    const g = gen.current
    setLoading(true)
    try {
      const got: FileHistoryPage = await call('files:history', root, rel, isDir, head, page)
      if (gen.current !== g) return
      const pinned = stampOf(root, rel, got.head)
      setPages((p) => ({ stamp: pinned, head: got.head, moved: got.moved, rows: page > 1 && p?.stamp === pinned ? [...p.rows, ...got.rows] : got.rows, page: got.page, more: got.more }))
      setError(null)
    } catch (e) {
      if (gen.current === g) setError(errorMessage(e))
    } finally {
      if (gen.current === g) setLoading(false)
    }
  }

  useEffect(() => {
    gen.current++
    setPages(null)
    setError(null)
    setLoading(false)
    setOpen({})
    setIntros({})
    if (rel !== null) void read(1, null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, rel, isDir, reads])

  const findMerge = async (row: FileHistoryRow): Promise<void> => {
    if (!pages?.head) return
    const head = pages.head
    const g = gen.current
    setIntros((x) => ({ ...x, [row.hash]: 'loading' }))
    try {
      const got = await call('files:historyIntro', root, head, row.hash)
      if (gen.current === g) setIntros((x) => ({ ...x, [row.hash]: got }))
    } catch (e) {
      if (gen.current === g) setIntros((x) => ({ ...x, [row.hash]: { error: errorMessage(e) } }))
    }
  }

  const rows = pages?.rows ?? []
  const body = (): React.ReactNode => {
    if (rel === null) return <p className="hint">{tr(T.pick)}</p>
    if (error && !pages)
      return (
        <div className="banner warn" data-history-error="">
          {tr(T.failed, { error })}{' '}
          <button className="btn small" onClick={() => setReads((n) => n + 1)}>
            {tr(T.retry)}
          </button>
        </div>
      )
    if (!pages)
      return (
        <p className="hint">
          <Icon name="loading" spin /> {tr(T.loading)}
        </p>
      )
    if (!rows.length) return <p className="hint" data-history-empty="">{tr(T.none)}</p>
    return (
      <>
        {rows.map((r) => (
          <HistoryRow
            key={r.hash}
            row={r}
            isDir={isDir}
            open={!!open[r.hash]}
            picked={picked && picked.row.hash === r.hash ? picked.file.path : null}
            intro={intros[r.hash]}
            onToggle={() => setOpen((o) => ({ ...o, [r.hash]: !o[r.hash] }))}
            onPick={(file) => onPick({ row: r, file })}
            onFindMerge={() => void findMerge(r)}
            onOpenCommit={onOpenCommit}
            onCompare={onCompare ?? null}
          />
        ))}
        {error && <div className="banner warn">{tr(T.failed, { error })}</div>}
        {pages.more && (
          <button className="btn small subtle history-more" disabled={loading} data-action="history-more" onClick={() => void read(pages.page + 1, pages.head)}>
            {loading && <Icon name="loading" spin />} {tr(T.more)}
          </button>
        )}
      </>
    )
  }

  return (
    <div className="file-history" style={{ flex: `0 0 ${width}px` }} data-file-history={rel ?? ''}>
      <PaneResizer paneKey="fileHistory" edge="left" min={240} max={720} />
      <div className="file-history-head">
        <Icon name="history" />
        <strong>{tr(T.title)}</strong>
        {rel !== null && <span className="faint path">{rel || project.name}</span>}
        <span className="spacer" />
        {rel !== null && <IconButton icon="refresh" title={tr(T.refresh)} onClick={() => setReads((n) => n + 1)} />}
        <IconButton icon="close" title={tr(T.close)} onClick={onClose} />
      </div>
      {pages?.moved && (
        <div className="banner info" data-history-moved="">
          {tr(T.moved)}{' '}
          <button className="btn small" data-action="history-refresh" onClick={() => setReads((n) => n + 1)}>
            {tr(T.refresh)}
          </button>
        </div>
      )}
      <div className="file-history-list">{body()}</div>
    </div>
  )
}

function HistoryRow({
  row,
  isDir,
  open,
  picked,
  intro,
  onToggle,
  onPick,
  onFindMerge,
  onOpenCommit,
  onCompare
}: {
  row: FileHistoryRow
  isDir: boolean
  open: boolean
  picked: string | null
  intro: CommitIntro | null | 'loading' | { error: string } | undefined
  onToggle: () => void
  onPick: (file: FileHistoryFile) => void
  onFindMerge: () => void
  onOpenCommit: ((row: FileHistoryRow, file: FileHistoryFile | null) => void) | null
  onCompare: ((row: FileHistoryRow, file: FileHistoryFile) => void) | null
}) {
  const file = isDir ? null : (row.files[0] ?? null)
  const card = row.card
  const click = (): void => {
    if (isDir) onToggle()
    else if (file) onPick(file)
  }
  return (
    <div className={cx('history-row', picked !== null && !isDir && 'selected')} data-history-row={row.hash}>
      <div className="history-main" onClick={click} role="button" tabIndex={0} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), click())}>
        <div className="history-subject" title={row.subject}>
          {isDir && <Icon name={open ? 'chevron-down' : 'chevron-right'} />}
          {row.subject}
        </div>
        <div className="history-meta">
          {card && (
            <Tooltip content={`${tr(T.openCard, { card: card.key, title: card.title })}\n${tr(T.cardHow, { how: card.how })}`}>
              <button
                type="button"
                className="btn small subtle history-card"
                data-history-card={card.key}
                onClick={(e) => {
                  e.stopPropagation()
                  set({ taskOpen: card.number })
                }}
              >
                {card.key}
              </button>
            </Tooltip>
          )}
          {card && row.submittedBy && (
            <Tooltip content={tr(T.submittedByTip, { agent: row.submittedBy.name, card: card.key })}>
              <span className="history-agent" data-history-agent={row.submittedBy.agent}>
                {tr(T.submittedBy, { agent: row.submittedBy.name })}
              </span>
            </Tooltip>
          )}
          <span className="faint" title={`${row.email} · ${formatDateTime(row.date)}`}>
            {tr(T.meta, { author: row.author, when: timeAgo(new Date(row.date).toISOString()) })}
          </span>
        </div>
        {file?.oldPath && <div className="faint small">{tr(T.renamed, { path: file.oldPath })}</div>}
        {isDir && <div className="faint small">{tr(T.files, { n: row.files.length })}</div>}
      </div>
      <div className="history-side">
        <Tooltip content={tr(T.copyHash, { commit: row.hash })}>
          <button type="button" className="btn small subtle history-hash" onClick={() => void navigator.clipboard.writeText(row.hash)}>
            <code>{row.short}</code>
          </button>
        </Tooltip>
        {onCompare && file && file.status !== 'D' && <IconButton icon="git-compare" title={tr(T.compareThis)} action="history-compare" onClick={() => onCompare(row, file)} />}
        {onOpenCommit && <IconButton icon="git-commit" title={tr(T.openCommit)} onClick={() => onOpenCommit(row, file)} />}
      </div>
      {!card && (
        <div className="history-intro" data-history-intro={row.hash}>
          {intro === undefined ? (
            <Tooltip content={tr(T.findMergeTip)}>
              <button type="button" className="btn small subtle" data-action="history-find-merge" onClick={onFindMerge}>
                {tr(T.findMerge)}
              </button>
            </Tooltip>
          ) : intro === 'loading' ? (
            <Icon name="loading" spin />
          ) : intro === null ? (
            <span className="faint">{tr(T.noMerge)}</span>
          ) : 'error' in intro ? (
            <span className="faint">{intro.error}</span>
          ) : intro.card ? (
            <Tooltip content={tr(T.openCard, { card: intro.card.key, title: intro.card.title })}>
              <button type="button" className="btn small subtle" data-history-came-in={intro.card.key} onClick={() => set({ taskOpen: intro.card!.number })}>
                {tr(T.cameIn, { card: intro.card.key })}
              </button>
            </Tooltip>
          ) : (
            <span className="faint">{tr(T.cameInPlain, { commit: intro.short })}</span>
          )}
        </div>
      )}
      {isDir && open && (
        <div className="history-files">
          {row.files.map((f) => (
            <div key={f.path} className={cx('row', picked === f.path && 'selected')} data-history-file={f.path} onClick={() => onPick(f)}>
              <span className="label">{f.path}</span>
              <span className={cx('git-status', f.status)}>{f.status /* i18n-ignore: git's status letter */}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** The two sides of a commit's change to a file: the parent at the path it had there, the commit at its own. */
export function sidesOf(row: FileHistoryRow, file: FileHistoryFile): { left: FileSide | null; right: FileSide | null } {
  const left = row.parent && file.status !== 'A' ? { commit: row.parent, path: file.oldPath ?? file.path } : null
  const right = file.status === 'D' ? null : { commit: row.hash, path: file.path }
  return { left, right }
}

/** HI-3475: a commit's diff of one file, opened from History over the editor (which stays as it was), with Back to file. */
export function HistoryDiff({ root, pick, onBack }: { root: string; pick: HistoryPick; onBack: () => void }) {
  const { row, file } = pick
  const [got, setGot] = useState<{ for: string; diff: FileVersions | null; error?: string } | null>(null)
  const key = `${root}\n${row.hash}\n${file.path}`
  useEffect(() => {
    let live = true
    const { left, right } = sidesOf(row, file)
    void call('files:historyDiff', root, left, right).then(
      (diff) => live && setGot({ for: key, diff }),
      (e) => live && setGot({ for: key, diff: null, error: errorMessage(e) })
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  const shown = got?.for === key ? got : null
  const d = shown?.diff ?? null
  const note = (side: 'left' | 'right', state: FileVersions['left']): React.ReactNode => (state === 'missing' ? <div className="faint small">{tr(T.notThere, { side })}</div> : state === 'notFile' ? <div className="faint small">{tr(T.notFile, { side })}</div> : null)
  return (
    <div className="history-diff" data-history-diff={`${row.hash}:${file.path}`}>
      <div className="history-diff-head">
        <button className="btn small" data-action="history-back" onClick={onBack}>
          <Icon name="arrow-left" /> {tr(T.back)}
        </button>
        <strong title={row.subject}>{tr(T.diffTitle, { commit: row.short, subject: row.subject })}</strong>
        {file.oldPath && <span className="faint">{tr(T.diffPaths, { from: file.oldPath, to: file.path })}</span>}
      </div>
      {d && note('left', d.left)}
      {d && note('right', d.right)}
      {shown?.error ? (
        <div className="empty-state">
          <Icon name="error" /> {tr(T.diffFailed, { error: shown.error })}
        </div>
      ) : !d ? (
        <div className="empty-state">
          <Icon name="loading" spin />
        </div>
      ) : d.binary ? (
        <div className="empty-state">{d.modified || tr(T.binary)}</div>
      ) : (
        <div className="editor-host">
          <DiffView original={d.original} modified={d.modified} language={languageFor(d.path)} inline={false} />
        </div>
      )}
    </div>
  )
}
