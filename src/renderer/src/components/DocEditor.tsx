import { useEffect, useRef, useState } from 'react'
import { msg, tr } from '@shared/i18n'
import { call, errorMessage } from '../api'
import { clearEditorDraft, editorDraft, onEditorDrafts, setEditorDraft } from '../editorDrafts'
import { languageFor } from '../monacoLang'
import { confirm, notify } from '../store'
import { basename } from '../util'
import { CodeEditor } from './Editors'
import { FILES_TEXT } from './FileView'
import { Icon, IconButton, Markdown } from './ui'

const M = {
  overwriteTitle: msg({ id: 'files.doc.overwriteTitle', defaultMessage: 'Overwrite the changes on disk?', description: "Title of the confirmation when saving a file (a note, a skill…) that changed on disk since it was opened." }),
  overwriteMessage: msg({ id: 'files.doc.overwriteMessage', defaultMessage: '{name} has changed on disk since you opened it (an agent may have edited it). Save your version over it?', description: 'The confirmation before saving over a file changed on disk. {name} is the file name.' }),
  overwriteDetail: msg({ id: 'files.doc.overwriteDetail', defaultMessage: 'Cancel keeps your edits here unsaved, so you can copy them and reopen the file.', description: 'Under the confirmation before saving over a file changed on disk.' }),
  overwrite: msg({ id: 'files.doc.overwrite', defaultMessage: 'Overwrite', description: 'Button: saves your version over the file changed on disk.' }),
  saveFailed: msg({ id: 'files.doc.saveFailed', defaultMessage: 'Could not save', description: 'Title of an error notification: a file could not be saved.' }),
  isNew: msg({ id: 'files.doc.new', defaultMessage: '(new)', description: "Beside a file's name in the editor's toolbar: the file doesn't exist yet and is created when saved." }),
  viewSource: msg({ id: 'files.doc.viewSource', defaultMessage: 'View source', description: 'Tooltip on a button that shows a read-only Markdown file as text.' }),
  edit: msg({ id: 'files.doc.edit', defaultMessage: 'Edit', description: 'Tooltip on a button that switches a Markdown file from its preview to the editor.' }),
  preview: msg({ id: 'files.doc.preview', defaultMessage: 'Preview', description: 'Tooltip on a button that shows a Markdown file rendered.' }),
  discardTitle: msg({ id: 'files.doc.discardTitle', defaultMessage: 'Discard changes?', description: 'Title of the confirmation before leaving a file with unsaved edits.' }),
  discardMessage: msg({ id: 'files.doc.discardMessage', defaultMessage: 'You have unsaved changes.', description: 'The confirmation before leaving a file with unsaved edits.' }),
  discard: msg({ id: 'files.doc.discard', defaultMessage: 'Discard', description: 'Button: drops the unsaved edits.' })
}

/**
 * Loads a file through the main process, edits it in Monaco and saves with Ctrl+S.
 * Markdown files open in preview mode by default. Unsaved edits are kept (editorDrafts) when the view or
 * file changes, and saving won't overwrite a file changed on disk since it was loaded without asking.
 */
export function DocEditor({
  path,
  title,
  readOnly,
  createIfMissing,
  toolbarExtra,
  defaultPreview,
  editingNote,
  notice,
  onLink,
  onSaved
}: {
  path: string
  title?: string
  readOnly?: boolean
  createIfMissing?: string
  toolbarExtra?: React.ReactNode
  defaultPreview?: boolean
  /** Shown above the editor while the file is being edited (not in preview, not read-only). */
  editingNote?: React.ReactNode
  /** Shown above the file, in preview and while editing, from its text as it is in the editor now (as you type). */
  notice?: (text: string) => React.ReactNode
  /** A link clicked in the preview: true when it was handled (a skill's own file, HI-2011), else the usual handling. */
  onLink?: (href: string) => boolean
  onSaved?: () => void
}) {
  const [text, setText] = useState('')
  const [saved, setSaved] = useState('')
  const [loading, setLoading] = useState(true)
  const [missing, setMissing] = useState(false)
  const [touched, setTouched] = useState(false)
  const isMd = /\.(md|markdown)$/i.test(path)
  const [preview, setPreview] = useState(defaultPreview ?? isMd)
  const dirty = text !== saved
  const [reload, setReload] = useState(0)
  // The editor's text right now (a save in progress compares it with what it wrote).
  const latest = useRef(text)
  latest.current = text

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void call('file:read', path)
      .then((t) => {
        if (cancelled) return
        // Edits left unsaved earlier come back, still based on the text they were made to.
        const draft = editorDraft(path)
        const isMissing = t === '' && !!createIfMissing
        setText(draft ? draft.text : isMissing ? createIfMissing! : t)
        setSaved(draft ? draft.base : t)
        setTouched(!!draft)
        setMissing(isMissing)
        if (isMissing || draft) setPreview(false)
      })
      .catch((e) => notify('error', tr(FILES_TEXT.openFailed), errorMessage(e)))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [path, createIfMissing, reload])

  // Saved or discarded from elsewhere (Save All before closing the workspace…): show the file as it now is.
  const state = useRef({ touched, dirty, saved })
  state.current = { touched, dirty, saved }
  useEffect(
    () =>
      onEditorDrafts(() => {
        const d = editorDraft(path)
        if (state.current.touched && state.current.dirty && !d) setReload((n) => n + 1)
        // Save All wrote other text than this editor now has: it is unsaved, against what is on disk.
        else if (d && d.base !== state.current.saved) {
          setSaved(d.base)
          setTouched(true)
        }
      }),
    [path]
  )

  const writeFile = async (content: string, base: string): Promise<string> => {
    await call('file:write', path, content, base)
    return content
  }
  // What the edits are based on: a draft's base moves on when Save All saves text it has since changed.
  const baseText = (): string => editorDraft(path)?.base ?? saved

  const save = async (): Promise<void> => {
    if (readOnly) return
    try {
      await writeFile(text, baseText()).catch(async (e) => {
        if (!errorMessage(e).includes('CONFLICT')) throw e
        const overwrite = await confirm({
          title: tr(M.overwriteTitle),
          message: tr(M.overwriteMessage, { name: basename(path) }),
          detail: tr(M.overwriteDetail),
          confirmLabel: tr(M.overwrite),
          danger: true
        })
        if (!overwrite) throw new Error('CANCELLED')
        await call('file:write', path, text)
      })
      // Typed into while it was saving (even back to what it was before): the newer text stays a draft, now of what was written.
      const newer = latest.current !== text
      if (newer) setEditorDraft({ key: path, label: title ?? basename(path), abs: path, text: latest.current, base: text, save: writeFile })
      else clearEditorDraft(path)
      setSaved(text)
      setTouched(newer)
      setMissing(false)
      onSaved?.()
    } catch (e) {
      if (errorMessage(e).includes('CANCELLED')) return
      notify('error', tr(M.saveFailed), errorMessage(e))
    }
  }

  return (
    <div className="split-main">
      <div className="editor-toolbar">
        <Icon name={isMd ? 'markdown' : 'file'} />
        <span className="path" title={path}>
          <strong>{title ?? basename(path)}</strong>
          {dirty && (missing ? ` ${tr(M.isNew)}` : ' ●')} <span className="faint">{path}</span>
        </span>
        {toolbarExtra}
        {isMd && <IconButton icon={preview ? (readOnly ? 'code' : 'edit') : 'open-preview'} title={tr(preview ? (readOnly ? M.viewSource : M.edit) : M.preview)} onClick={() => setPreview(!preview)} />}
        <IconButton icon="folder-opened" title={tr(FILES_TEXT.revealInExplorer)} onClick={() => void call('app:showInFolder', path)} disabled={missing} />
        {!readOnly && (
          <button className="btn small primary" disabled={!dirty} onClick={() => void save()}>
            <Icon name="save" /> {tr(FILES_TEXT.save)}
          </button>
        )}
      </div>
      {notice && !loading && notice(text)}
      {editingNote && !readOnly && !preview && !loading && editingNote}
      <div className="editor-host">
        {loading ? null : preview ? (
          <div className="scroll-page">
            {text.trim() ? <Markdown source={text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')} onLink={onLink} /> : <div className="empty-state">{tr(FILES_TEXT.empty)}</div>}
          </div>
        ) : (
          <CodeEditor
            value={text}
            language={languageFor(path)}
            onChange={(v) => {
              setText(v)
              setTouched(true)
              setEditorDraft({ key: path, label: title ?? basename(path), abs: path, text: v, base: baseText(), save: writeFile })
            }}
            onSave={() => void save()}
            readOnly={readOnly}
          />
        )}
      </div>
    </div>
  )
}

export async function confirmDiscard(dirty: boolean): Promise<boolean> {
  if (!dirty) return true
  return confirm({ title: tr(M.discardTitle), message: tr(M.discardMessage), confirmLabel: tr(M.discard), danger: true })
}
