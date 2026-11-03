/**
 * A dialect file and its one check (dialects, HI-2065; plans/2026-11-03-dialects-design.md, sections 2, 3 and 5).
 *
 * A file is JSON: `name` (its label), `model` (a model file's real model ID; a CLI file, the Workspace file, the API
 * file and a test copy have none) and `texts`, each id → `{ text, why }`. The only check is the schema's (decision 11):
 * the id exists, and the text has exactly that id's placeholders, which parsing the ICU is how they are read (so text
 * that doesn't parse fails too). Nothing checks what a text says: "If someone write a bad instruction that's on them."
 * A save that fails is refused (store.ts); a file loaded with texts that fail keeps the passing ones, and those that
 * fail are outdated and fall through to the layer below (section 5). Hive never rewrites them.
 *
 * Pure, and loadable in plain Node (imports name their `.ts`): the scenarios' harness reads a `--dialect` file with it.
 */
import { IcuError, parseIcu, placeholdersOf, type PlaceholderKind } from '../../shared/agentText/icu.ts'

/** The schema (agent-text/schema/*.json, merged): each agent text's id → its placeholders and their kinds. */
export type DialectSchema = Readonly<Record<string, Readonly<Record<string, PlaceholderKind>>>>

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

/** The Workspace layer's file, in the dialects folder. */
export const WORKSPACE_FILE = 'workspace.json'
/** Each CLI folder's (and the API folder's) CLI-layer file. */
export const CLI_FILE = 'cli.json'
/** On/off switches, kept apart so switching doesn't make a shipped copy "edited". */
export const STATE_FILE = '.state.json'
/** The CLI slot of callers with no session (decision 12). */
export const API_FOLDER = 'api'

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

/** What's wrong with one override against the schema, or null when it matches. */
export function textProblem(schema: DialectSchema, id: string, entry: unknown): TextProblem | null {
  if (!Object.hasOwn(schema, id)) return { id, problem: 'unknown' }
  if (!isRecord(entry) || typeof entry.text !== 'string' || (entry.why !== undefined && typeof entry.why !== 'string')) return { id, problem: 'shape' }
  let own: Record<string, PlaceholderKind>
  try {
    own = placeholdersOf(parseIcu(entry.text))
  } catch (e) {
    return { id, problem: 'unparsable', detail: e instanceof IcuError ? e.message : String(e) }
  }
  const want = schema[id]
  const missing = Object.keys(want).filter((n) => !Object.hasOwn(own, n))
  const extra = Object.keys(own).filter((n) => !Object.hasOwn(want, n))
  const changed = Object.keys(want).filter((n) => Object.hasOwn(own, n) && own[n] !== want[n])
  return missing.length || extra.length || changed.length ? { id, problem: 'placeholders', missing: missing.sort(), extra: extra.sort(), changed: changed.sort() } : null
}

/** A file's overrides split by the schema: those that apply (id → text), and those outdated (each with why). */
export function checkTexts(file: Pick<DialectFile, 'texts'>, schema: DialectSchema): { texts: Record<string, string>; outdated: TextProblem[] } {
  const texts: Record<string, string> = Object.create(null)
  const outdated: TextProblem[] = []
  for (const id of Object.keys(file.texts).sort()) {
    const entry = file.texts[id]
    const problem = textProblem(schema, id, entry)
    if (problem) outdated.push(problem)
    else texts[id] = entry.text
  }
  return { texts, outdated }
}

/** A dialect file as Hive writes it: its fields in order, ids sorted, two-space JSON with a final newline. */
export function dialectFileText(file: DialectFile): string {
  const texts: Record<string, DialectText> = {}
  for (const id of Object.keys(file.texts).sort()) {
    const { text, why } = file.texts[id]
    texts[id] = why !== undefined ? { text, why } : { text }
  }
  return JSON.stringify({ name: file.name, ...(file.model !== undefined ? { model: file.model } : {}), texts }, null, 2) + '\n'
}

/** The schema as agent-text/schema/<area>.json files hold it (id → { placeholders }), merged into one. */
export function schemaOf(areas: Iterable<unknown>): DialectSchema {
  const schema: Record<string, Record<string, PlaceholderKind>> = Object.create(null)
  for (const area of areas) {
    if (!isRecord(area)) continue
    for (const [id, entry] of Object.entries(area)) {
      const p = isRecord(entry) && isRecord(entry.placeholders) ? entry.placeholders : {}
      const kinds: Record<string, PlaceholderKind> = Object.create(null)
      for (const [name, kind] of Object.entries(p)) kinds[name] = kind as PlaceholderKind
      schema[id] = kinds
    }
  }
  return schema
}
