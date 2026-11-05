import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { FileContent, ProjectInfo } from '@shared/types'
import { msg, tr, type Msg } from '@shared/i18n'
import * as actions from '../actions'
import { call, errorMessage } from '../api'
import { languageFor } from '../monacoLang'
import { clearEditorDrafts, editorDraftList, onEditorDrafts, saveEditorDrafts } from '../editorDrafts'
import { confirm, notify } from '../store'
import { cx, formatBytes, imageUrl, timeAgo } from '../util'
import { CodeEditor, type EditorGoto } from './Editors'
import { PaneResizer, usePaneSize } from './Resizer'
import { Icon, Markdown, Tooltip } from './ui'

/** The Files area's words used by more than one editor (#803): the Files tab, its file view and DocEditor. */
export const FILES_TEXT = {
  save: msg({ id: 'files.save', defaultMessage: 'Save', description: "Button in a file editor's toolbar: saves the file." }),
  unsaved: msg({ id: 'files.unsavedChanges', defaultMessage: 'Unsaved changes', description: 'Tooltip on the dot beside a file that has unsaved edits.' }),
  empty: msg({ id: 'files.fileEmpty', defaultMessage: 'This file is empty.', description: "Shown in a file's preview when the file has no content." }),
  openFailed: msg({ id: 'files.openFailed', defaultMessage: 'Could not open file', description: 'Title of an error notification: a file could not be opened (read, or opened in its default app).' }),
  open: msg({ id: 'files.open', defaultMessage: 'Open', description: 'Button: opens a file in its default Windows app.' }),
  revealInExplorer: msg({ id: 'files.revealInExplorer', defaultMessage: 'Reveal in File Explorer', description: 'Button or menu item: shows the file or folder in Windows File Explorer.' }),
  reveal: msg({ id: 'files.reveal', defaultMessage: 'Reveal', description: 'Short button: shows the file in Windows File Explorer.' })
}

const M = {
  preview: msg({ id: 'files.view.preview', defaultMessage: 'Preview', description: "A file view's mode button: the rendered Markdown or HTML." }),
  table: msg({ id: 'files.view.table', defaultMessage: 'Table', description: "A file view's mode button: a CSV or TSV file shown as a table." }),
  image: msg({ id: 'files.view.image', defaultMessage: 'Image', description: "A file view's mode button: an image file (or SVG) shown as a picture." }),
  pdf: msg({ id: 'files.view.pdf', defaultMessage: 'PDF', description: "A file view's mode button: a PDF shown in the PDF viewer." }),
  split: msg({ id: 'files.view.split', defaultMessage: 'Split', description: "A file view's mode button: the editor and the preview side by side." }),
  edit: msg({ id: 'files.view.edit', defaultMessage: 'Edit', description: "A file view's mode button: the text editor." }),
  changedOnDiskShort: msg({ id: 'files.saveAll.changedOnDisk', defaultMessage: '{file}: changed on disk since you opened it', description: 'Why Save All did not save a file: it changed on disk meanwhile. {file} is its path in the project.' }),
  goneFromDisk: msg({ id: 'files.view.gone', defaultMessage: 'This file no longer exists on disk. Save to recreate it.', description: 'Banner over an open file that was deleted on disk.' }),
  changedTitle: msg({ id: 'files.view.changedTitle', defaultMessage: '{name} changed on disk', description: 'Title of a warning when saving a file that changed on disk since it was opened. {name} is the file name.' }),
  changedBody: msg({ id: 'files.view.changedBody', defaultMessage: 'Reload it, or overwrite it with your version.', description: 'Under "{name} changed on disk".' }),
  saveFailed: msg({ id: 'files.view.saveFailed', defaultMessage: 'Could not save {name}', description: 'Title of an error notification. {name} is the file name.' }),
  discardTitle: msg({ id: 'files.view.discardTitle', defaultMessage: 'Discard your changes?', description: 'Title of the confirmation before reloading a file with unsaved edits from disk.' }),
  discardMessage: msg({ id: 'files.view.discardMessage', defaultMessage: 'Reload {name} from disk and discard your unsaved changes?', description: 'Confirmation before reloading a file. {name} is the file name.' }),
  reload: msg({ id: 'files.view.reload', defaultMessage: 'Reload', description: 'Button: reads the file from disk again, dropping unsaved edits.' }),
  saveTip: msg({ id: 'files.view.saveTip', defaultMessage: 'Save (Ctrl+S)', description: 'Tooltip on the Save button. Keep Ctrl+S as it is.' }),
  binary: msg({ id: 'files.view.binary', defaultMessage: 'This is a binary file.', description: 'Shown in place of a file Hive cannot show as text.' }),
  tooLarge: msg({ id: 'files.view.tooLarge', defaultMessage: 'This file is too large to open here ({size}).', description: 'Shown in place of a file too large for the editor. {size} is its size, such as "12.4 MB".' }),
  notUtf8: msg({ id: 'files.view.notUtf8', defaultMessage: "This file isn't UTF-8 text, so Combwork can't edit it without changing its characters.", description: 'Shown in place of a text file in another encoding (such as Windows-1252), which the editor would corrupt on save. UTF-8 is the encoding\'s name: keep it as it is.' }),
  openInApp: msg({ id: 'files.view.openInApp', defaultMessage: 'Open it in its default app instead.', description: 'Under "This is a binary file." or "This file is too large to open here", above an Open button.' }),
  changedBanner: msg({ id: 'files.view.changedBanner', defaultMessage: '{name} has changed on disk since you opened it.', description: 'Banner over an open file with unsaved edits that changed on disk. Followed by Reload and Overwrite with Mine. {name} is the file name.' }),
  overwrite: msg({ id: 'files.view.overwrite', defaultMessage: 'Overwrite with mine', description: 'Button in the "changed on disk" banner: saves your version over the file on disk.' }),
  csvFirstRows: msg({ id: 'files.csv.firstRows', defaultMessage: 'Showing the first {count, plural, one {# row} other {# rows}}. Switch to Edit to see everything.', description: "Under a CSV file's table when the file has more rows than it shows. Edit is the mode button of that name." }),
  htmlPreview: msg({ id: 'files.view.htmlPreview', defaultMessage: 'HTML preview', description: "Accessible title of the frame that shows an HTML file's preview." }),
  pdfPreview: msg({ id: 'files.view.pdfPreview', defaultMessage: 'PDF preview', description: 'Accessible title of the frame that shows a PDF file.' }),
  fit: msg({ id: 'files.image.fit', defaultMessage: 'Click to fit', description: 'Tooltip on an image shown at its actual size.' }),
  actualSize: msg({ id: 'files.image.actualSize', defaultMessage: 'Click for actual size', description: 'Tooltip on an image fitted to the pane.' })
}

// ---------------------------------------------------------------------------
// Previewer registry: which views a file gets besides the text editor.
// Adding a format means adding an entry here.
// ---------------------------------------------------------------------------

interface PreviewProps {
  text: string
  /** Project folder, for resolving relative links and images. */
  root: string
  abs: string
  rel: string
  onOpenRel: (rel: string) => void
}

interface Previewer {
  id: string
  label: Msg
  icon: string
  match: RegExp
  /** Views that need the file's text; others (images, PDF) load it from disk themselves. */
  needsText: boolean
  /** Whether the text can also be edited (adds Edit and, for markdown, Split). */
  editable: boolean
  /** Open in this view by default instead of the editor. */
  preferred: boolean
  split?: boolean
  render: (p: PreviewProps) => React.ReactNode
}

const PREVIEWERS: Previewer[] = [
  { id: 'markdown', label: M.preview, icon: 'open-preview', match: /\.(md|markdown|mdx)$/i, needsText: true, editable: true, preferred: true, split: true, render: (p) => <MarkdownPreview {...p} /> },
  { id: 'csv', label: M.table, icon: 'table', match: /\.(csv|tsv)$/i, needsText: true, editable: true, preferred: true, render: (p) => <CsvPreview {...p} /> },
  { id: 'html', label: M.preview, icon: 'open-preview', match: /\.html?$/i, needsText: true, editable: true, preferred: false, split: true, render: (p) => <HtmlPreview {...p} /> },
  { id: 'svg', label: M.image, icon: 'file-media', match: /\.svg$/i, needsText: true, editable: true, preferred: true, render: (p) => <SvgPreview {...p} /> },
  { id: 'image', label: M.image, icon: 'file-media', match: /\.(png|jpe?g|gif|webp|bmp|ico)$/i, needsText: false, editable: false, preferred: true, render: (p) => <ImagePreview {...p} /> },
  { id: 'pdf', label: M.pdf, icon: 'file-pdf', match: /\.pdf$/i, needsText: false, editable: false, preferred: true, render: (p) => <PdfPreview {...p} /> }
]

const previewerFor = (name: string): Previewer | undefined => PREVIEWERS.find((p) => p.match.test(name))

/** Whether a previewer shows the file from disk, without its text (images, PDF). */
export const previewsFromDisk = (name: string): boolean => previewerFor(name)?.needsText === false

/**
 * A file shown read-only with the previewers above (the Attachments tab's viewer, #387): the view the Files tab opens
 * it in by default (Markdown, a CSV's table, an image, a PDF), or else its text. `text` is null for a file whose text
 * isn't needed (previewsFromDisk) or can't be shown; `root` is the folder its relative links start from.
 */
export function ReadOnlyPreview({ root, abs, name, text }: { root: string; abs: string; name: string; text: string | null }) {
  const pv = previewerFor(name)
  const rel = abs.slice(root.length + 1).replace(/\\/g, '/')
  if (pv && (pv.preferred || !pv.needsText) && (!pv.needsText || text !== null)) return <>{pv.render({ text: text ?? '', root, abs, rel, onOpenRel: () => undefined })}</>
  return <pre className="attachment-text">{text}</pre>
}

type Mode = 'edit' | 'preview' | 'split'

// Unsaved edits survive switching files, tabs and projects while Hive is open.
interface Draft {
  text: string
  base: FileContent
  /** The folder the file was opened from (project or worktree) and its path in it, for saving and renames. */
  root: string
  rel: string
}
const drafts = new Map<string, Draft>()
const draftListeners = new Set<() => void>()
/** Open editors reload after saveAllDrafts, so they don't keep showing the saved text as unsaved. */
const savedListeners = new Set<() => void>()
const absOf = (root: string, rel: string): string => `${root}\\${rel.replace(/\//g, '\\')}`
export const hasDraft = (abs: string): boolean => drafts.has(abs.toLowerCase())

// The main process is told which files have unsaved edits (here and in the other editors), so quitting can ask about them.
const sendUnsaved = (): void => void call('files:setUnsaved', unsavedFiles().map((f) => f.abs))
draftListeners.add(sendUnsaved)
onEditorDrafts(sendUnsaved)

/** Files with unsaved edits: the Files tab's, then the other editors' (notes, skills, MCP servers…), named by `rel`. */
export function unsavedFiles(): { root: string; rel: string; abs: string }[] {
  return [
    ...[...drafts.values()].map((d) => ({ root: d.root, rel: d.rel, abs: absOf(d.root, d.rel) })),
    ...editorDraftList().map((d) => ({ root: '', rel: d.label, abs: d.abs }))
  ]
}

/** Unsaved files at rel or inside it (a folder), in root. */
export function draftsUnder(root: string, rels: string[]): string[] {
  const r = root.toLowerCase()
  return [...drafts.values()]
    .filter((d) => d.root.toLowerCase() === r && rels.some((x) => d.rel.toLowerCase() === x.toLowerCase() || d.rel.toLowerCase().startsWith(x.toLowerCase() + '/')))
    .map((d) => d.rel)
}

/** After a rename or move in the Files tab: the unsaved edits of from (a file, or files in a folder) follow it to to. */
export function moveDrafts(root: string, from: string, to: string): void {
  if (from === to) return
  const f = from.toLowerCase()
  for (const [key, d] of [...drafts]) {
    if (d.root.toLowerCase() !== root.toLowerCase()) continue
    const rel = d.rel.toLowerCase()
    if (rel !== f && !rel.startsWith(f + '/')) continue
    drafts.delete(key)
    const moved = { ...d, rel: to + d.rel.slice(from.length) }
    drafts.set(absOf(root, moved.rel).toLowerCase(), moved)
  }
  draftListeners.forEach((l) => l())
}

/** Drops unsaved edits: all of them, or those of the given files in root (e.g. after deleting them). */
export function discardDrafts(root?: string, rels?: string[]): void {
  if (!root) clearEditorDrafts()
  const under = root && rels ? new Set(draftsUnder(root, rels).map((r) => absOf(root, r).toLowerCase())) : null
  let changed = false
  for (const key of [...drafts.keys()]) {
    if (under && !under.has(key)) continue
    drafts.delete(key)
    changed = true
  }
  if (changed) draftListeners.forEach((l) => l())
}

/**
 * Saves every unsaved file. A file changed on disk since it was opened is not overwritten: it is
 * returned with the other failures, and its edits are kept.
 */
export async function saveAllDrafts(): Promise<{ saved: number; failed: { abs: string; message: string }[] }> {
  const failed: { abs: string; message: string }[] = []
  let saved = 0
  for (const [key, d] of [...drafts]) {
    savingFiles.add(key)
    try {
      const w = await call('files:write', d.root, d.rel, d.text, d.base.modified || null, d.base.bom)
      // Edited while it was saving (even back to what it was): the newer text stays a draft, now of what was written.
      const now = drafts.get(key)
      if (now === d || now?.text === d.text) drafts.delete(key)
      else if (now) now.base = { ...now.base, text: d.text, modified: w.modified }
      saved++
    } catch (e) {
      failed.push({ abs: absOf(d.root, d.rel), message: errorMessage(e).includes('CONFLICT') ? tr(M.changedOnDiskShort, { file: d.rel }) : `${d.rel}: ${errorMessage(e)}` })
      // Not saved: a draft edited back to what was loaded is no draft after all.
      const now = drafts.get(key)
      if (now && now.text === now.base.text) drafts.delete(key)
    } finally {
      savingFiles.delete(key)
    }
  }
  draftListeners.forEach((l) => l())
  savedListeners.forEach((l) => l())
  const others = await saveEditorDrafts()
  return { saved: saved + others.saved, failed: [...failed, ...others.failed] }
}
export function useDraftVersion(): number {
  const [v, setV] = useState(0)
  useEffect(() => {
    const l = (): void => setV((x) => x + 1)
    draftListeners.add(l)
    return () => void draftListeners.delete(l)
  }, [])
  return v
}
/** Files being saved by Save All: their drafts stay even when edited back to what was loaded, as the file is about to change. */
const savingFiles = new Set<string>()

function setDraft(abs: string, d: Draft | null): void {
  const key = abs.toLowerCase()
  const had = drafts.has(key)
  if (d) drafts.set(key, d)
  else drafts.delete(key)
  if (had !== !!d) draftListeners.forEach((l) => l())
}
const modeMemory = new Map<string, Mode>()

const joinRel = (dir: string, rel: string): string => {
  const parts = dir ? dir.split('/') : []
  for (const seg of rel.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg && seg !== '.') parts.push(seg)
  }
  return parts.join('/')
}

/** Room the file's name keeps before the toolbar drops its labels, and the room to spare before it takes them back. */
const PATH_ROOM = 80
const COMPACT_SPARE = 12

/**
 * A file toolbar that drops its labels when they don't fit (#814): its mode buttons and Save become icons (their names in
 * tooltips and for screen readers) and the size and time go, so Save stays on screen in a narrow pane and in languages
 * longer than English. What the labelled toolbar needs is measured while it shows (all but the path, which gives way
 * down to PATH_ROOM), so it follows the language; it takes the labels back once that fits with room to spare.
 */
function useCompactToolbar(): { ref: (el: HTMLDivElement | null) => void; compact: boolean } {
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  const [compact, setCompact] = useState(false)
  // Bumped when what the toolbar shows changes (a label, the language, a button): it may need more or less room.
  const [shown, setShown] = useState(0)
  const need = useRef(0)
  useLayoutEffect(() => {
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    const mo = new MutationObserver(() => setShown((n) => n + 1))
    mo.observe(el, { childList: true, subtree: true, characterData: true })
    setWidth(el.clientWidth)
    return () => {
      ro.disconnect()
      mo.disconnect()
    }
  }, [el])
  useLayoutEffect(() => {
    if (!el || width === 0) return
    if (!compact) {
      const path = el.querySelector<HTMLElement>('.path')
      need.current = el.scrollWidth - (path?.offsetWidth ?? 0) + PATH_ROOM
      if (need.current > width) setCompact(true)
    } else if (need.current + COMPACT_SPARE <= width) setCompact(false)
  }, [el, width, compact, shown])
  return { ref: setEl, compact }
}

/**
 * The Files tab's right pane for a file: a Monaco editor for any text file, plus preview views from
 * the registry. Ctrl+S saves; saving is refused if the file changed on disk since it was opened.
 */
export function FileView({
  project,
  rel,
  changeTick,
  onOpenRel,
  toolbarExtra,
  goto
}: {
  project: ProjectInfo
  rel: string
  /** Bumped by the Files tab when the file's folder changed on disk. */
  changeTick: number
  onOpenRel: (rel: string) => void
  toolbarExtra?: React.ReactNode
  /** A line to go to (a terminal's file link); a new nonce goes there again. */
  goto?: EditorGoto
}) {
  const abs = `${project.path}\\${rel.replace(/\//g, '\\')}`
  const name = rel.split('/').pop()!
  const pv = previewerFor(name)
  const splitRatio = usePaneSize('fileSplit', 0.5)
  const [content, setContent] = useState<FileContent | null>(null)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [changedOnDisk, setChangedOnDisk] = useState(false)
  const [mode, setModeState] = useState<Mode>(() => modeMemory.get(abs) ?? (pv?.preferred ? 'preview' : 'edit'))
  const setMode = (m: Mode): void => {
    modeMemory.set(abs, m)
    setModeState(m)
  }
  const dirty = !!content && content.kind === 'text' && text !== content.text
  const textRef = useRef(text)
  textRef.current = text
  const contentRef = useRef(content)
  contentRef.current = content

  const load = useCallback(
    async (keepDraft: boolean): Promise<void> => {
      if (pv && !pv.needsText) {
        setContent({ kind: 'binary', text: '', size: 0, modified: '', bom: false })
        return
      }
      try {
        const c = await call('files:read', project.path, rel)
        const d = keepDraft ? drafts.get(abs.toLowerCase()) : undefined
        setContent(d ? d.base : c)
        setText(d ? d.text : c.text)
        setChangedOnDisk(!!d && d.base.modified !== c.modified)
        setError(null)
      } catch (e) {
        setError(errorMessage(e))
      }
    },
    [project.path, rel, abs, pv]
  )

  useEffect(() => {
    setContent(null)
    setChangedOnDisk(false)
    setModeState(modeMemory.get(abs) ?? (pv?.preferred ? 'preview' : 'edit'))
    void load(true)
  }, [abs, load, pv])

  // Going to a line needs the text: a preview shows it alongside, or gives way to the editor.
  useEffect(() => {
    const shown = modeMemory.get(abs) ?? (pv?.preferred ? 'preview' : 'edit')
    if (goto && pv?.editable && shown === 'preview') setModeState(pv.split ? 'split' : 'edit')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goto?.nonce])

  // Keep the draft in step with the editor so it survives unmounting.
  useEffect(() => {
    if (!content || content.kind !== 'text') return
    setDraft(abs, text !== content.text || savingFiles.has(abs.toLowerCase()) ? { text, base: content, root: project.path, rel } : null)
  }, [text, content, abs, project.path, rel])

  // Saved or discarded from elsewhere (the quit dialog, Save All): pick up what's on disk now.
  useEffect(() => {
    const onSaved = (): void => {
      const d = drafts.get(abs.toLowerCase())
      const c = contentRef.current
      if (!d && c?.kind === 'text' && textRef.current !== c.text) void load(false)
      // Typed into while Save All saved it: the draft is now of what was written, and so is this editor.
      else if (d && c?.kind === 'text' && d.base.modified !== c.modified) setContent(d.base)
    }
    savedListeners.add(onSaved)
    return () => void savedListeners.delete(onSaved)
  }, [abs, load])

  // Changes on disk: reload silently when there are no edits, otherwise offer a choice.
  const firstTick = useRef(changeTick)
  useEffect(() => {
    if (changeTick === firstTick.current) return
    const c = contentRef.current
    if (!c || c.kind !== 'text') {
      if (pv && !pv.needsText) setContent({ kind: 'binary', text: '', size: 0, modified: new Date().toISOString(), bom: false })
      return
    }
    void call('files:read', project.path, rel)
      .then((disk) => {
        if (disk.modified === c.modified) return
        if (textRef.current === c.text) {
          setContent(disk)
          setText(disk.text)
        } else setChangedOnDisk(true)
      })
      .catch(() => setError(tr(M.goneFromDisk)))
  }, [changeTick, project.path, rel, pv])

  const save = async (force = false): Promise<void> => {
    const c = contentRef.current
    if (!c || c.kind !== 'text') return
    const t = textRef.current
    try {
      const r = await call('files:write', project.path, rel, t, force ? null : c.modified, c.bom)
      setContent({ ...c, text: t, modified: r.modified, size: r.size })
      setChangedOnDisk(false)
      setError(null)
    } catch (e) {
      if (errorMessage(e).includes('CONFLICT')) {
        setChangedOnDisk(true)
        notify('warning', tr(M.changedTitle, { name }), tr(M.changedBody))
      } else notify('error', tr(M.saveFailed, { name }), errorMessage(e))
    }
  }

  const reloadFromDisk = async (): Promise<void> => {
    if (dirty && !(await confirm({ title: tr(M.discardTitle), message: tr(M.discardMessage, { name }), confirmLabel: tr(M.reload), danger: true }))) return
    setDraft(abs, null)
    await load(false)
    setChangedOnDisk(false)
  }

  const canEdit = !pv || pv.editable
  const modes: { id: Mode; label: Msg; icon: string }[] = [
    ...(pv ? [{ id: 'preview' as Mode, label: pv.label, icon: pv.icon }] : []),
    ...(pv?.split ? [{ id: 'split' as Mode, label: M.split, icon: 'split-horizontal' }] : []),
    ...(pv && canEdit ? [{ id: 'edit' as Mode, label: M.edit, icon: 'edit' }] : [])
  ]
  const effectiveMode: Mode = !pv ? 'edit' : !canEdit ? 'preview' : mode
  const { ref: toolbarRef, compact } = useCompactToolbar()

  const header = (
    <div className={cx('editor-toolbar', compact && 'compact')} ref={toolbarRef}>
      <Icon name={pv?.icon ?? 'file'} />
      <span className="path" title={abs}>
        <strong>{name}</strong>
        {dirty && <span className="dirty-dot" title={tr(FILES_TEXT.unsaved)}> ●</span>} {rel.includes('/') && <span className="faint">{rel.slice(0, rel.lastIndexOf('/'))}</span>}
      </span>
      {content && content.modified && content.kind === 'text' && !compact && (
        <span className="faint small">
          {formatBytes(content.size)} · {timeAgo(content.modified)}
        </span>
      )}
      {modes.length > 1 && (
        <div className="segmented">
          {modes.map((m) =>
            compact ? (
              <Tooltip key={m.id} content={tr(m.label)}>
                <button className={cx(effectiveMode === m.id && 'active')} aria-label={tr(m.label)} onClick={() => setMode(m.id)}>
                  <Icon name={m.icon} />
                </button>
              </Tooltip>
            ) : (
              <button key={m.id} className={cx(effectiveMode === m.id && 'active')} onClick={() => setMode(m.id)}>
                <Icon name={m.icon} /> {tr(m.label)}
              </button>
            )
          )}
        </div>
      )}
      {toolbarExtra}
      {content?.kind === 'text' && canEdit && (
        <Tooltip content={tr(M.saveTip)}>
          <button className="btn small primary" disabled={!dirty} aria-label={compact ? tr(FILES_TEXT.save) : undefined} onClick={() => void save()}>
            <Icon name="save" />
            {!compact && ` ${tr(FILES_TEXT.save)}`}
          </button>
        </Tooltip>
      )}
    </div>
  )

  if (error && !content) {
    return (
      <>
        {header}
        <div className="empty-state">
          <Icon name="error" />
          {error}
        </div>
      </>
    )
  }
  if (!content) return <>{header}</>

  if (content.kind === 'too-large' || content.kind === 'not-utf8' || (content.kind === 'binary' && (!pv || pv.needsText))) {
    return (
      <>
        {header}
        <div className="empty-state">
          <Icon name={content.kind === 'binary' ? 'file-binary' : 'file'} />
          {content.kind === 'binary' ? tr(M.binary) : content.kind === 'not-utf8' ? tr(M.notUtf8) : tr(M.tooLarge, { size: formatBytes(content.size) })}
          <p className="hint">{tr(M.openInApp)}</p>
          <button className="btn subtle" onClick={() => void actions.attempt(tr(FILES_TEXT.openFailed), () => call('files:open', project.path, rel))}>
            <Icon name="link-external" /> {tr(FILES_TEXT.open)}
          </button>
        </div>
      </>
    )
  }

  const previewProps: PreviewProps = { text, root: project.path, abs, rel, onOpenRel }
  const editor = (
    <CodeEditor
      key={abs}
      value={text}
      language={languageFor(name)}
      onChange={setText}
      onSave={() => void save()}
      wordWrap={/\.(md|markdown|mdx|txt)$/i.test(name)}
      goto={goto}
    />
  )
  return (
    <>
      {header}
      {changedOnDisk && (
        <div className="banner warn">
          <Icon name="warning" /> {tr(M.changedBanner, { name })}
          <button className="btn small" onClick={() => void reloadFromDisk()}>
            {tr(M.reload)}
          </button>
          <button className="btn small" onClick={() => void save(true)}>
            {tr(M.overwrite)}
          </button>
        </div>
      )}
      {error && content && <div className="banner warn"><Icon name="warning" /> {error}</div>}
      <div className={cx('editor-host', effectiveMode === 'split' && 'split-view')}>
        {effectiveMode === 'edit' && editor}
        {effectiveMode === 'preview' && pv && <div className="preview-pane">{pv.render(previewProps)}</div>}
        {effectiveMode === 'split' && pv && (
          <>
            <div className="split-half" style={{ flex: `0 0 ${splitRatio * 100}%` }}>
              {editor}
              <PaneResizer paneKey="fileSplit" ratio />
            </div>
            <div className="split-half preview-pane">{pv.render(previewProps)}</div>
          </>
        )}
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Previews
// ---------------------------------------------------------------------------

const MD_LANG: Record<string, string> = { ts: 'x.ts', typescript: 'x.ts', js: 'x.js', javascript: 'x.js', py: 'x.py', python: 'x.py', sh: 'x.sh', bash: 'x.sh', shell: 'x.sh', ps1: 'x.ps1', powershell: 'x.ps1', yml: 'x.yml' }

/** decodeURIComponent, but a path such as "50%.png" (not valid percent-encoding) is kept as written instead of throwing. */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

function MarkdownPreview({ text, root, rel, onOpenRel }: PreviewProps) {
  const ref = useRef<HTMLDivElement>(null)
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
  const source = useMemo(() => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ''), [text])

  // Relative images load from the project; code blocks are coloured by Monaco.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    for (const img of el.querySelectorAll('img')) {
      const src = img.getAttribute('src') ?? ''
      if (!src || /^(https?:|data:|combwork-img:)/i.test(src)) continue
      const target = joinRel(dir, safeDecode(src.split(/[?#]/)[0]))
      img.setAttribute('src', imageUrl(`${root}\\${target.replace(/\//g, '\\')}`))
    }
    const blocks = [...el.querySelectorAll('pre > code')] as HTMLElement[]
    if (!blocks.length) return
    void import('../monaco').then(({ monaco }) => {
      // Token colours are only registered once a theme is set, which may not have happened yet.
      monaco.editor.setTheme(document.documentElement.dataset.theme === 'light' ? 'hive-light' : 'hive-dark')
      for (const code of blocks) {
        const lang = /language-([\w+#-]+)/.exec(code.className)?.[1]
        if (!lang || code.dataset.colorized) continue
        const id = languageFor(MD_LANG[lang.toLowerCase()] ?? `x.${lang}`)
        const langId = id === 'plaintext' ? lang.toLowerCase() : id
        void monaco.editor.colorize(code.textContent ?? '', langId, { tabSize: 2 }).then((html) => {
          code.innerHTML = html
          code.dataset.colorized = '1'
        })
      }
    })
  })
  return (
    <div className="scroll-page md-preview" ref={ref}>
      {source.trim() ? (
        <Markdown
          source={source}
          onLink={(href) => {
            if (/^(https?:|mailto:|#)/i.test(href)) return false
            onOpenRel(joinRel(dir, safeDecode(href.split('#')[0])))
            return true
          }}
        />
      ) : (
        <div className="empty-state">{tr(FILES_TEXT.empty)}</div>
      )}
    </div>
  )
}

/** Minimal RFC 4180 parser: quoted fields, escaped quotes, newlines inside quotes. */
function parseDelimited(text: string, sep: string, maxRows: number): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (ch === '"') quoted = false
      else field += ch
      continue
    }
    if (ch === '"' && field === '') quoted = true
    else if (ch === sep) {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      field = ''
      rows.push(row)
      row = []
      if (rows.length >= maxRows) return rows
    } else field += ch
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

function CsvPreview({ text, rel }: PreviewProps) {
  const MAX = 5000
  const rows = useMemo(() => {
    const firstLine = text.slice(0, text.indexOf('\n') >>> 0)
    const sep = /\.tsv$/i.test(rel) ? '\t' : (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ','
    return parseDelimited(text, sep, MAX + 1)
  }, [text, rel])
  if (!rows.length) return <div className="empty-state">{tr(FILES_TEXT.empty)}</div>
  const [head, ...body] = rows
  return (
    <div className="csv-preview">
      <table>
        <thead>
          <tr>
            <th className="rownum">#</th>
            {head.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.slice(0, MAX).map((r, i) => (
            <tr key={i}>
              <td className="rownum">{i + 1}</td>
              {r.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > MAX && <div className="faint" style={{ padding: 10 }}>{tr(M.csvFirstRows, { count: MAX })}</div>}
    </div>
  )
}

function HtmlPreview({ text }: PreviewProps) {
  // Sandboxed with no permissions: scripts, forms and navigation are all blocked.
  return <iframe className="html-preview" sandbox="" srcDoc={text} title={tr(M.htmlPreview)} />
}

function SvgPreview({ text }: PreviewProps) {
  // Rendered as an <img>, so scripts inside the SVG never run.
  const url = useMemo(() => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`, [text])
  return (
    <div className="image-preview checker">
      <img src={url} alt="" />
    </div>
  )
}

function ImagePreview({ abs }: PreviewProps) {
  const [actual, setActual] = useState(false)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const [bust] = useState(() => Date.now())
  return (
    // i18n-ignore: class names
    <div className={cx('image-preview checker', actual && 'actual')} onClick={() => setActual(!actual)} title={tr(actual ? M.fit : M.actualSize)}>
      <img src={`${imageUrl(abs)}?t=${bust}`} alt="" onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
      {size && (
        <span className="image-size">
          {size.w} × {size.h}
        </span>
      )}
    </div>
  )
}

function PdfPreview({ abs }: PreviewProps) {
  // Chromium's PDF viewer doesn't run in a sandboxed frame; the source is combwork-img:, which only serves images and PDFs from the workspace.
  // eslint-disable-next-line react/iframe-missing-sandbox
  return <iframe className="pdf-preview" src={imageUrl(abs)} title={tr(M.pdfPreview)} />
}
