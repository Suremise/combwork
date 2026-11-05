/**
 * The Dialects view's side of the service (HI-2444; plans/2026-11-03-dialects-design.md, section 4): the catalogue of
 * agent texts every file shows, the list of a workspace's files with their state, a file with the layers beneath it,
 * and the one-use tokens of a file picked to import. Everything works in the workspace it is given (the requesting
 * window's) and on paths `placeOf` accepts; the changes themselves are store.ts's, checked there.
 */
import { randomUUID } from 'crypto'
import { join } from 'path'
import { readFile } from 'original-fs/promises'
import type { DialectCatalogue, DialectCatalogueText, DialectFileView, DialectKind, DialectLayer, DialectRow } from '../../shared/dialects'
import { bundledIds, bundledStatus } from '../bundled'
import { API_FOLDER, WORKSPACE_FILE, checkTexts, parseDialectFile } from './format'
import type { LoadedDialect } from './chain'
import { agentTextSchema } from './schema'
import { dialectsDir, loadDialects, placeOf } from './store'

const AREAS = import.meta.glob<unknown>('../../../agent-text/catalogue/*.json', { eager: true, import: 'default' })

let catalogue: DialectCatalogue | null = null

/** The catalogue of agent texts this Combwork was built with, by area: the Default every file shows beneath it. */
export function dialectCatalogue(): DialectCatalogue {
  if (catalogue) return catalogue
  const schema = agentTextSchema()
  const texts: DialectCatalogueText[] = []
  const areas: string[] = []
  for (const [file, data] of Object.entries(AREAS).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const area = file.replace(/^.*\//, '').replace(/\.json$/, '')
    if (!data || typeof data !== 'object') continue
    areas.push(area)
    for (const [id, entry] of Object.entries(data as Record<string, { text?: unknown; note?: unknown }>)) {
      if (typeof entry?.text !== 'string') continue
      texts.push({ id, area, text: entry.text, ...(typeof entry.note === 'string' && entry.note ? { note: entry.note } : {}), placeholders: { ...schema[id] } })
    }
  }
  return (catalogue = { areas, texts })
}

/** A file's kind, from its path. */
function kindOf(path: string): DialectKind {
  const place = placeOf(path)
  if (!place || place.kind === 'workspace') return 'workspace'
  if (place.cli) return place.folder === API_FOLDER ? 'api' : 'cli'
  return 'model'
}

/** The workspace's shipped dialect files, as ids ("claude-code/Opus 5.5"). */
const shippedIds = async (): Promise<Set<string>> => new Set((await bundledIds('dialects').catch(() => [])).map((id) => id.toLowerCase()))

/** A loaded file as a row: what it matches, its counts and its state against what Combwork ships. */
async function rowOf(dir: string, f: LoadedDialect, shipped: ReadonlySet<string>): Promise<DialectRow> {
  const place = placeOf(f.path)
  const kind = kindOf(f.path)
  const id = f.path.replace(/\.json$/i, '')
  let state: DialectRow['state'] = 'yours'
  let updateAvailable = false
  if (shipped.has(id.toLowerCase())) {
    const s = await bundledStatus('dialects', id, join(dir, ...f.path.split('/'))).catch(() => null)
    state = s?.bundled === 'same' ? 'shipped' : 'edited'
    updateAvailable = !!s?.updateAvailable
  }
  return {
    path: f.path,
    folder: place && place.kind === 'folder' ? place.folder : null,
    kind: kind === 'model' && f.model === undefined ? 'copy' : kind,
    name: f.name,
    ...(f.model !== undefined ? { model: f.model } : {}),
    on: f.on,
    ...(f.broken ? { broken: f.broken } : {}),
    overrides: Object.keys(f.texts).length,
    outdated: f.outdated.length,
    state,
    ...(updateAvailable ? { updateAvailable: true as const } : {}),
    ...(f.claimTaken ? { claimTaken: f.claimTaken } : {})
  }
}

/** The Workspace file before anything is saved in it: Combwork never makes it unasked, and the first Save does. */
const EMPTY_WORKSPACE: LoadedDialect = { path: WORKSPACE_FILE, name: 'Workspace', texts: {}, outdated: [], on: true } // i18n-ignore: the file's own name field, written into it at its first Save (each file shows its own)

/**
 * A workspace's dialect files as the view lists them: the Workspace file (shown empty while it isn't there yet, so
 * its layer can be edited), then each folder (its CLI file first, then its model files and test copies by name), the
 * API's last. A folder's own CLI file that is missing has no row.
 */
export async function listDialects(combworkDir: string): Promise<DialectRow[]> {
  const dir = dialectsDir(combworkDir)
  const set = await loadDialects(dir, agentTextSchema())
  const shipped = await shippedIds()
  const files: LoadedDialect[] = [set.workspace ?? EMPTY_WORKSPACE]
  const folders = Object.keys(set.folders).sort((a, b) => (a === API_FOLDER ? 1 : b === API_FOLDER ? -1 : a < b ? -1 : 1))
  for (const name of folders) {
    const f = set.folders[name]
    if (f.cli) files.push(f.cli)
    files.push(...[...f.files].sort((a, b) => (a.path.toLowerCase() < b.path.toLowerCase() ? -1 : 1)))
  }
  return Promise.all(files.map((f) => rowOf(dir, f, shipped)))
}

/** A layer beneath a file: the file filling it (or none), whether it is on, and its overrides that apply. */
const layerOf = (layer: DialectLayer['layer'], f: LoadedDialect | null): DialectLayer => ({ layer, path: f?.path ?? null, ...(f ? { name: f.name } : {}), on: !!f && f.on && !f.broken, texts: f && !f.broken ? { ...f.texts } : {} })

/**
 * A file as the view edits it: its text on disk (a draft's base), what it holds, its outdated overrides, the layers
 * beneath it (top first; the Default beneath all) and the models the other files of its folder claim. Null for a path
 * that isn't a dialect file's, or a file that isn't there.
 */
export async function dialectFileView(combworkDir: string, path: string): Promise<DialectFileView | null> {
  const place = placeOf(path)
  if (!place) return null
  const dir = dialectsDir(combworkDir)
  const read = await readFile(join(dir, ...path.split('/')), 'utf8').catch(() => null)
  // The Workspace file not made yet: empty, and its first Save (from the base '') makes it.
  if (read === null && place.kind !== 'workspace') return null
  const raw = read ?? ''
  const set = await loadDialects(dir, agentTextSchema())
  const folder = place.kind === 'folder' ? set.folders[place.folder] : undefined
  const loaded = place.kind === 'workspace' ? (set.workspace ?? EMPTY_WORKSPACE) : place.cli ? (folder?.cli ?? null) : (folder?.files.find((f) => f.path === path) ?? null)
  if (!loaded) return null
  const parsed = read === null ? { file: { name: EMPTY_WORKSPACE.name, texts: {} } } : parseDialectFile(raw)
  const file = 'file' in parsed ? parsed.file : null
  const below: DialectLayer[] = []
  if (place.kind === 'folder' && !place.cli) below.push(layerOf('cli', folder?.cli ?? null))
  if (place.kind === 'folder') below.push(layerOf('workspace', set.workspace))
  return {
    row: await rowOf(dir, loaded, await shippedIds()),
    raw,
    file,
    outdated: file ? checkTexts(file, agentTextSchema()).outdated : [],
    below,
    claims: (folder?.files ?? []).filter((f) => f.model && f.path !== path && !f.claimTaken).map((f) => ({ model: f.model!, path: f.path }))
  }
}

/** The files a folder offers an agent of its CLI (Agent Settings' Dialect): its model files and test copies. */
export async function dialectChoices(combworkDir: string, cli: string): Promise<{ path: string; name: string; model?: string }[]> {
  const set = await loadDialects(dialectsDir(combworkDir), agentTextSchema())
  return (set.folders[cli]?.files ?? []).map((f) => ({ path: f.path, name: f.name, ...(f.model !== undefined && !f.claimTaken ? { model: f.model } : {}) })).sort((a, b) => (a.path.toLowerCase() < b.path.toLowerCase() ? -1 : 1))
}

// ---------------------------------------------------------------------------
// Import tokens (HR1 on HI-2444's design): a file the user picked, for one window's workspace only
// ---------------------------------------------------------------------------

interface Picked {
  file: string
  window: number
  combworkDir: string
  at: number
}

const TOKEN_LIMIT = 8
const TOKEN_MS = 10 * 60_000
const picked = new Map<string, Picked>()

/** Keeps a file the user picked under an opaque token, for its window and workspace, for a while; the oldest go first. */
export function rememberPick(file: string, window: number, combworkDir: string, now = Date.now()): string {
  for (const [t, p] of picked) if (now - p.at > TOKEN_MS) picked.delete(t)
  while (picked.size >= TOKEN_LIMIT) picked.delete(picked.keys().next().value!)
  const token = randomUUID()
  picked.set(token, { file, window, combworkDir: combworkDir.toLowerCase(), at: now })
  return token
}

/** The file a token holds, for the same window and workspace while it lasts; null otherwise. */
export function pickOfToken(token: string, window: number, combworkDir: string, now = Date.now()): string | null {
  const p = picked.get(token)
  if (!p) return null
  if (now - p.at > TOKEN_MS) {
    picked.delete(token)
    return null
  }
  return p.window === window && p.combworkDir === combworkDir.toLowerCase() ? p.file : null
}

/** A token used (a successful import): gone. */
export const spendPick = (token: string): boolean => picked.delete(token)

/** A window closed, or its workspace closed or switched: its tokens go. */
export function forgetPicks(match: { window?: number; combworkDir?: string }): void {
  for (const [t, p] of picked) if ((match.window !== undefined && p.window === match.window) || (match.combworkDir !== undefined && p.combworkDir === match.combworkDir.toLowerCase())) picked.delete(t)
}
