/**
 * MCP catalogues (HI-545): catalog.json, schemaVersion 1, as the mcp project publishes it (its README's "The
 * catalogue", `scripts/catalog.mjs` `validate()` the reference this follows), and what Hive works out from one:
 * whether this PC meets a server's requirements, whether one is installed or has an update, and which are shown for a
 * search and a filter. Pure: main reads the catalogues and probes the PC.
 */
import type { McpCatalogCheck, McpCatalogFilter, McpCatalogRequires, McpCatalogServer } from './types'

export const CATALOG_SCHEMA_VERSION = 1
/** Ours, first in every list and on unless turned off (11 and 14 Oct decisions). */
export const OUR_CATALOG_URL = 'https://github.com/Suremise/combwork-mcp/releases/latest/download/catalog.json'
/**
 * Ours at its earlier addresses (HI-2472: the mcp repo was Suremise/hive-mcp, which GitHub redirects): servers
 * installed from it there are still ours, and none is listed again as someone else's.
 */
export const OUR_OLD_CATALOG_URLS: readonly string[] = ['https://github.com/Suremise/hive-mcp/releases/latest/download/catalog.json']
/** Whether a catalogue address is ours, now or before. */
export const isOurCatalogUrl = (url: string): boolean => url === OUR_CATALOG_URL || OUR_OLD_CATALOG_URLS.includes(url)
/** Whether two addresses are the same catalogue: the same address, or ours by any of its addresses. */
export const sameCatalogSource = (a: string, b: string): boolean => a === b || (isOurCatalogUrl(a) && isOurCatalogUrl(b))

const OSES = ['windows', 'macos', 'linux']
const EDITIONS = ['Home', 'Pro', 'Enterprise', 'Education'] // i18n-ignore: Windows' editions as catalogues name them (ids)
const NAME = /^[a-z0-9][a-z0-9-]*$/
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const TAG = /^[a-z0-9][a-z0-9-]*$/
const SHA256 = /^[0-9a-f]{64}$/
const MAX_DESCRIPTION = 200

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && !/[\r\n]/.test(v)
const isHttps = (v: unknown): v is string => typeof v === 'string' && /^https:\/\/[^\s/]+\/\S*$/.test(v)
const isFileUrl = (v: unknown): v is string => typeof v === 'string' && /^file:\/\/\S+$/i.test(v)

/** A catalogue's address Hive reads: https, or file:// (a share; Q2 of HI-545/s14). */
export const catalogUrlAllowed = (url: string): boolean => isHttps(url) || isFileUrl(url)

/** Whether a server's requires is valid. */
function requiresValid(r: unknown): boolean {
  if (!isObject(r)) return false
  const os = r.os
  if (!Array.isArray(os) || !os.length || os.some((o) => !OSES.includes(o as string)) || new Set(os).size !== os.length) return false
  if (r.windows !== undefined) {
    const w = r.windows
    if (!isObject(w) || !os.includes('windows')) return false
    if (w.editions !== undefined && (!Array.isArray(w.editions) || !w.editions.length || w.editions.some((e) => !EDITIONS.includes(e as string)))) return false
    if (w.minBuild !== undefined && !(Number.isInteger(w.minBuild) && (w.minBuild as number) > 0)) return false
    if (w.features !== undefined && (!Array.isArray(w.features) || w.features.some((f) => !isText(f)))) return false
  }
  if (r.node !== undefined && !(isText(r.node) && /^>=\s*\d+(\.\d+){0,2}$/.test(r.node))) return false
  if (r.docker !== undefined && typeof r.docker !== 'boolean') return false
  if (r.apps !== undefined && (!Array.isArray(r.apps) || r.apps.some((a) => !isText(a)))) return false
  return true
}

/**
 * Whether one server's entry is valid, as the mcp project's `validate()` checks it (only counted when it isn't: a
 * catalogue's reader skips it). `fileZips`: a file:// source's zips may be file:// too.
 */
function serverValid(s: unknown, fileZips: boolean): s is McpCatalogServer {
  if (!isObject(s)) return false
  if (typeof s.name !== 'string' || !NAME.test(s.name)) return false
  if (typeof s.version !== 'string' || !VERSION.test(s.version)) return false
  if (!isText(s.description) || s.description.length > MAX_DESCRIPTION) return false
  if (!Array.isArray(s.tags) || s.tags.some((t) => typeof t !== 'string' || !TAG.test(t)) || new Set(s.tags).size !== s.tags.length) return false
  if (!requiresValid(s.requires)) return false
  if (s.homepage !== undefined && !isHttps(s.homepage)) return false
  if (!isObject(s.zip)) return false
  if (!(isHttps(s.zip.url) || (fileZips && isFileUrl(s.zip.url)))) return false
  if (typeof s.zip.sha256 !== 'string' || !SHA256.test(s.zip.sha256)) return false
  return Number.isInteger(s.zip.size) && (s.zip.size as number) > 0
}

/** A catalogue as Hive uses it: its name and the servers that are valid; those that aren't are counted, not listed. */
export interface ReadCatalog {
  name: string
  homepage?: string
  servers: McpCatalogServer[]
  skipped: number
}

/**
 * A catalogue read from `url`, checked (schemaVersion 1; unknown fields ignored). Throws with what is wrong when the
 * catalogue as a whole can't be used (another schemaVersion, no name, no list of servers); a server that is invalid,
 * or named twice, is skipped and counted.
 */
export function readCatalog(raw: unknown, url: string): ReadCatalog {
  // Its own fields named as the format names them, in English (inside mcp.catalog.notRead's {reason}).
  if (!isObject(raw)) throw new Error('catalog: an object') // i18n-ignore: catalog.json's format, in its own terms
  if (raw.schemaVersion !== CATALOG_SCHEMA_VERSION) throw new Error(`schemaVersion: ${JSON.stringify(raw.schemaVersion)} (this Combwork reads ${CATALOG_SCHEMA_VERSION})`) // i18n-ignore: catalog.json's format, in its own terms
  if (!isText(raw.name)) throw new Error('name: one line') // i18n-ignore: catalog.json's format, in its own terms
  if (!Array.isArray(raw.servers)) throw new Error('servers: a list') // i18n-ignore: catalog.json's format, in its own terms
  const fileZips = isFileUrl(url)
  const names = new Set<string>()
  const servers: McpCatalogServer[] = []
  let skipped = 0
  raw.servers.forEach((s: unknown) => {
    if (!serverValid(s, fileZips) || names.has(s.name)) return void skipped++
    const v = s
    names.add(v.name)
    servers.push({ name: v.name, version: v.version, description: v.description, tags: [...v.tags], requires: v.requires, ...(v.homepage ? { homepage: v.homepage } : {}), zip: { url: v.zip.url, sha256: v.zip.sha256, size: v.zip.size } })
  })
  return { name: raw.name, ...(isHttps(raw.homepage) ? { homepage: raw.homepage } : {}), servers, skipped }
}

/** -1, 0 or 1: version a below, equal to or above b (x.y.z; anything else counts as 0.0.0). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] => (VERSION.test(v) ? v.split('.').map(Number) : [0, 0, 0])
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  return 0
}

/** What Hive found out about this PC for a catalogue's requirements; null where it couldn't (a probe failed or timed out). */
export interface PcFacts {
  os: 'windows' | 'macos' | 'linux' | 'other'
  /** Windows' edition as a catalogue names them (Home, Pro, Enterprise, Education), from its EditionID. */
  edition: string | null
  build: number | null
  /** The Windows optional features Hive can check without elevation: name → present. */
  features: Record<string, boolean>
  /** Node's version on PATH ("22.4.0"), '' when there is none. */
  node: string | null
  docker: boolean | null
}

/** Windows' EditionID (the registry's) as a catalogue's edition. */
export function editionOf(editionId: string): string | null {
  const id = editionId.trim().toLowerCase()
  // Catalogues' edition ids (EDITIONS), not words to show.
  if (id.startsWith('core')) return 'Home' // i18n-ignore: an edition id (EDITIONS)
  if (id.startsWith('professional')) return 'Pro' // i18n-ignore: an edition id (EDITIONS)
  if (id.startsWith('enterprise') || id.startsWith('iot')) return 'Enterprise' // i18n-ignore: an edition id (EDITIONS)
  if (id.startsWith('education')) return 'Education' // i18n-ignore: an edition id (EDITIONS)
  return null
}

/** One requirement's check, its words as `label` (the caller's, in the window's language), and whether it is met. */
export type CheckWords = (kind: McpCatalogCheck['kind'], value: string) => string

/**
 * Each of a server's requirements checked against this PC: met, not met, or not something Hive can check (a feature
 * it can't see without elevation, a probe that failed, an app to read about). `words` gives each its label.
 */
export function checkRequirements(r: McpCatalogRequires, pc: PcFacts, words: CheckWords): McpCatalogCheck[] {
  const out: McpCatalogCheck[] = []
  const add = (kind: McpCatalogCheck['kind'], value: string, state: McpCatalogCheck['state']): void => void out.push({ kind, label: words(kind, value), state })
  add('os', r.os.join(', '), r.os.includes(pc.os as string) ? 'ok' : 'no')
  const w = r.windows
  if (w && pc.os === 'windows') {
    if (w.editions) add('edition', w.editions.join(', '), pc.edition === null ? 'unknown' : w.editions.includes(pc.edition) ? 'ok' : 'no')
    if (w.minBuild) add('build', String(w.minBuild), pc.build === null ? 'unknown' : pc.build >= w.minBuild ? 'ok' : 'no')
    for (const f of w.features ?? []) add('feature', f, f in pc.features ? (pc.features[f] ? 'ok' : 'no') : 'unknown')
  }
  if (r.node) {
    const min = r.node.replace(/^>=\s*/, '')
    const want = [...min.split('.'), '0', '0'].slice(0, 3).join('.')
    add('node', min, pc.node === null ? 'unknown' : pc.node === '' ? 'no' : compareVersions(pc.node, want) >= 0 ? 'ok' : 'no')
  }
  if (r.docker) add('docker', '', pc.docker === null ? 'unknown' : pc.docker ? 'ok' : 'no')
  for (const a of r.apps ?? []) add('app', a, 'unknown')
  return out
}

/** Whether a row is shown for a search (every word in its name, description or tags) and a filter. */
export function catalogRowShown(row: Pick<McpCatalogServer, 'name' | 'description' | 'tags'> & { installed: string | null; update: boolean; checks: McpCatalogCheck[] }, query: string, filter: McpCatalogFilter): boolean {
  if (filter === 'installed' && !row.installed) return false
  if (filter === 'notInstalled' && row.installed) return false
  if (filter === 'updates' && !row.update) return false
  if (filter === 'meets' && row.checks.some((c) => c.state === 'no')) return false
  const text = [row.name, row.description, ...row.tags].join('\n').toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => text.includes(w))
}
