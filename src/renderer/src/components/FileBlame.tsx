import { useEffect, useRef, useState } from 'react'
import type * as Monaco from 'monaco-editor'
import { ageShade, blamePick, type BlameResult } from '@shared/fileBlame'
import { formatDateTime } from '@shared/dates'
import { msg, tr } from '@shared/i18n'
import { call, errorMessage } from '../api'
import { set } from '../store'
import { cx, timeAgo } from '../util'
import type { HistoryPick } from './FileHistory'
import { Icon, Tooltip } from './ui'

// HI-3476: blame by card in the Files tab's viewer (SPEC §8, Blame by card): a column beside the editor naming, for
// each run of lines one commit last changed, that commit's card (click: open it) and the agent that submitted it, else
// the commit and its author, with its age, faded the older it is. Clicking the rest opens the commit's diff of the file
// over the editor (History's). The file as the editor has it is what's blamed: unsaved and uncommitted lines are "Not
// committed yet". Read again a moment after typing stops; an answer for any other folder, file or text is dropped, and
// the window's request for it is stopped (its git ended) when it is no longer wanted.

export const FILE_BLAME_TEXT = {
  toggle: msg({ id: 'files.blame.toggle', defaultMessage: 'Blame by card', description: "HI-3476: the Files tab's toolbar button (and right-click menu item) that shows or hides, beside the editor, which card and agent last changed each line." }),
  toggleTip: msg({ id: 'files.blame.toggleTip', defaultMessage: 'Which card and agent last changed each line', description: "HI-3476: the tooltip of the Files tab's Blame by card button." }),
  loading: msg({ id: 'files.blame.loading', defaultMessage: 'Reading who changed each line…', description: 'HI-3476: atop the blame column while git reads it.' }),
  failed: msg({ id: 'files.blame.failed', defaultMessage: "Couldn't read who changed each line: {error}", description: 'HI-3476: a bar over the editor when reading the blame failed. {error} is why.' }),
  retry: msg({ id: 'files.blame.retry', defaultMessage: 'Try again', description: "HI-3476: the blame bar's button after reading it failed." }),
  untracked: msg({ id: 'files.blame.untracked', defaultMessage: "Git has no committed version of this file yet: there's nothing to blame.", description: "HI-3476: a bar over the editor when Blame by card is on for a file git doesn't track, or that isn't in the last commit (new, renamed and not committed)." }),
  large: msg({ id: 'files.blame.large', defaultMessage: 'This file has {lines, number} lines: reading who changed each one may take a while.', description: "HI-3476: a bar over the editor before blaming a file longer than Settings → Advanced's limit." }),
  blameAnyway: msg({ id: 'files.blame.blameAnyway', defaultMessage: 'Blame it', description: "HI-3476: the button on the long file's bar: reads the blame anyway." }),
  uncommitted: msg({ id: 'files.blame.uncommitted', defaultMessage: 'Not committed yet', description: "HI-3476: the blame column beside lines no commit has: the editor's unsaved edits, or changes not committed." }),
  openCard: msg({ id: 'files.blame.openCard', defaultMessage: 'Open {card}: {title}', description: "HI-3476: the tooltip of a card in the blame column. {card} is its key (HI-12), {title} its title." }),
  commitTip: msg({ id: 'files.blame.commitTip', defaultMessage: '{subject}\n{author} · {when} · {commit}\nClick to see what this commit changed in the file.', description: "HI-3476: the tooltip of an annotation in the blame column (keep the line breaks): the commit's message's first line, its author, when (a date and time) and short id." }),
  submittedByTip: msg({ id: 'files.blame.submittedByTip', defaultMessage: "{agent} submitted this commit for review in one of {card}'s submissions. It doesn't say who wrote it: git records one author for everyone here.", description: "HI-3476: the tooltip of the agent in the blame column. {agent} is the agent's name, {card} the card's key." })
}
const T = FILE_BLAME_TEXT

/** How long after the last keystroke the blame is read again. */
const SETTLE_MS = 800

let requests = 0

type Shown = { for: string; result: BlameResult } | { for: string; error: string }

/** HI-3476: the blame column beside `editor`, for `rel` in the folder `root` with the editor's `text`. */
export function BlameColumn({ root, rel, text, editor, onOpenCommit }: { root: string; rel: string; text: string; editor: Monaco.editor.IStandaloneCodeEditor | null; onOpenCommit: (pick: HistoryPick) => void }) {
  const [shown, setShown] = useState<Shown | null>(null)
  const [large, setLarge] = useState(false)
  const [reads, setReads] = useState(0)
  const [, setFrame] = useState(0)
  const id = useRef(`blame-${++requests}`)
  const key = `${root}\n${rel}\n${text}`
  const latest = useRef(key)
  latest.current = key

  // Read a moment after the text settles (at once the first time and when asked again); a reply for another text is dropped.
  useEffect(() => {
    let live = true
    const wait = shown === null ? 0 : SETTLE_MS
    const timer = setTimeout(() => {
      const asked = key
      void call('files:blame', root, rel, text, large, id.current).then(
        (result) => live && latest.current === asked && setShown({ for: asked, result }),
        (e) => live && latest.current === asked && setShown({ for: asked, error: errorMessage(e) })
      )
    }, wait)
    return () => {
      live = false
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, large, reads])

  // Gone: stop its git.
  useEffect(() => () => void call('files:blameCancel', id.current).catch(() => undefined), [])

  // Follow the editor: drawn again as it scrolls, lays out or changes.
  useEffect(() => {
    if (!editor) return
    const redraw = (): void => setFrame((n) => n + 1)
    const subs = [editor.onDidScrollChange(redraw), editor.onDidLayoutChange(redraw), editor.onDidChangeModelContent(redraw)]
    return () => subs.forEach((s) => s.dispose())
  }, [editor])

  // HR1's round 1 finding 3: only an answer for the text the editor has now is drawn. One for an earlier text (lines
  // typed above, deleted) would put its commits beside the wrong lines, so until the next answer the column is empty.
  const current = shown && shown.for === key ? shown : null
  const result = current && 'result' in current ? current.result : null
  const bar = (): React.ReactNode => {
    if (current && 'error' in current)
      return (
        <div className="banner warn blame-bar" data-blame-error="">
          {tr(T.failed, { error: current.error })}{' '}
          <button className="btn small" onClick={() => setReads((n) => n + 1)}>
            {tr(T.retry)}
          </button>
        </div>
      )
    if (result?.kind === 'untracked') return <div className="banner info blame-bar" data-blame-untracked="">{tr(T.untracked)}</div>
    if (result?.kind === 'large')
      return (
        <div className="banner info blame-bar" data-blame-large={result.lines}>
          {tr(T.large, { lines: result.lines })}{' '}
          <button className="btn small" data-action="blame-anyway" onClick={() => setLarge(true)}>
            {tr(T.blameAnyway)}
          </button>
        </div>
      )
    return null
  }

  const entries: React.ReactNode[] = []
  if (editor && result?.kind === 'blame') {
    const scroll = editor.getScrollTop()
    const visible = editor.getVisibleRanges()
    const first = visible[0]?.startLineNumber ?? 1
    const last = visible[visible.length - 1]?.endLineNumber ?? 0
    const dates = Object.values(result.commits).map((c) => c.date)
    const newest = Math.max(...dates, 0)
    const oldest = Math.min(...dates, newest)
    const lineCount = editor.getModel()?.getLineCount() ?? 0
    for (const b of result.blocks) {
      const end = b.start + b.count - 1
      if (end < first || b.start > last || b.start > lineCount) continue
      const top = editor.getTopForLineNumber(Math.max(b.start, first)) - scroll
      const bottom = editor.getBottomForLineNumber(Math.min(end, last, lineCount)) - scroll
      const c = b.commit ? result.commits[b.commit] : null
      const style = { top, height: Math.max(0, bottom - top) }
      if (!c) {
        entries.push(
          <div key={`u${b.start}`} className="blame-block uncommitted" style={style} data-blame-line={b.start}>
            <span className="faint">{tr(T.uncommitted)}</span>
          </div>
        )
        continue
      }
      const shade = ageShade(c.date, newest, oldest)
      entries.push(
        <div key={`${b.start}`} className="blame-block" style={{ ...style, ['--blame-age' as string]: String(shade) }} data-blame-line={b.start} data-blame-commit={c.hash}>
          {c.card && (
            <Tooltip content={tr(T.openCard, { card: c.card.key, title: c.card.title })}>
              <button type="button" className="btn small subtle blame-card" data-blame-card={c.card.key} onClick={() => set({ taskOpen: c.card!.number })}>
                {c.card.key}
              </button>
            </Tooltip>
          )}
          <Tooltip content={tr(T.commitTip, { subject: c.subject, author: c.author, when: formatDateTime(c.date), commit: c.hash.slice(0, 7) })}>
            <button type="button" className="blame-who" data-action="blame-commit" onClick={() => onOpenCommit(blamePick(c))}>
              {c.card && c.submittedBy ? (
                <Tooltip content={tr(T.submittedByTip, { agent: c.submittedBy.name, card: c.card.key })}>
                  <span className="blame-agent" data-blame-agent={c.submittedBy.agent}>
                    {c.submittedBy.name}
                  </span>
                </Tooltip>
              ) : c.card ? (
                <span>{c.author}</span>
              ) : (
                <span>
                  <code>{c.hash.slice(0, 7)}</code> {c.author}
                </span>
              )}
              <span className="faint"> · {timeAgo(new Date(c.date).toISOString())}</span>
            </button>
          </Tooltip>
        </div>
      )
    }
  }

  const loading = !current
  return (
    <>
      {bar()}
      <div className={cx('blame-column', loading && 'loading')} data-blame-column={result?.kind === 'blame' ? result.blocks.length : ''} aria-busy={loading}>
        {loading && (
          <div className="blame-loading faint" title={tr(T.loading)}>
            <Icon name="loading" spin />
          </div>
        )}
        {entries}
      </div>
    </>
  )
}
