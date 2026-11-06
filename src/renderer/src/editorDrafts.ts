import { msg, tr } from '../../shared/i18n'

/** Why a draft couldn't be saved: the file changed on disk meanwhile. */
const CHANGED_ON_DISK = msg({ id: 'actions.drafts.changedOnDisk', defaultMessage: 'changed on disk since you opened it', description: "Why an unsaved file couldn't be saved (after its name, in a list): it changed on disk since it was opened. Lower case." })

/**
 * Unsaved edits in the editors outside the Files tab (shared notes, skills, instruction and memory files,
 * MCP servers). Like the Files tab's drafts they are kept while Combwork is open, so changing view or file
 * doesn't lose them, and quitting, reloading, closing or switching the workspace asks about them.
 */
export interface EditorDraft {
  /** What the draft is of: a file path, or e.g. "mcp:<name>". */
  key: string
  /** Shown when asking about unsaved changes. */
  label: string
  /** The file, for the quit dialog. */
  abs: string
  text: string
  /** The text as loaded: saving refuses (CONFLICT) to overwrite a file changed on disk since. */
  base: string
  /** Saves `text` unless the file changed from `base`; resolves to the text as written (the MCP view adds a final newline). */
  save: (text: string, base: string) => Promise<string>
}

const drafts = new Map<string, EditorDraft>()
const listeners = new Set<() => void>()
const changed = (): void => listeners.forEach((l) => l())

export const editorDraft = (key: string): EditorDraft | undefined => drafts.get(key.toLowerCase())
export const editorDraftList = (): EditorDraft[] => [...drafts.values()]

/** Drafts being saved by Save All: kept even when edited back to their base, as the file is about to change. */
const saving = new Set<string>()

/** Records an editor's text: a draft while it differs from what was loaded, none once it's the same again. */
export function setEditorDraft(d: EditorDraft): void {
  const k = d.key.toLowerCase()
  if (d.text === d.base && !saving.has(k)) {
    if (drafts.delete(k)) changed()
  } else {
    const had = drafts.has(k)
    drafts.set(k, d)
    if (!had) changed()
  }
}

export function clearEditorDraft(key: string): void {
  if (drafts.delete(key.toLowerCase())) changed()
}

const under = (key: string, path: string): boolean => {
  const k = key.toLowerCase()
  const p = path.toLowerCase().replace(/[\\/]+$/, '')
  return k === p || k.startsWith(`${p}\\`) || k.startsWith(`${p}/`)
}

/** Whether there are unsaved edits of this file, or of files in this folder. */
export const hasEditorDraftsUnder = (path: string): boolean => [...drafts.keys()].some((k) => under(k, path))

/** Drops the drafts of a file, or of the files in a folder, that is gone (deleted, or replaced by Combwork's version). */
export function clearEditorDraftsUnder(path: string): void {
  let any = false
  for (const k of [...drafts.keys()]) if (under(k, path) && drafts.delete(k)) any = true
  if (any) changed()
}

export function clearEditorDrafts(): void {
  if (!drafts.size) return
  drafts.clear()
  changed()
}

/** Called when drafts appear or go (not on every key press). */
export function onEditorDrafts(l: () => void): () => void {
  listeners.add(l)
  return () => void listeners.delete(l)
}

/** Saves every draft. One whose file changed on disk since it was loaded is kept and reported. */
export async function saveEditorDrafts(): Promise<{ saved: number; failed: { abs: string; message: string }[] }> {
  const failed: { abs: string; message: string }[] = []
  let saved = 0
  for (const [k, d] of [...drafts]) {
    saving.add(k)
    try {
      const written = await d.save(d.text, d.base)
      // Edited while it was saving (even back to what it was): the newer text stays a draft, now of what was written.
      const now = drafts.get(k)
      if (now === d || now?.text === d.text) drafts.delete(k)
      else if (now) now.base = written
      saved++
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e)
      failed.push({ abs: d.abs, message: `${d.label}: ${why.includes('CONFLICT') ? tr(CHANGED_ON_DISK) : why}` })
      // Not saved: a draft edited back to its base is no draft after all.
      const now = drafts.get(k)
      if (now && now.text === now.base) drafts.delete(k)
    } finally {
      saving.delete(k)
    }
  }
  changed()
  return { saved, failed }
}
