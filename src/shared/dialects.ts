/**
 * Dialects as the window sees them (dialects, HI-2065; HI-2444, the Dialects view; plans/2026-11-03-dialects-design.md,
 * section 4): a dialect file's shape and why one is refused (the service, src/main/dialects, uses the same types), and
 * what the view's IPC gives: the catalogue of agent texts, each file's row, a file with the layers beneath it, and which
 * running sessions use which files. Types only, and the few pure helpers both sides need.
 */

/** One override: the text, and why it is worded so (the author's reason, shown in the Dialects view). */
export interface DialectText {
  text: string
  why?: string
}

/** A dialect file as it is on disk. */
export interface DialectFile {
  name: string
  /** A model file's real model ID ("claude-opus-5-5"); absent: a CLI, Workspace or API file, or a test copy. */
  model?: string
  texts: Record<string, DialectText>
}

/** Why a file can't be read as a dialect at all: not JSON, or not the shape above. */
export type FileProblem = { problem: 'json' } | { problem: 'shape'; field: 'file' | 'name' | 'model' | 'texts' }

/**
 * Why one override doesn't match the schema:
 * - `unknown`: no agent text has that id (it was removed or renamed);
 * - `shape`: its entry isn't `{ text, why? }` with strings;
 * - `unparsable`: its text isn't ICU agent text can use;
 * - `placeholders`: its placeholders aren't exactly its id's (`missing` ones, `extra` ones, ones of another kind).
 */
export type TextProblem =
  | { id: string; problem: 'unknown' }
  | { id: string; problem: 'shape' }
  | { id: string; problem: 'unparsable'; detail: string }
  | { id: string; problem: 'placeholders'; missing: string[]; extra: string[]; changed: string[] }

/** Why a change to a dialect file was refused (nothing is written then). */
export type DialectRefusal =
  /** The path isn't a dialect file's (workspace.json, or <folder>/<label>.json). */
  | { refused: 'path' }
  /** The file isn't a dialect (not JSON, or not its shape). */
  | { refused: 'file'; problem: FileProblem }
  /** Texts that don't match the schema. */
  | { refused: 'texts'; problems: TextProblem[] }
  /** Only a model file or a test copy in a CLI folder has a model: not the Workspace, CLI or API files. */
  | { refused: 'modelHere' }
  /** Another file of the folder already claims that model (decision: one file per model). */
  | { refused: 'modelClaimed'; model: string; by: string }
  /** A file of that name is already there. */
  | { refused: 'nameTaken'; path: string }
  /** The file it acts on isn't there (or can't be read as a dialect). */
  | { refused: 'missing'; path: string }
  /** The file changed on disk since the draft was made from it (HI-2444): Save would overwrite that change. */
  | { refused: 'changedOnDisk'; disk: string }
  /** The Workspace file, a CLI file and a shipped file can't be deleted (Revert puts a shipped one back). */
  | { refused: 'protected' }
  /** The name can't be a dialect file's (HI-2523): why, as `dialectLabelProblem` says. */
  | { refused: 'name'; problem: DialectLabelProblem }
  /** The model ID can't be a dialect file's (HI-2523): empty, or with a control character or a line break. */
  | { refused: 'model'; problem: 'empty' | 'control' }
  /** Only the user's own model files and test copies take Set Model: not shipped files, nor the CLI, API or Workspace files. */
  | { refused: 'notYours' }

/** Why a name can't be a dialect file's (HI-2523), or null when it can. */
export type DialectLabelProblem = 'empty' | 'chars' | 'dot' | 'end' | 'reserved' | 'cli' | 'long'

/** The longest name a dialect file takes, in characters (its path stays well inside Windows' limit). */
export const DIALECT_LABEL_MAX = 100

/**
 * Why a name can't be a dialect file's in a CLI folder (HI-2523), or null when it can: a file name Windows takes and
 * shows as typed (none of \ / : * ? " < > | or a control character; no leading dot; no trailing dot or space; not a
 * device name such as CON or COM1, with or without an extension), not "cli" (the CLI's own file), at most
 * DIALECT_LABEL_MAX characters. A name already in the folder is checked where the folder is read.
 */
export function dialectLabelProblem(label: string): DialectLabelProblem | null {
  if (!label.trim()) return 'empty'
  if (/[\\/:*?"<>|\x00-\x1f]/.test(label)) return 'chars'
  if (label.startsWith('.')) return 'dot'
  if (/[. ]$/.test(label) || label.startsWith(' ')) return 'end'
  if (/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i.test(label)) return 'reserved'
  if (label.toLowerCase() === 'cli') return 'cli'
  return label.length > DIALECT_LABEL_MAX ? 'long' : null
}

/** A text of the catalogue: the code's English (the Default), the note beside it, its area and its placeholders. */
export interface DialectCatalogueText {
  id: string
  /** Its area: the catalogue file it is in ("contract", "tool", "reply"…). */
  area: string
  text: string
  note?: string
  /** Its placeholders and their kinds ("project": "plain"). */
  placeholders: Record<string, string>
}

/** The catalogue of agent texts this Combwork was built with: every text a dialect can override, by area. */
export interface DialectCatalogue {
  areas: string[]
  texts: DialectCatalogueText[]
}

/** Which layer a file fills: the Workspace file, a CLI's (or the API's) file, or a model file or test copy. */
export type DialectKind = 'workspace' | 'cli' | 'api' | 'model' | 'copy'

/** A dialect file as the view's list shows it. */
export interface DialectRow {
  /** Its path in the dialects folder, with `/` ("claude-code/Opus 5.5.json", "workspace.json"). */
  path: string
  /** Its folder: a provider's id, or "api"; null for the Workspace file. */
  folder: string | null
  kind: DialectKind
  name: string
  /** A model file's model ID. */
  model?: string
  /** Off in the view: its slot is empty, and its texts fall through. */
  on: boolean
  /** It can't be read as a dialect: it adds nothing. */
  broken?: FileProblem
  /** Its overrides that apply, and those outdated (they fall through). */
  overrides: number
  outdated: number
  /** Shipped with Combwork and untouched, shipped and edited, or the user's own. */
  state: 'shipped' | 'edited' | 'yours'
  /** An edited shipped file whose shipped version is newer than the one it was made from. */
  updateAvailable?: true
  /** Another file of its folder claimed its model first: Auto never picks this one. */
  claimTaken?: string
}

/** One layer beneath a file, for its inherited texts: which file fills it and the overrides of it that apply. */
export interface DialectLayer {
  layer: 'model' | 'cli' | 'api' | 'workspace'
  /** Its file's path, or null when the layer is empty (its file missing). */
  path: string | null
  name?: string
  /** Off: its texts don't apply (shown, but not inherited). */
  on: boolean
  texts: Record<string, string>
}

/** A file as the view edits it: its text on disk, what it holds, and the layers beneath it, top first. */
export interface DialectFileView {
  row: DialectRow
  /** Its text on disk, as read: a draft's base (Save is refused when the file differs by then). */
  raw: string
  /** What it holds, or null when it isn't a dialect file (`row.broken` says why). */
  file: DialectFile | null
  /** Its overrides that don't match the schema, each with why. */
  outdated: TextProblem[]
  /** The layers beneath it, top first; the Default (the catalogue) is beneath them all. */
  below: DialectLayer[]
  /** The models other files of its folder claim (Promote offers them). */
  claims: { model: string; path: string }[]
}

/** A running session's dialect chain, for the view (never the Agent API): the files it launched on, and if it moved. */
export interface DialectUsage {
  projectPath: string
  agentId: string
  /** Its name as the window shows it. */
  agent: string
  cli: string
  /** The file of each layer it launched on that has one, top first (shipped empty files too). */
  files: string[]
  /** A launch now would give it another chain: its files changed, or its Dialect setting did ("restart to apply"). */
  moved: boolean
}

/** A file's layer path parts: its folder and label ("claude-code", "Opus 5.5"); null for the Workspace file. */
export function dialectPathParts(path: string): { folder: string; label: string } | null {
  const i = path.indexOf('/')
  return i < 0 ? null : { folder: path.slice(0, i), label: path.slice(i + 1).replace(/\.json$/i, '') }
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** A file's text read as a dialect, or why it can't be. Its texts' entries aren't checked here (checkTexts does). */
export function parseDialectFile(raw: string): { file: DialectFile } | { problem: FileProblem } {
  let data: unknown
  try {
    // A BOM (Notepad's UTF-8) isn't the file's content.
    data = JSON.parse(raw.replace(/^﻿/, ''))
  } catch {
    return { problem: { problem: 'json' } }
  }
  if (!isRecord(data)) return { problem: { problem: 'shape', field: 'file' } }
  if (typeof data.name !== 'string') return { problem: { problem: 'shape', field: 'name' } }
  if (data.model !== undefined && (typeof data.model !== 'string' || !data.model.trim())) return { problem: { problem: 'shape', field: 'model' } }
  if (!isRecord(data.texts)) return { problem: { problem: 'shape', field: 'texts' } }
  // Ids as data, never as an object's own properties ("__proto__" is an id like any other, and unknown).
  const texts: Record<string, DialectText> = Object.create(null)
  for (const [id, entry] of Object.entries(data.texts)) texts[id] = entry as DialectText
  return { file: { name: data.name, ...(data.model !== undefined ? { model: (data.model as string).trim() } : {}), texts } }
}

/**
 * A dialect file as Combwork writes it: its fields in order, ids sorted, two-space JSON with a final newline. An entry that
 * isn't `{ text, why? }` (an outdated one written by hand: `null`, a number) is kept as it is, never dropped or fatal:
 * Combwork doesn't rewrite what the user wrote (HR1, HI-2439 r1).
 */
export function dialectFileText(file: DialectFile): string {
  const texts: Record<string, unknown> = {}
  for (const id of Object.keys(file.texts).sort()) {
    const entry: unknown = file.texts[id]
    if (!isRecord(entry) || typeof entry.text !== 'string') {
      texts[id] = entry === undefined ? null : entry
      continue
    }
    const { text, why, ...rest } = entry
    texts[id] = { text, ...(why !== undefined ? { why } : {}), ...rest }
  }
  return JSON.stringify({ name: file.name, ...(file.model !== undefined ? { model: file.model } : {}), texts }, null, 2) + '\n'
}

// ---------------------------------------------------------------------------
// The view model (HI-2444): what a text of a file shows, from the file's draft, the layers beneath it and the Default
// ---------------------------------------------------------------------------

/** Where a shown text comes from: this file, a layer beneath it (by index in `below`), or the Default. */
export type TextSource = { from: 'file' } | { from: 'layer'; index: number } | { from: 'default' }

/** The text a file inherits for an id: the first layer beneath it that is on and overrides it, else the Default. */
export function inheritedText(id: string, below: readonly DialectLayer[], defaultText: string | undefined): { text: string | undefined; source: TextSource } {
  for (const [index, l] of below.entries()) if (l.on && Object.hasOwn(l.texts, id)) return { text: l.texts[id], source: { from: 'layer', index } }
  return { text: defaultText, source: { from: 'default' } }
}

/** A text as a file shows it: its own override when it has one, else what it inherits (dimmed). */
export function shownText(id: string, file: DialectFile | null, below: readonly DialectLayer[], defaultText: string | undefined): { text: string | undefined; source: TextSource; why?: string } {
  const own = file && Object.hasOwn(file.texts, id) ? file.texts[id] : undefined
  if (own && typeof own.text === 'string') return { text: own.text, source: { from: 'file' }, ...(own.why ? { why: own.why } : {}) }
  return inheritedText(id, below, defaultText)
}

/** Each layer's value for an id, top first: this file, each layer beneath it, then the Default (undefined: "—"). */
export function layerValues(id: string, file: DialectFile | null, below: readonly DialectLayer[], defaultText: string | undefined): { source: TextSource; text: string | undefined; on: boolean }[] {
  const own = file && Object.hasOwn(file.texts, id) && typeof file.texts[id]?.text === 'string' ? file.texts[id].text : undefined
  return [{ source: { from: 'file' }, text: own, on: true }, ...below.map((l, index) => ({ source: { from: 'layer', index } as TextSource, text: Object.hasOwn(l.texts, id) ? l.texts[id] : undefined, on: l.on })), { source: { from: 'default' }, text: defaultText, on: true }]
}

/** Whether a file itself overrides an id (the "Changed in this file" filter). */
export const changedHere = (id: string, file: DialectFile | null): boolean => !!file && Object.hasOwn(file.texts, id)

/** Whether any layer of the file's chain overrides an id, it or one beneath it that is on ("Changed anywhere"). */
export const changedAnywhere = (id: string, file: DialectFile | null, below: readonly DialectLayer[]): boolean => changedHere(id, file) || below.some((l) => l.on && Object.hasOwn(l.texts, id))
