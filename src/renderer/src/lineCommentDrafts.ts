// HI-3369: the line comments being written over a revision's diff (LineComments.tsx), kept while the window is open, so a
// draft or an edit being typed comes back when its file's comment layer is made again (another file chosen and back,
// Retry, the changes or the card closed and opened). No React here: the layer subscribes to what it shows.
import type { LineSide } from '@shared/workflow/lineComments'

/** A comment being written, on one side's lines. */
export type Draft = { side: LineSide; from: number; to: number }

/** State held for a layer's boxes (HI-3274), by key, telling those that read it of each change. */
export type HeldStore = { values: Map<string, unknown>; subs: Set<() => void> }
export const heldStore = (): HeldStore => ({ values: new Map(), subs: new Set() })

/** One file's kept drafts and held texts, and the layers showing it (told of each change of its drafts). */
export type KeptDrafts = { drafts: Draft[]; store: HeldStore; subs: Set<() => void> }

const kept = new Map<string, KeptDrafts>()

/**
 * Whose a file's drafts are: the workspace (its path, as the window has it, lower-cased: card numbers and submissions are
 * a workspace's own), the card, the submission and the path. Two workspaces with the same card, submission and path never
 * share one.
 */
export const keptKey = (workspace: string, card: number, submission: number, path: string): string => JSON.stringify([workspace.toLowerCase(), card, submission, path])

/** A file's kept drafts, made empty the first time. */
export function keptFor(key: string): KeptDrafts {
  let k = kept.get(key)
  if (!k) kept.set(key, (k = { drafts: [], store: heldStore(), subs: new Set() }))
  return k
}

/**
 * Changes a file's drafts and tells the layers showing it. The list is the kept one's, not a layer's: a save or cancel that
 * ends after its layer is gone still takes its draft out, and a layer showing the file by then is told.
 */
export function changeDrafts(k: KeptDrafts, change: (ds: Draft[]) => Draft[]): void {
  const next = change(k.drafts)
  if (next === k.drafts) return
  k.drafts = next
  for (const tell of [...k.subs]) tell()
}

/** Tests only: forgets every kept file. */
export function clearKeptDrafts(): void {
  kept.clear()
}
