// HI-3219: line comments over a card revision's diff (RevisionChanges, DiffView's onEditor). Hovering a line shows a "+" in
// either side's glyph margin; pressing it opens a Markdown box under the line (or the lines selected there, if the "+" is
// on one of them), as a Monaco view zone, and Ctrl+Enter saves it. Saved comments show as threads under their last line,
// with Edit, Resolve or Reopen, and Delete while unsent. They are the card's facts: main writes them
// (tasks:lineCommentAdd/Change) and the window reads them back with the card's work, so every change shows once written.
// A side the diff doesn't show (the original, inline) lists its comments, and its drafts, above the diff instead.
// HI-3274: what is typed (a draft, an edit) is held by the layer, not the box, so a box made again (another spot's +, the
// diff flipping to inline and back) keeps it; a "+" elsewhere opens another draft beside a draft with text in it.
import { createPortal } from 'react-dom'
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type * as Monaco from 'monaco-editor'
import { msg, tr } from '@shared/i18n'
import { formatDateTime } from '@shared/dates'
import { LINE_COMMENT_LIMITS, type LineCommentView, type LineSide } from '@shared/workflow/lineComments'
import { call, errorMessage } from '../api'
import { cx, timeAgo } from '../util'
import { loadMonaco } from './Editors'
import { Markdown, Modal } from './ui'

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
  sendButton: msg({ id: 'board.work.send.button', defaultMessage: '{n, plural, one {Send # comment to {builder}} other {Send # comments to {builder}}}', description: "A button in the card dialog's Work section (HI-3220): sends the card's open line comments to its builder ({builder}, an agent's name) as one fix round. Glossary: builder." }),
  sendTitle: msg({ id: 'board.work.send.title', defaultMessage: 'Send comments to {builder}', description: "The title of the dialog that previews sending a card's open line comments to its builder ({builder}, an agent's name)." }),
  sendIntro: msg({ id: 'board.work.send.intro', defaultMessage: 'They go to {builder} as one fix round: the card goes back to Doing, and the round counts toward its limit.', description: "At the top of the dialog sending a card's line comments to its builder ({builder}): what sending does. Glossary: round." }),
  editedSince: msg({ id: 'board.work.send.editedSince', defaultMessage: 'edited since sent', description: "A mark on a line comment in the send dialog: it was sent before, and its text changed since." }),
  sentBefore: msg({ id: 'board.work.send.sentBefore', defaultMessage: 'sent before', description: "A mark on a line comment in the send dialog: it was sent to the builder before and is still open, so it goes again." }),
  replace: msg({ id: 'board.work.send.replace', defaultMessage: 'Replace {reviewer}’s review, which is under way', description: "A checkbox in the send dialog, shown while a reviewer agent ({reviewer}, its name) is reviewing the card: sending replaces that review, so it must be ticked first." }),
  send: msg({ id: 'board.work.send.send', defaultMessage: '{n, plural, one {Send # comment} other {Send # comments}}', description: "The send dialog's button: sends this many line comments to the card's builder." }),
  reading: msg({ id: 'board.work.send.reading', defaultMessage: 'Reading its comments…', description: "The send dialog while the card's open line comments are read." }),
  count: msg({ id: 'board.work.comments.length', defaultMessage: '{n, number} / {max, number}', description: "Under a line comment being written: how many characters it has, of the most it may have." })
}

type Draft = { side: LineSide; from: number; to: number }
type Change = { edit: { body: string; version: number } } | 'resolve' | 'reopen' | 'delete'
type Zone = { key: string; side: LineSide; id: string; zone: Monaco.editor.IViewZone; node: HTMLDivElement }

const draftKey = (d: Draft): string => `${d.side}:${d.from}-${d.to}`

/** What the layer's boxes hold for it (HI-3274), by key: a draft's text, an edit's text, a thread's open edit. */
const Held = createContext<Map<string, unknown> | null>(null)

/**
 * State kept by the layer under `key` as well as in the component: one made again (a new portal, or listed above the diff
 * while inline) starts from it. Set back to `initial`, the layer forgets it.
 */
function useHeld<T>(key: string | undefined, initial: T): [T, (v: T) => void, boolean] {
  const held = useContext(Held)
  const kept = useRef(key !== undefined && !!held?.has(key)).current
  const [v, setV] = useState<T>(() => (kept ? (held!.get(key!) as T) : initial))
  const set = (next: T): void => {
    setV(next)
    if (key === undefined || !held) return
    if (next === initial) held.delete(key)
    else held.set(key, next)
  }
  return [v, set, kept]
}

/** The comment layer over `editor` (a revision's diff of `path`): its threads, its drafts, its "+" in each glyph margin. */
export function CommentLayer({ editor, card, submission, path, comments, agentName }: { editor: Monaco.editor.IStandaloneDiffEditor; card: number; submission: number; path: string; comments: LineCommentView[]; agentName: (id: string | null) => string }) {
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [zones, setZones] = useState<Zone[]>([])
  const [oldHidden, setOldHidden] = useState(false)
  const held = useRef(new Map<string, unknown>()).current
  const sideEditor = (side: LineSide): Monaco.editor.ICodeEditor => (side === 'new' ? editor.getModifiedEditor() : editor.getOriginalEditor())
  const dropDraft = (d: Draft): void => setDrafts((ds) => ds.filter((x) => draftKey(x) !== draftKey(d)))

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
          const d: Draft = { side, from: inSel ? sel.startLineNumber : line, to: inSel ? last : line }
          // HI-3274: drafts with text stay open (and keep it) beside the new one; empty ones give way to it. A "+" on an open
          // draft's own lines goes back to its box.
          const key = draftKey(d)
          setDrafts((ds) => {
            if (ds.some((x) => draftKey(x) === key)) return ds
            const typed = (x: Draft): boolean => !!String(held.get(`draft:${draftKey(x)}`) ?? '').trim()
            for (const x of ds) if (!typed(x)) held.delete(`draft:${draftKey(x)}`)
            return [...ds.filter(typed), d]
          })
          requestAnimationFrame(() => editor.getContainerDomNode().querySelector<HTMLTextAreaElement>(`[data-draft="${key}"] textarea`)?.focus())
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

  // What shows under each line: its side's threads ending there, and the drafts ending there.
  const spots = useMemo(() => {
    const by = new Map<string, { side: LineSide; line: number; items: LineCommentView[]; drafts: Draft[] }>()
    const at = (side: LineSide, line: number) => {
      const key = `${side}:${line}`
      if (!by.has(key)) by.set(key, { side, line, items: [], drafts: [] })
      return by.get(key)!
    }
    for (const c of comments) at(c.side, c.to).items.push(c)
    for (const d of drafts) at(d.side, d.to).drafts.push(d)
    for (const s of by.values()) s.drafts.sort((a, b) => a.from - b.from)
    return by
  }, [comments, drafts])
  const spotKeys = [...spots.keys()].filter((k) => !(oldHidden && k.startsWith('old:'))).sort().join('|')

  // A view zone for each spot, kept by its side and line while the spot is there (HI-3239): only spots that come or go are
  // added or removed, so another spot's container, and the thread or box React keeps in it, is never made again. A new
  // container would remount its portal and lose what is being typed there (an edit, a draft). Each zone's height follows
  // its content (ResizeObserver).
  const kept = useRef(new Map<string, Zone>())
  useEffect(() => {
    // The editor's zones go with it (a new editor, or the layer closing).
    const mine = kept.current
    return () => {
      for (const side of ['new', 'old'] as const) sideEditor(side).changeViewZones((acc) => [...mine.values()].filter((z) => z.side === side).forEach((z) => acc.removeZone(z.id)))
      mine.clear()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])
  useEffect(() => {
    const mine = kept.current
    const want = new Set(spotKeys ? spotKeys.split('|') : [])
    for (const side of ['new', 'old'] as const) {
      const ed = sideEditor(side)
      // Monaco hides its view zones from assistive technology (aria-hidden, set once as it makes them): they hold only its
      // own empty alignment spacers and these threads, whose words and buttons must be reachable.
      ed.getDomNode()?.querySelector('.view-zones')?.removeAttribute('aria-hidden')
      ed.changeViewZones((acc) => {
        for (const [key, z] of mine) {
          if (z.side !== side || want.has(key)) continue
          acc.removeZone(z.id)
          mine.delete(key)
        }
        for (const key of want) {
          const s = spots.get(key)
          if (mine.has(key) || !s || s.side !== side) continue
          const node = document.createElement('div')
          node.className = 'cw-comment-zone'
          // The zone's own keys and clicks stay in it: the editor never takes them (its text box keeps the focus).
          for (const ev of ['mousedown', 'keydown', 'keyup', 'keypress', 'wheel'] as const) node.addEventListener(ev, (e) => e.stopPropagation())
          const zone: Monaco.editor.IViewZone = { afterLineNumber: s.line, heightInPx: 60, domNode: node, suppressMouseDown: true }
          mine.set(key, { key, side, id: acc.addZone(zone), zone, node })
        }
      })
    }
    setZones([...mine.values()])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, spotKeys])

  const fit = (z: Zone, height: number): void => {
    const h = Math.ceil(height) + 8
    if (z.zone.heightInPx === h) return
    z.zone.heightInPx = h
    sideEditor(z.side).changeViewZones((acc) => acc.layoutZone(z.id))
  }

  const composer = (d: Draft): ReactNode => (
    <Composer key={draftKey(d)} hold={`draft:${draftKey(d)}`} where={d} onCancel={() => dropDraft(d)} onSave={async (body) => {
      await call('tasks:lineCommentAdd', card, { submission, path, side: d.side, from: d.from, to: d.to, body })
      dropDraft(d)
    }} />
  )
  const content = (s: { side: LineSide; items: LineCommentView[]; drafts: Draft[] }): ReactNode => (
    <>
      {s.items.map((c) => (
        <Thread key={c.id} card={card} c={c} agentName={agentName} />
      ))}
      {s.drafts.map(composer)}
    </>
  )

  // Inline, the original side's threads and drafts are listed here, each keeping what is typed in it (HI-3274).
  const elsewhere = oldHidden ? comments.filter((c) => c.side === 'old') : []
  const elsewhereDrafts = oldHidden ? drafts.filter((d) => d.side === 'old') : []
  return (
    <Held.Provider value={held}>
      {elsewhere.length + elsewhereDrafts.length > 0 && (
        <div className="cw-comments-elsewhere" data-comments-elsewhere="">
          <div className="faint">{tr(M.elsewhere)}</div>
          {elsewhere.map((c) => (
            <Thread key={c.id} card={card} c={c} agentName={agentName} />
          ))}
          {elsewhereDrafts.map(composer)}
        </div>
      )}
      {zones.map((z) => {
        const s = spots.get(z.key)
        return s ? createPortal(<Fitted onSize={(h) => fit(z, h)}>{content(s)}</Fitted>, z.node, z.key) : null
      })}
    </Held.Provider>
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
export const whereOf = (w: { side: LineSide; from: number; to: number }): string => tr(M.lines, { side: w.side, from: w.from, to: w.to, same: w.from === w.to ? 'yes' : 'no' })

/**
 * A box to write a comment in (or edit one): Ctrl+Enter saves, Escape cancels; what went wrong said under it. Its text is
 * held by the layer under `hold` (HI-3274), so the box made again keeps it; a new box takes the focus, one made again doesn't.
 */
function Composer({ where, hold, initial = '', onSave, onCancel }: { where?: Draft; hold?: string; initial?: string; onSave: (body: string) => Promise<void>; onCancel: () => void }) {
  const [text, setText, restored] = useHeld(hold, initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (!restored) ref.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const cancel = (): void => {
    setText(initial)
    onCancel()
  }
  const save = async (): Promise<void> => {
    if (!text.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await onSave(text)
      setText(initial)
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }
  return (
    <div className="cw-comment-composer" data-comment-composer="" data-draft={where ? draftKey(where) : undefined}>
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
            cancel()
          }
        }}
      />
      <div className="cw-comment-actions">
        <span className="faint">{tr(M.count, { n: text.length, max: LINE_COMMENT_LIMITS.body })}</span>
        <span className="grow" />
        <button type="button" className="btn small subtle" onClick={cancel}>
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
  // The version Edit was opened on (HR1's round 1): saved against it, so an edit made meanwhile is refused, never overwritten.
  // Held by the layer (HI-3274): the thread listed above the diff while inline, or back under its line, keeps it open.
  const [editing, setEditing] = useHeld<{ version: number; body: string } | null>(`edit:${c.id}`, null)
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
    <div className={cx('cw-comment', c.state === 'resolved' && 'resolved')} data-line-comment={c.id} data-state={c.state} data-version={c.version}>
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
              <button type="button" className="btn small subtle" onClick={() => setEditing({ version: c.version, body: c.body })}>
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
        <Composer hold={`edit-text:${c.id}`} initial={editing.body} onCancel={() => setEditing(null)} onSave={async (body) => {
          await call('tasks:lineCommentChange', card, c.id, { edit: { body, version: editing.version } })
          setEditing(null)
        }} />
      ) : (
        <Markdown className="cw-comment-body" source={c.body} />
      )}
      {error && <div className="card-work-unread">{error}</div>}
    </div>
  )
}

type Preview = Awaited<ReturnType<typeof call<'tasks:feedbackPreview'>>>

/**
 * HI-3220: "Send N comments to <builder>" and its preview: every open comment (sent before or not, edited since or not), and,
 * while an agent reviews the card, the confirm that the send replaces its review. The send carries the preview's batch id,
 * each comment's version and what the preview saw of the card, so main refuses it if any of them changed meanwhile.
 */
export function SendFeedback({ card, open, builder, agentName }: { card: number; open: number; builder: string; agentName: (id: string | null) => string }) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [shown, setShown] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [replace, setReplace] = useState(false)
  const close = (): void => {
    setShown(false)
    setPreview(null)
    setError(null)
    setReplace(false)
  }
  const show = (): void => {
    setShown(true)
    call('tasks:feedbackPreview', card).then(setPreview, (e) => setError(errorMessage(e)))
  }
  const send = async (): Promise<void> => {
    if (!preview?.expect) return
    setBusy(true)
    setError(null)
    try {
      await call('tasks:feedbackSend', card, { batch: preview.batch, items: preview.items.map((c) => ({ id: c.id, version: c.version })), expect: preview.expect, replaces: replace ? preview.review : null })
      close()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const name = agentName(builder)
  return (
    <>
      <button type="button" className="btn small primary" data-send-feedback={open} onClick={show}>
        {tr(M.sendButton, { n: open, builder: name })}
      </button>
      {shown && (
        <Modal
          title={tr(M.sendTitle, { builder: name })}
          icon="comment"
          wide
          onClose={close}
          busy={busy}
          error={error}
          footer={
            <>
              <button type="button" className="btn subtle" onClick={close}>
                {tr(M.cancel)}
              </button>
              <button type="button" className="btn primary" data-send-confirm="" disabled={!preview?.items.length || !preview.expect || (!!preview.review && !replace) || busy} onClick={() => void send()}>
                {tr(M.send, { n: preview?.items.length ?? 0 })}
              </button>
            </>
          }
        >
          {!preview ? (
            <div className="faint">{tr(M.reading)}</div>
          ) : (
            <div className="cw-send-preview" data-send-preview={preview.batch}>
              <p>{tr(M.sendIntro, { builder: name })}</p>
              {preview.items.map((c) => (
                <div key={c.id} className="cw-comment" data-send-item={c.id}>
                  <div className="cw-comment-head">
                    <strong>{c.path}</strong>
                    <span className="faint">{whereOf(c)}</span>
                    {c.edited ? <span className="badge">{tr(M.editedSince)}</span> : c.sent && <span className="badge">{tr(M.sentBefore)}</span>}
                  </div>
                  <Markdown className="cw-comment-body" source={c.body} />
                </div>
              ))}
              {preview.review && (
                <label className="cw-send-replace">
                  <input type="checkbox" checked={replace} data-send-replace="" onChange={(e) => setReplace(e.target.checked)} /> {tr(M.replace, { reviewer: agentName(preview.review.reviewer) })}
                </label>
              )}
            </div>
          )}
        </Modal>
      )}
    </>
  )
}
