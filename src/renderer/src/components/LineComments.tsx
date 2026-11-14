// HI-3219: line comments over a card revision's diff (RevisionChanges, DiffView's onEditor). Hovering a line shows a "+" in
// either side's glyph margin; pressing it opens a Markdown box under the line (or the lines selected there, if the "+" is
// on one of them), as a Monaco view zone, and Ctrl+Enter saves it. Saved comments show as threads under their last line,
// with Edit, Resolve or Reopen, and Delete while unsent. They are the card's facts: main writes them
// (tasks:lineCommentAdd/Change) and the window reads them back with the card's work, so every change shows once written.
// A side the diff doesn't show (the original, inline) lists its comments above the diff instead.
import { createPortal } from 'react-dom'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type * as Monaco from 'monaco-editor'
import { msg, tr } from '@shared/i18n'
import { formatDateTime } from '@shared/dates'
import { LINE_COMMENT_LIMITS, type LineCommentView, type LineSide } from '@shared/workflow/lineComments'
import { call, errorMessage } from '../api'
import { cx, timeAgo } from '../util'
import { loadMonaco } from './Editors'
import { Markdown } from './ui'

const M = {
  add: msg({ id: 'board.work.comments.add', defaultMessage: 'Comment on this line, or on the lines selected', description: "The tooltip of the + beside a line of a card revision's diff (HI-3219): opens a box to comment on that line, or on the lines selected if it is beside one of them." }),
  placeholder: msg({ id: 'board.work.comments.placeholder', defaultMessage: 'Comment in Markdown (Ctrl+Enter to save)', description: "The empty comment box under a line of a card revision's diff: the comment is written in Markdown, and Ctrl+Enter saves it." }),
  save: msg({ id: 'board.work.comments.save', defaultMessage: 'Save', description: "A button under a line comment being written or edited on a card revision's diff: saves it." }),
  cancel: msg({ id: 'board.work.comments.cancel', defaultMessage: 'Cancel', description: "A button under a line comment being written or edited: drops what was typed." }),
  edit: msg({ id: 'board.work.comments.edit', defaultMessage: 'Edit', description: "A button on a line comment on a card revision's diff: changes its text." }),
  resolve: msg({ id: 'board.work.comments.resolve', defaultMessage: 'Resolve', description: "A button on an open line comment on a card revision's diff: marks it dealt with." }),
  reopen: msg({ id: 'board.work.comments.reopen', defaultMessage: 'Reopen', description: "A button on a resolved line comment on a card revision's diff: makes it open again." }),
  delete: msg({ id: 'board.work.comments.delete', defaultMessage: 'Delete', description: "A button on a line comment not yet sent to the card's builder: takes it back." }),
  resolved: msg({ id: 'board.work.comments.resolved', defaultMessage: 'Resolved', description: "A mark on a line comment on a card revision's diff: it was dealt with." }),
  edited: msg({ id: 'board.work.comments.edited', defaultMessage: 'edited', description: "A mark beside a line comment's time: its text was changed after it was written." }),
  you: msg({ id: 'board.work.comments.you', defaultMessage: 'You', description: "Who wrote a line comment on a card revision's diff, when it was the user." }),
  lines: msg({ id: 'board.work.comments.where', defaultMessage: '{side, select, old {Original} other {Changed}} {from}{same, select, yes {} other {–{to}}}', description: "Where a line comment is, above it: which side of the diff (old: the original file; other: the changed one) and its line, or its first and last lines (12–14): line numbers, never formatted as amounts. Keep the select keys." }),
  elsewhere: msg({ id: 'board.work.comments.elsewhere', defaultMessage: 'Comments on the original side (shown side by side)', description: "A heading above a card revision's diff while it shows inline: the comments on lines of the original file, which the inline diff doesn't show, are listed here; side by side shows them on their lines." }),
  count: msg({ id: 'board.work.comments.length', defaultMessage: '{n, number} / {max, number}', description: "Under a line comment being written: how many characters it has, of the most it may have." })
}

type Draft = { side: LineSide; from: number; to: number }
type Change = { edit: { body: string; version: number } } | 'resolve' | 'reopen' | 'delete'
type Zone = { key: string; side: LineSide; id: string; zone: Monaco.editor.IViewZone; node: HTMLDivElement }

/** The comment layer over `editor` (a revision's diff of `path`): its threads, its draft, its "+" in each glyph margin. */
export function CommentLayer({ editor, card, submission, path, comments, agentName }: { editor: Monaco.editor.IStandaloneDiffEditor; card: number; submission: number; path: string; comments: LineCommentView[]; agentName: (id: string | null) => string }) {
  const [draft, setDraft] = useState<Draft | null>(null)
  const [zones, setZones] = useState<Zone[]>([])
  const [oldHidden, setOldHidden] = useState(false)
  const sideEditor = (side: LineSide): Monaco.editor.ICodeEditor => (side === 'new' ? editor.getModifiedEditor() : editor.getOriginalEditor())

  // The "+" on the line under the mouse, in either side's glyph margin; pressing it opens a draft there.
  useEffect(() => {
    let gone = false
    const subs: Monaco.IDisposable[] = []
    void loadMonaco().then(({ monaco }) => {
      if (gone) return
      for (const side of ['new', 'old'] as const) {
        const ed = sideEditor(side)
        ed.updateOptions({ glyphMargin: true })
        const hover = ed.createDecorationsCollection()
        subs.push({ dispose: () => hover.clear() })
        subs.push(ed.onMouseMove((e) => {
          const line = e.target.position?.lineNumber
          hover.set(line ? [{ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: 'cw-comment-add', glyphMarginHoverMessage: { value: tr(M.add) } } }] : [])
        }))
        subs.push(ed.onMouseLeave(() => hover.clear()))
        subs.push(ed.onMouseDown((e) => {
          if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return
          const line = e.target.position?.lineNumber
          if (!line) return
          const sel = ed.getSelection()
          // The lines selected, if the "+" is on one of them (a selection ending at a line's start leaves that line out).
          const last = sel && sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber ? sel.endLineNumber - 1 : (sel?.endLineNumber ?? line)
          const inSel = !!sel && !sel.isEmpty() && sel.startLineNumber <= line && line <= last
          setDraft({ side, from: inSel ? sel.startLineNumber : line, to: inSel ? last : line })
        }))
      }
      // Inline, the original side isn't shown: its comments go above the diff.
      const check = (): void => setOldHidden((editor.getOriginalEditor().getDomNode()?.offsetWidth ?? 0) === 0)
      check()
      subs.push(editor.getModifiedEditor().onDidLayoutChange(check))
    })
    return () => {
      gone = true
      subs.forEach((s) => s.dispose())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])

  // What shows under each line: its side's threads ending there, and the draft.
  const spots = useMemo(() => {
    const by = new Map<string, { side: LineSide; line: number; items: LineCommentView[]; draft: Draft | null }>()
    const at = (side: LineSide, line: number) => {
      const key = `${side}:${line}`
      if (!by.has(key)) by.set(key, { side, line, items: [], draft: null })
      return by.get(key)!
    }
    for (const c of comments) at(c.side, c.to).items.push(c)
    if (draft) at(draft.side, draft.to).draft = draft
    return by
  }, [comments, draft])
  const spotKeys = [...spots.keys()].filter((k) => !(oldHidden && k.startsWith('old:'))).sort().join('|')

  // A view zone for each spot, made again when the spots change; each one's height follows its content (ResizeObserver).
  useEffect(() => {
    const made: Zone[] = []
    for (const side of ['new', 'old'] as const) {
      const ed = sideEditor(side)
      ed.changeViewZones((acc) => {
        for (const key of spotKeys ? spotKeys.split('|') : []) {
          const s = spots.get(key)
          if (!s || s.side !== side) continue
          const node = document.createElement('div')
          node.className = 'cw-comment-zone'
          // The zone's own keys and clicks stay in it: the editor never takes them (its text box keeps the focus).
          for (const ev of ['mousedown', 'keydown', 'keyup', 'keypress', 'wheel'] as const) node.addEventListener(ev, (e) => e.stopPropagation())
          const zone: Monaco.editor.IViewZone = { afterLineNumber: s.line, heightInPx: 60, domNode: node, suppressMouseDown: true }
          made.push({ key, side, id: acc.addZone(zone), zone, node })
        }
      })
    }
    setZones(made)
    return () => {
      for (const side of ['new', 'old'] as const) sideEditor(side).changeViewZones((acc) => made.filter((z) => z.side === side).forEach((z) => acc.removeZone(z.id)))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, spotKeys])

  const fit = (z: Zone, height: number): void => {
    const h = Math.ceil(height) + 8
    if (z.zone.heightInPx === h) return
    z.zone.heightInPx = h
    sideEditor(z.side).changeViewZones((acc) => acc.layoutZone(z.id))
  }

  const content = (s: { side: LineSide; items: LineCommentView[]; draft: Draft | null }): ReactNode => (
    <>
      {s.items.map((c) => (
        <Thread key={c.id} card={card} c={c} agentName={agentName} />
      ))}
      {s.draft && <Composer key={`${s.draft.side}:${s.draft.from}-${s.draft.to}`} where={s.draft} onCancel={() => setDraft(null)} onSave={async (body) => {
        await call('tasks:lineCommentAdd', card, { submission, path, side: s.draft!.side, from: s.draft!.from, to: s.draft!.to, body })
        setDraft(null)
      }} />}
    </>
  )

  const elsewhere = oldHidden ? comments.filter((c) => c.side === 'old') : []
  return (
    <>
      {elsewhere.length > 0 && (
        <div className="cw-comments-elsewhere" data-comments-elsewhere="">
          <div className="faint">{tr(M.elsewhere)}</div>
          {elsewhere.map((c) => (
            <Thread key={c.id} card={card} c={c} agentName={agentName} />
          ))}
        </div>
      )}
      {zones.map((z) => {
        const s = spots.get(z.key)
        return s ? createPortal(<Fitted onSize={(h) => fit(z, h)}>{content(s)}</Fitted>, z.node, z.key) : null
      })}
    </>
  )
}

/** Its children, telling `onSize` their height each time it changes. */
function Fitted({ onSize, children }: { onSize: (h: number) => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const told = useRef(onSize)
  told.current = onSize
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => told.current(el.offsetHeight))
    ro.observe(el)
    told.current(el.offsetHeight)
    return () => ro.disconnect()
  }, [])
  return (
    <div ref={ref} className="cw-comment-spot">
      {children}
    </div>
  )
}

/** Where a comment is: its side and lines. */
const whereOf = (w: { side: LineSide; from: number; to: number }): string => tr(M.lines, { side: w.side, from: w.from, to: w.to, same: w.from === w.to ? 'yes' : 'no' })

/** A box to write a comment in (or edit one): Ctrl+Enter saves, Escape cancels; what went wrong said under it. */
function Composer({ where, initial = '', onSave, onCancel }: { where?: Draft; initial?: string; onSave: (body: string) => Promise<void>; onCancel: () => void }) {
  const [text, setText] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => ref.current?.focus(), [])
  const save = async (): Promise<void> => {
    if (!text.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await onSave(text)
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }
  return (
    <div className="cw-comment-composer" data-comment-composer="">
      {where && <div className="faint cw-comment-where">{whereOf(where)}</div>}
      <textarea
        ref={ref}
        value={text}
        maxLength={LINE_COMMENT_LIMITS.body}
        placeholder={tr(M.placeholder)}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            void save()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
      />
      <div className="cw-comment-actions">
        <span className="faint">{tr(M.count, { n: text.length, max: LINE_COMMENT_LIMITS.body })}</span>
        <span className="grow" />
        <button type="button" className="btn small subtle" onClick={onCancel}>
          {tr(M.cancel)}
        </button>
        <button type="button" className="btn small primary" disabled={!text.trim() || busy} onClick={() => void save()}>
          {tr(M.save)}
        </button>
      </div>
      {error && <div className="card-work-unread">{error}</div>}
    </div>
  )
}

/** One saved comment: who and when, where, its Markdown, and what can be done with it. */
export function Thread({ card, c, agentName }: { card: number; c: LineCommentView; agentName: (id: string | null) => string }) {
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const change = async (what: Change): Promise<void> => {
    setError(null)
    try {
      await call('tasks:lineCommentChange', card, c.id, what)
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  return (
    <div className={cx('cw-comment', c.state === 'resolved' && 'resolved')} data-line-comment={c.id} data-state={c.state}>
      <div className="cw-comment-head">
        <strong>{c.by === 'user' ? tr(M.you) : agentName(c.by)}</strong>
        <span className="faint" title={formatDateTime(c.at)}>
          {timeAgo(c.at)}
          {c.version > 1 ? ` · ${tr(M.edited)}` : ''}
        </span>
        <span className="faint">{whereOf(c)}</span>
        {c.state === 'resolved' && <span className="badge">{tr(M.resolved)}</span>}
        <span className="grow" />
        {!editing && (
          <>
            {c.state === 'open' && (
              <button type="button" className="btn small subtle" onClick={() => setEditing(true)}>
                {tr(M.edit)}
              </button>
            )}
            <button type="button" className="btn small subtle" onClick={() => void change(c.state === 'open' ? 'resolve' : 'reopen')}>
              {tr(c.state === 'open' ? M.resolve : M.reopen)}
            </button>
            {!c.sent && (
              <button type="button" className="btn small subtle" onClick={() => void change('delete')}>
                {tr(M.delete)}
              </button>
            )}
          </>
        )}
      </div>
      {editing ? (
        <Composer initial={c.body} onCancel={() => setEditing(false)} onSave={async (body) => {
          await call('tasks:lineCommentChange', card, c.id, { edit: { body, version: c.version } })
          setEditing(false)
        }} />
      ) : (
        <Markdown className="cw-comment-body" source={c.body} />
      )}
      {error && <div className="card-work-unread">{error}</div>}
    </div>
  )
}
