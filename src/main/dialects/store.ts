/**
 * A workspace's dialect files on disk (dialects, HI-2065; plans/2026-11-03-dialects-design.md, sections 3–5), in
 * `.combwork/dialects/`:
 *
 *   workspace.json            the Workspace layer (the user's: Combwork never ships into it)
 *   api/cli.json              the API layer, for callers with no session
 *   <provider>/cli.json       a CLI's file
 *   <provider>/<label>.json   a model file (with "model") or a test copy (without)
 *   .state.json               the on/off switches: { "off": [paths] }
 *
 * Combwork's shipped copies arrive through bundled.ts (kind `dialects`), which records them as it does skills and modes.
 * Each change here is refused with a reason as data (`DialectRefusal`), for the Dialects view to say in its words: a
 * text that fails the schema, a second claim on a model in a folder, a name taken. Nothing here checks what a text says.
 */
import { readdir, readFile } from 'original-fs/promises'
import { join } from 'path'
import { readJson, withFileLock, writeJsonAtomic, writeTextAtomic } from '../fsutil'
import { createLogger, userText } from '../logger'
import type { DialectChain } from '../../shared/agentText'
import { API_FOLDER, CLI_FILE, checkTexts, dialectFileText, parseDialectFile, STATE_FILE, textProblem, WORKSPACE_FILE, type DialectFile, type DialectSchema } from './format'
import type { DialectFolder, DialectSet, LoadedDialect } from './chain'
import { dialectLabelProblem, type DialectRefusal } from '../../shared/dialects'
import { dialectModelProblem } from '../../shared/models'

const log = createLogger('dialects')

/** A workspace's dialects folder. */
export const dialectsDir = (combworkDir: string): string => join(combworkDir, 'dialects')

/** A folder: a provider's id, or `api`. */
const FOLDER = /^[a-z0-9][a-z0-9-]*$/
/** A file's label, as its file name has it: no path, nothing Windows refuses, not hidden. */
const LABEL = /^[^\\/:*?"<>|\x00-\x1f.][^\\/:*?"<>|\x00-\x1f]*$/

/** Why a change to a dialect file was refused: shared/dialects.ts (the Dialects view says it in its words). */
export type { DialectRefusal } from '../../shared/dialects'

/** Where a path in the dialects folder belongs: the Workspace file, or a folder's file (its CLI file or another). */
export type DialectPlace = { kind: 'workspace' } | { kind: 'folder'; folder: string; file: string; cli: boolean }

/** A dialect file's place from its path ("claude-code/Opus 5.5.json"), or null when it isn't one. */
export function placeOf(path: string): DialectPlace | null {
  if (path === WORKSPACE_FILE) return { kind: 'workspace' }
  const parts = path.split('/')
  if (parts.length !== 2) return null
  const [folder, file] = parts
  if (!FOLDER.test(folder) || !file.endsWith('.json') || !LABEL.test(file.slice(0, -5))) return null
  return { kind: 'folder', folder, file, cli: file === CLI_FILE }
}

/** Whether a file at this place may have a model: a model file or a test copy in a CLI folder. */
const mayHaveModel = (p: DialectPlace): boolean => p.kind === 'folder' && !p.cli && p.folder !== API_FOLDER

const sameModel = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()

// ---------------------------------------------------------------------------
// On and off
// ---------------------------------------------------------------------------

interface DialectState {
  off: string[]
}

async function readState(dir: string): Promise<DialectState> {
  const s = await readJson<unknown>(join(dir, STATE_FILE), null)
  const off = s && typeof s === 'object' && Array.isArray((s as DialectState).off) ? (s as DialectState).off.filter((p): p is string => typeof p === 'string') : []
  return { off }
}

/** Switches a file on or off: off, its slot is empty and its texts fall through. Kept apart from the file itself. */
export async function setDialectOn(dir: string, path: string, on: boolean): Promise<void> {
  const file = join(dir, STATE_FILE)
  await withFileLock(file, async () => {
    const state = await readState(dir)
    const off = new Set(state.off)
    if (on) off.delete(path)
    else off.add(path)
    if (off.size === state.off.length && state.off.every((p) => off.has(p))) return
    await writeJsonAtomic(file, { off: [...off].sort() })
  })
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** One file as a dialect: its overrides split by the schema; one that can't be read is broken and adds nothing. */
async function loadFile(dir: string, path: string, schema: DialectSchema, off: ReadonlySet<string>): Promise<LoadedDialect> {
  const on = !off.has(path)
  const label = path.split('/').pop()!.replace(/\.json$/, '')
  let raw: string
  try {
    raw = await readFile(join(dir, ...path.split('/')), 'utf8')
  } catch {
    return { path, name: label, texts: {}, outdated: [], on, broken: { problem: 'json' } }
  }
  const parsed = parseDialectFile(raw)
  if ('problem' in parsed) {
    log.warn(`The dialect file ${userText(path)} can't be read as a dialect (${parsed.problem.problem}): it adds nothing`)
    return { path, name: label, texts: {}, outdated: [], on, broken: parsed.problem }
  }
  const { texts, outdated } = checkTexts(parsed.file, schema)
  const place = placeOf(path)
  const model = parsed.file.model !== undefined && place && mayHaveModel(place) ? parsed.file.model : undefined
  return { path, name: parsed.file.name, ...(model !== undefined ? { model } : {}), texts, outdated, on }
}

const jsonFiles = async (folder: string): Promise<string[]> =>
  readdir(folder, { withFileTypes: true })
    .then((es) => es.filter((e) => e.isFile() && e.name.endsWith('.json') && LABEL.test(e.name.slice(0, -5))).map((e) => e.name))
    .catch(() => [])

/**
 * Whether a folder already has an entry of this file name, in any case, whatever it is (HR2, HI-2523 r1): Windows names
 * are case-blind, so "Upper.JSON" (which jsonFiles leaves out) is the file "Upper.json" would overwrite.
 */
const nameInUse = async (folder: string, fileName: string): Promise<boolean> =>
  readdir(folder)
    .then((names) => names.some((n) => n.toLowerCase() === fileName.toLowerCase()))
    .catch(() => false)

/**
 * Loads a workspace's dialects, each file checked against the schema. Within a folder, files are taken in name order,
 * and a model claimed twice (two files made outside Combwork) is the first one's: the other is marked and Auto skips it.
 */
export async function loadDialects(dir: string, schema: DialectSchema): Promise<DialectSet> {
  const { off: offList } = await readState(dir)
  const off = new Set(offList)
  const ws = (await jsonFiles(dir)).includes(WORKSPACE_FILE) ? await loadFile(dir, WORKSPACE_FILE, schema, off) : null
  const folders: Record<string, DialectFolder> = Object.create(null)
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries.filter((d) => d.isDirectory() && FOLDER.test(d.name)).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const names = (await jsonFiles(join(dir, e.name))).sort()
    const loaded = await Promise.all(names.map((n) => loadFile(dir, `${e.name}/${n}`, schema, off)))
    const cli = loaded.find((f) => f.path === `${e.name}/${CLI_FILE}`) ?? null
    const files = loaded.filter((f) => f !== cli)
    const claimed: LoadedDialect[] = []
    for (const f of files) {
      if (!f.model) continue
      const first = claimed.find((c) => sameModel(c.model!, f.model!))
      if (first) {
        f.claimTaken = first.path
        log.warn(`The dialect files ${userText(first.path)} and ${userText(f.path)} both claim the model ${userText(f.model)}: Auto uses the first`)
      } else claimed.push(f)
    }
    folders[e.name] = { cli, files }
  }
  return { workspace: ws, folders }
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

/** The models a folder's files claim now, by path (read under the folder's lock). */
async function claimsIn(dir: string, folder: string): Promise<{ path: string; model: string; file: DialectFile; raw: string }[]> {
  const out: { path: string; model: string; file: DialectFile; raw: string }[] = []
  for (const name of (await jsonFiles(join(dir, folder))).sort()) {
    if (name === CLI_FILE) continue
    const raw = await readFile(join(dir, folder, name), 'utf8').catch(() => null)
    const parsed = raw === null ? null : parseDialectFile(raw)
    if (raw !== null && parsed && 'file' in parsed && parsed.file.model) out.push({ path: `${folder}/${name}`, model: parsed.file.model, file: parsed.file, raw })
  }
  return out
}

/** The lock a change to a file takes: its folder's (claims are per folder), or the Workspace file's. */
const lockOf = (dir: string, place: DialectPlace): string => (place.kind === 'workspace' ? join(dir, WORKSPACE_FILE) : join(dir, place.folder))

/** What's wrong with a file to be written at a place, apart from claims: null when it can be saved. */
function fileRefusal(place: DialectPlace, file: DialectFile, schema: DialectSchema): DialectRefusal | null {
  if (file.model !== undefined && !mayHaveModel(place)) return { refused: 'modelHere' }
  const problems = Object.keys(file.texts)
    .sort()
    .flatMap((id) => textProblem(schema, id, file.texts[id]) ?? [])
  return problems.length ? { refused: 'texts', problems } : null
}

/** Writes a file at a place, checked: the schema, then (in a CLI folder) its model's claim. Under the place's lock. */
async function writeChecked(dir: string, path: string, place: DialectPlace, file: DialectFile, schema: DialectSchema, opts: { fresh?: boolean } = {}): Promise<DialectRefusal | null> {
  const refusal = fileRefusal(place, file, schema)
  if (refusal) return refusal
  if (opts.fresh && (await nameInUse(place.kind === 'workspace' ? dir : join(dir, place.folder), path.split('/').pop()!))) return { refused: 'nameTaken', path }
  if (file.model !== undefined && place.kind === 'folder') {
    const other = (await claimsIn(dir, place.folder)).find((c) => c.path.toLowerCase() !== path.toLowerCase() && sameModel(c.model, file.model!))
    if (other) return { refused: 'modelClaimed', model: file.model, by: other.path }
  }
  await writeTextAtomic(join(dir, ...path.split('/')), dialectFileText(file))
  return null
}

/** A file's text on disk, as read ('' when it isn't there). */
const rawOf = (dir: string, path: string): Promise<string> => readFile(join(dir, ...path.split('/')), 'utf8').catch(() => '')

/**
 * Saves a dialect file (the Dialects view's Save): refused, and nothing written, when a text fails the schema, the file
 * may not have a model, or another file of its folder claims its model. It applies at each agent's next launch.
 * `base` (HI-2444): the text on disk the draft was made from. Under the same lock as the write, a file that now differs
 * is refused (`changedOnDisk`, with its text), so a change made meanwhile (an editor, another window) is never lost.
 */
export async function saveDialect(dir: string, path: string, file: DialectFile, schema: DialectSchema, opts: { base?: string } = {}): Promise<DialectRefusal | null> {
  const place = placeOf(path)
  if (!place) return { refused: 'path' }
  return withFileLock(lockOf(dir, place), async () => {
    if (opts.base !== undefined) {
      const disk = await rawOf(dir, path)
      if (disk !== opts.base) return { refused: 'changedOnDisk', disk }
    }
    return writeChecked(dir, path, place, file, schema)
  })
}

/** Saves a file from its JSON as typed (the view's JSON tab): refused when it isn't a dialect file; else as saveDialect. */
export async function saveDialectRaw(dir: string, path: string, raw: string, schema: DialectSchema, opts: { base?: string } = {}): Promise<DialectRefusal | null> {
  const parsed = parseDialectFile(raw)
  if ('problem' in parsed) return { refused: 'file', problem: parsed.problem }
  return saveDialect(dir, path, parsed.file, schema, opts)
}

/**
 * Deletes a file the user made (a test copy, an import), to the Recycle Bin (`remove`: trash()). The Workspace file, a
 * CLI's (or the API's) file and a shipped file are refused (`protected`): they are the chain's baseline, and Revert puts
 * a shipped one back. Checked under its folder's lock, against the file as it is then. Its on/off switch goes with it.
 */
export async function deleteDialect(dir: string, path: string, opts: { shipped: ReadonlySet<string>; remove: (file: string) => Promise<void> }): Promise<DialectRefusal | null> {
  const place = placeOf(path)
  if (!place) return { refused: 'path' }
  if (place.kind === 'workspace' || place.cli || [...opts.shipped].some((id) => `${id}.json`.toLowerCase() === path.toLowerCase())) return { refused: 'protected' }
  const removed = await withFileLock(lockOf(dir, place), async (): Promise<DialectRefusal | null> => {
    const at = join(dir, ...path.split('/'))
    if ((await readFile(at, 'utf8').catch(() => null)) === null) return { refused: 'missing', path }
    await opts.remove(at)
    return null
  })
  if (!removed) await setDialectOn(dir, path, true)
  return removed
}

/**
 * Imports a dialect file's text into a folder under a label (the view's Import): checked as a save is, and a new file
 * only. A `model` another file of the folder claims is removed, so it comes in as a test copy (`testCopy`); a `model`
 * a Workspace, CLI or API file can't have is removed too.
 */
export async function importDialect(dir: string, path: string, raw: string, schema: DialectSchema): Promise<{ testCopy: boolean } | DialectRefusal> {
  const place = placeOf(path)
  if (!place) return { refused: 'path' }
  const parsed = parseDialectFile(raw)
  if ('problem' in parsed) return { refused: 'file', problem: parsed.problem }
  return withFileLock(lockOf(dir, place), async () => {
    let file = parsed.file
    let testCopy = false
    if (file.model !== undefined && (!mayHaveModel(place) || (place.kind === 'folder' && (await claimsIn(dir, place.folder)).some((c) => sameModel(c.model, file.model!))))) {
      const { model: _dropped, ...rest } = file
      file = rest
      testCopy = mayHaveModel(place)
    }
    const refusal = await writeChecked(dir, path, place, file, schema, { fresh: true })
    return refusal ?? { testCopy }
  })
}

/** Reads a dialect file as it is on disk, or null when it can't be read as one. */
export async function readDialect(dir: string, path: string): Promise<DialectFile | null> {
  if (!placeOf(path)) return null
  const raw = await readFile(join(dir, ...path.split('/')), 'utf8').catch(() => null)
  const parsed = raw === null ? null : parseDialectFile(raw)
  return parsed && 'file' in parsed ? parsed.file : null
}

/**
 * Writes a file of a CLI folder that claims `model` (or none), taking the claim off every other file of the folder that
 * has it first: each keeps its texts and becomes a test copy, as a backup, so the folder never has two. Called under
 * the folder's lock.
 *
 * All or nothing (HR1, HI-2439 r1): every file's new text is made before any is written, and a write that fails puts
 * back the files already changed as they were, so a failed change never leaves the model unclaimed. It throws then.
 */
async function writeClaiming(dir: string, folder: string, path: string, file: DialectFile, what: string): Promise<{ from: string | null }> {
  const model = file.model
  const others = model === undefined ? [] : (await claimsIn(dir, folder)).filter((c) => c.path.toLowerCase() !== path.toLowerCase() && sameModel(c.model, model))
  // Each write, old owners first, with what to put back: made in full before anything changes.
  const writes = [
    ...others.map((o) => {
      const { model: _dropped, ...rest } = o.file
      return { at: join(dir, ...o.path.split('/')), text: dialectFileText(rest), was: o.raw }
    }),
    { at: join(dir, ...path.split('/')), text: dialectFileText(file), was: null }
  ]
  const done: (typeof writes)[number][] = []
  try {
    for (const w of writes) {
      await writeTextAtomic(w.at, w.text)
      done.push(w)
    }
  } catch (e) {
    for (const w of done.reverse()) if (w.was !== null) await writeTextAtomic(w.at, w.was).catch((err) => log.warn(`${what} of ${userText(path)} failed, and ${userText(w.at)} couldn't be put back as it was`, err))
    throw e
  }
  if (model !== undefined) log.info(`${what}: the dialect file ${userText(path)} claims ${userText(model)}${others.length ? ` (from ${others.map((o) => userText(o.path)).join(', ')})` : ''}`)
  return { from: others[0]?.path ?? null }
}

/**
 * A new file of a CLI folder (HI-2523): New Model File (empty, so it inherits every text) or Duplicate (`from`, a model
 * file or test copy of the same folder: its texts as they are, outdated ones too, since a copy changes nothing). With a
 * `model` it is that model's file at once, the file that had the model becoming a test copy (as Set Model does); without
 * one it is a test copy, which only agents whose Dialect setting names it use. Refused with why: a folder that isn't a
 * CLI's (`isCli`), a name `dialectLabelProblem` refuses or one the folder has (in any case), a model ID that is empty or
 * has a control character, a `from` of another folder or gone. Checked under the folder's lock.
 */
export async function createDialect(dir: string, folder: string, label: string, opts: { model?: string; from?: string; isCli: (folder: string) => boolean }): Promise<{ path: string; from: string | null } | DialectRefusal> {
  if (folder === API_FOLDER || !FOLDER.test(folder) || !opts.isCli(folder)) return { refused: 'path' }
  const name = label.trim()
  const problem = dialectLabelProblem(name)
  if (problem) return { refused: 'name', problem }
  const model = opts.model?.trim() || undefined
  if (opts.model !== undefined && opts.model.trim()) {
    const bad = dialectModelProblem(opts.model)
    if (bad) return { refused: 'model', problem: bad }
  }
  const path = `${folder}/${name}.json`
  const place = placeOf(path)
  if (!place || place.kind !== 'folder' || place.cli) return { refused: 'path' }
  const src = opts.from === undefined ? null : placeOf(opts.from)
  if (opts.from !== undefined && (!src || src.kind !== 'folder' || src.cli || src.folder !== folder)) return { refused: 'path' }
  return withFileLock(lockOf(dir, place), async () => {
    const source = opts.from === undefined ? { name, texts: {} } : await readDialect(dir, opts.from)
    if (!source) return { refused: 'missing', path: opts.from! }
    if (await nameInUse(join(dir, folder), `${name}.json`)) return { refused: 'nameTaken', path }
    const file: DialectFile = { name, texts: source.texts, ...(model !== undefined ? { model } : {}) }
    const r = await writeClaiming(dir, folder, path, file, opts.from === undefined ? 'New Model File' : 'Duplicate') // i18n-ignore: log text
    return { path, from: r.from }
  })
}

/** Duplicates a file of a CLI folder as a test copy beside it (no `model`), under a new label: createDialect's Duplicate. */
export async function duplicateDialect(dir: string, from: string, label: string): Promise<{ path: string } | DialectRefusal> {
  const src = placeOf(from)
  if (!src || src.kind !== 'folder') return { refused: 'path' }
  const r = await createDialect(dir, src.folder, label, { from, isCli: () => true })
  return 'refused' in r ? r : { path: r.path }
}

/**
 * Set Model (HI-2523; Promote, "Use for <model>", before it): moves a model's claim onto a model file or test copy. The
 * file that had it keeps its texts and becomes a test copy, as a backup. The claim is taken off the old file before it
 * is put on this one, so the folder never has two. Agents on Auto pick it up at their next launch. `shipped` (the ids
 * Combwork ships): a shipped file is refused (`notYours`): only the user's own files are retargeted. All or nothing, as
 * writeClaiming says.
 */
export async function promoteDialect(dir: string, path: string, model: string, opts: { shipped?: ReadonlySet<string> } = {}): Promise<{ from: string | null } | DialectRefusal> {
  const place = placeOf(path)
  if (!place || !mayHaveModel(place) || place.kind !== 'folder') return { refused: 'path' }
  const bad = dialectModelProblem(model)
  if (bad) return { refused: 'model', problem: bad }
  if (opts.shipped && [...opts.shipped].some((id) => `${id}.json`.toLowerCase() === path.toLowerCase())) return { refused: 'notYours' }
  return withFileLock(lockOf(dir, place), async () => {
    const file = await readDialect(dir, path)
    if (!file) return { refused: 'missing', path }
    return writeClaiming(dir, place.folder, path, { ...file, model: model.trim() }, 'Set Model') // i18n-ignore: log text
  })
}

// ---------------------------------------------------------------------------
// A session's resolved texts, for cw-mcp.js and cw-progress.js
// ---------------------------------------------------------------------------

/** The file a launch's resolved texts go in, in its private folder. */
export const DIALECT_FILE_NAME = 'dialect.json'

/**
 * Writes a session's resolved chain (only the overrides, merged) into its launch's private folder, and returns the
 * environment that names it: `CW_DIALECT_FILE`, and `CW_DIALECT` (the chain's hash). processDialect.ts reads it.
 */
export async function writeDialectFile(folder: string, chain: DialectChain): Promise<{ file: string; env: { CW_DIALECT_FILE: string; CW_DIALECT: string } }> {
  const file = join(folder, DIALECT_FILE_NAME)
  await writeJsonAtomic(file, { texts: { ...chain.texts }, files: [...chain.files], hash: chain.hash })
  return { file, env: { CW_DIALECT_FILE: file, CW_DIALECT: chain.hash } }
}
