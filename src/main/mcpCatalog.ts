/**
 * MCP catalogues (HI-545): servers from catalog.json sources (ours first, then the user's), listed in the MCP view,
 * installed and updated only when the user asks. A catalogue is read only when the view opens or on refresh, never in
 * the background; downloads keep to their source's scheme at every redirect and to one time and size budget; a zip is
 * used only if its size and sha256 match its catalogue. Install is #550's Add (added nowhere, HI-2059); Update keeps
 * the places it is added only while they are the ones the user was shown (HI-545/s17).
 */
import { createHash, randomUUID } from 'crypto'
import { execFile } from 'child_process'
import { fileURLToPath } from 'url'
import { join } from 'path'
import { existsSync } from 'original-fs'
import { readFile, stat } from 'original-fs/promises'
import { msg } from '../shared/i18n/msg'
import { tr } from '../shared/i18n'
import { OUR_CATALOG_URL, OUR_OLD_CATALOG_URLS, catalogRowShown, isOurCatalogUrl, sameCatalogSource, catalogUrlAllowed, checkRequirements, compareVersions, editionOf, readCatalog, type PcFacts, type ReadCatalog } from '../shared/mcpCatalog'
import type { McpCatalogCheck, McpCatalogFilter, McpCatalogPrepared, McpCatalogRow, McpCatalogServer, McpCatalogSettings, McpCatalogSourcePage, McpServerDef, McpShown } from '../shared/types'
import { advanced } from './advanced'
import { config } from './config'
import { hiveError } from './hiveError'
import { findSecretWarnings } from './mcpSecrets'
import { checkShown, inTurn, listMcp, mcpRuns, placesNow, retarget, serverFromZip, validMcpName, writeServerNow } from './mcp'
import { createLogger, userText } from './logger'
import { currentWorkspace, inWorkspace, type WorkspaceService } from './workspace'

const log = createLogger('mcpCatalog')

/** Bounds (HI-545/s17): a catalogue's JSON, its servers, the cache, a zip, and the redirects one download may follow. */
const CATALOG_MAX_BYTES = 8 * 1024 * 1024
const CATALOG_MAX_SERVERS = 5000
/** The user's own sources at most (ours besides): the cache holds every source listed, so none is evicted by count. */
export const MAX_USER_SOURCES = 15
const CACHE_MAX_SOURCES = MAX_USER_SOURCES + 1
const CACHE_MAX_BYTES = 32 * 1024 * 1024
const ZIP_MAX_BYTES = 200 * 1024 * 1024
const MAX_REDIRECTS = 5
/** A page of a source's rows. */
export const CATALOG_PAGE = 50
/** Downloads held for the user's Install or Update, and for how long. */
const PREPARED_MAX = 4
const PREPARED_MS = 10 * 60 * 1000

export const FETCH_SECONDS = 'hive.mcpCatalog.fetchSeconds'
export const DOWNLOAD_SECONDS = 'hive.mcpCatalog.downloadSeconds'
export const PROBE_SECONDS = 'hive.mcpCatalog.probeSeconds'
const seconds = (id: string, fallback: number): number => {
  const v = advanced.get(id)
  return typeof v === 'number' && v > 0 ? v : fallback
}

const M = {
  notRead: msg({ id: 'mcp.catalog.notRead', defaultMessage: "Couldn't read this catalogue: {reason}", description: 'An MCP catalogue source in the MCP view (HI-545) that could not be read or is not a catalogue Hive reads. {reason} says why (as the network, the file or the checker said it, in English).' }),
  scheme: msg({ id: 'mcp.catalog.scheme', defaultMessage: '{url} leads to an address this source may not use (only https for an https catalogue).', description: 'An error downloading from an MCP catalogue (HI-545): a redirect led away from https (to http or a file). {url} is where it led.' }),
  redirects: msg({ id: 'mcp.catalog.redirects', defaultMessage: 'Too many redirects downloading {url}.', description: 'An error downloading from an MCP catalogue (HI-545): more than 5 redirects. {url} is the address asked for.' }),
  tooLarge: msg({ id: 'mcp.catalog.tooLarge', defaultMessage: '{url} is larger than its catalogue says ({max, number} bytes at most): not used.', description: 'An error downloading from an MCP catalogue (HI-545): the download went past the size its catalogue gives, or the limit. {url} is the address.' }),
  http: msg({ id: 'mcp.catalog.http', defaultMessage: '{url} answered {status}.', description: 'An error downloading from an MCP catalogue (HI-545): the server answered with an HTTP error {status} (a number such as 404).' }),
  timeout: msg({ id: 'mcp.catalog.timeout', defaultMessage: '{url} took too long (over {seconds, number} s).', description: 'An error downloading from an MCP catalogue (HI-545): no complete answer within the time limit (Settings → Advanced).' }),
  mismatch: msg({ id: 'mcp.catalog.mismatch', defaultMessage: "{name}'s download doesn't match its catalogue (its size or checksum differ): not installed.", description: 'An error installing a server from an MCP catalogue (HI-545): the zip downloaded is not the one the catalogue describes, so Hive used none of it. {name} is the server.' }),
  folder: msg({ id: 'mcp.catalog.folder', defaultMessage: "{name}'s zip doesn't hold a folder named {name}: not installed.", description: 'An error installing a server from an MCP catalogue (HI-545): the zip is not laid out as catalogues require (one top folder named after the server).' }),
  gone: msg({ id: 'mcp.catalog.gone', defaultMessage: "{name} isn't in its catalogue any more: refresh the list.", description: 'An error installing or updating a server from an MCP catalogue (HI-545): the catalogue read last no longer lists it.' }),
  needs: msg({ id: 'mcp.catalog.needs', defaultMessage: "{name} can't run on this PC: {needs}.", description: 'An error installing a server from an MCP catalogue (HI-545): a requirement Hive checked is not met. {needs} lists them.' }),
  expired: msg({ id: 'mcp.catalog.expired', defaultMessage: 'That download has expired: choose Install or Update again.', description: 'An error installing or updating a server from an MCP catalogue (HI-545): the download made for it was dropped (too old, or the window closed).' }),
  workspaceGone: msg({ id: 'mcp.catalog.workspaceGone', defaultMessage: 'The workspace closed before {name} was installed: nothing was written.', description: 'An error installing or updating a server from an MCP catalogue (HI-545): the workspace it was for closed while it downloaded.' }),
  placesChanged: msg({ id: 'mcp.catalog.placesChanged', defaultMessage: 'Where {name} is added changed while the update waited: look again.', description: "An error updating a server from an MCP catalogue (HI-545): a project (or the Hive Assistant) gained or lost the server after the Update dialog showed where it is added, so nothing was changed." }),
  notInstalled: msg({ id: 'mcp.catalog.notInstalled', defaultMessage: "{name} isn't installed from this catalogue: install it instead.", description: 'An error updating a server from an MCP catalogue (HI-545): no server of the name came from it.' }),
  sourceUrl: msg({ id: 'mcp.catalog.sourceUrl', defaultMessage: 'A catalogue is an https:// or file:// address of its catalog.json.', description: 'An error adding an MCP catalogue source (Settings → MCP Catalogues, HI-545): the address is neither.' }),
  tooManySources: msg({ id: 'mcp.catalog.tooManySources', defaultMessage: 'Combwork lists at most {max, number} catalogues of your own: remove one first.', description: 'An error adding an MCP catalogue source (Settings → MCP Catalogues, HI-545): the list is full.' }),
  refreshAgain: msg({ id: 'mcp.catalog.refreshAgain', defaultMessage: 'Refresh (↻) to list this catalogue again: Combwork keeps only so many in memory.', description: "A catalogue source in the MCP view's Catalogue (HI-545) whose list Hive no longer holds (too much in memory): ↻ reads it again." }),
  sourceTaken: msg({ id: 'mcp.catalog.sourceTaken', defaultMessage: 'That catalogue is listed already.', description: 'An error adding an MCP catalogue source (HI-545): it is in the list already.' }),
  check: {
    os: msg({ id: 'mcp.catalog.check.os', defaultMessage: 'Runs on {value}', description: "A requirement of a catalogue server (HI-545): the systems it runs on ({value}: windows, macos, linux, as the catalogue names them)." }),
    edition: msg({ id: 'mcp.catalog.check.edition', defaultMessage: 'Windows {value}', description: 'A requirement of a catalogue server (HI-545): the Windows editions it needs ({value}: Pro, Enterprise…).' }),
    build: msg({ id: 'mcp.catalog.check.build', defaultMessage: 'Windows build {value} or later', description: 'A requirement of a catalogue server (HI-545): the lowest Windows build ({value}, a number).' }),
    feature: msg({ id: 'mcp.catalog.check.feature', defaultMessage: '{value} turned on', description: 'A requirement of a catalogue server (HI-545): a Windows optional feature ({value}, its name as Windows gives it, e.g. Windows Sandbox) that must be turned on.' }),
    node: msg({ id: 'mcp.catalog.check.node', defaultMessage: 'Node.js {value} or later', description: 'A requirement of a catalogue server (HI-545): the lowest Node.js version on PATH ({value}).' }),
    docker: msg({ id: 'mcp.catalog.check.docker', defaultMessage: 'Docker', description: 'A requirement of a catalogue server (HI-545): Docker installed.' }),
    app: msg({ id: 'mcp.catalog.check.app', defaultMessage: '{value}', description: 'A requirement of a catalogue server (HI-545) given in the catalogue\'s own words ({value}, as it is): Hive can\'t check it.' })
  }
}

/** The sources as settings have them: ours first (unless turned off), then the user's that are on. */
export function catalogSources(): { url: string; ours: boolean; noted: boolean }[] {
  const s: McpCatalogSettings = config.settings.mcpCatalogs ?? { oursOn: true, sources: [] }
  return [...(s.oursOn ? [{ url: OUR_CATALOG_URL, ours: true, noted: true }] : []), ...s.sources.filter((x) => x.on && !isOurCatalogUrl(x.url)).map((x) => ({ url: x.url, ours: false, noted: !!x.noted }))]
}

/** The sources changed in Settings (HI-545): ours on or off, and the user's own (added, turned on or off, removed, reordered). */
export function setCatalogSources(next: McpCatalogSettings): McpCatalogSettings {
  const seen = new Set<string>([OUR_CATALOG_URL, ...OUR_OLD_CATALOG_URLS])
  const sources: McpCatalogSettings['sources'] = []
  const was = config.settings.mcpCatalogs?.sources ?? []
  for (const x of Array.isArray(next?.sources) ? next.sources : []) {
    const url = typeof x?.url === 'string' ? x.url.trim() : ''
    if (!catalogUrlAllowed(url)) throw hiveError(M.sourceUrl, undefined, { kind: 'invalid' })
    if (seen.has(url)) throw hiveError(M.sourceTaken, undefined, { kind: 'conflict' })
    seen.add(url)
    sources.push({ url, on: x.on !== false, ...(x.noted || was.find((w) => w.url === url)?.noted ? { noted: true } : {}) })
  }
  if (sources.length > MAX_USER_SOURCES) throw hiveError(M.tooManySources, { max: MAX_USER_SOURCES }, { kind: 'conflict' })
  const saved = { oursOn: next?.oursOn !== false, sources }
  config.update((c) => {
    c.settings.mcpCatalogs = saved
  })
  // Gone or off: forgotten (the cache only ever holds what is listed).
  for (const url of [...cache.keys()]) if (!catalogSources().some((s) => s.url === url)) cache.delete(url)
  return saved
}

/** The one-time note for a source Hive doesn't check (14 Oct): said, so not again. */
export function noteCatalogSource(url: string): void {
  config.update((c) => {
    const s = c.settings.mcpCatalogs?.sources.find((x) => x.url === url)
    if (s) s.noted = true
  })
}

// ---------------------------------------------------------------------------
// Downloads: one time and size budget, the source's scheme at every hop.
// ---------------------------------------------------------------------------

/** Who may download what: an https source only https, at every redirect; a file:// source also file:// (HI-545 Q2). */
type Policy = 'https' | 'file'
const policyOf = (sourceUrl: string): Policy => (/^file:/i.test(sourceUrl) ? 'file' : 'https')

/** For tests: what fetch and the PC probes are. */
export const testHooks: { fetch?: typeof fetch; probe?: (cmd: string, args: string[]) => Promise<string>; facts?: PcFacts; stat?: (path: string) => Promise<{ size: number }> } = {}

/**
 * Bytes from `url` within one budget: `ms` for the whole download, every redirect included, and `max` bytes, counted
 * as they come. Each hop's address must be allowed by the policy (https; a file:// one only for a file:// source).
 * `etag`: a 304 answers null (the cache is up to date). `signal` ends it early (the workspace closed).
 */
export async function download(url: string, policy: Policy, max: number, ms: number, signal?: AbortSignal, etag?: string): Promise<{ bytes: Buffer; etag?: string } | null> {
  const timeout = AbortSignal.timeout(ms)
  const stop = signal ? AbortSignal.any([signal, timeout]) : timeout
  const timedOut = (): Error => hiveError(M.timeout, { url, seconds: Math.round(ms / 1000) })
  if (/^file:/i.test(url)) {
    if (policy !== 'file') throw hiveError(M.scheme, { url })
    // The same budget and the same end as a download: a share that stalls, or a workspace closed, stops it.
    const ended = (): Error => (timeout.aborted ? timedOut() : (signal?.reason instanceof Error ? signal.reason : new Error('aborted'))) // i18n-ignore: an abort's cause, for the log
    if (stop.aborted) throw ended()
    const path = fileURLToPath(url)
    const size = await Promise.race([(testHooks.stat ?? stat)(path).then((s) => s.size), new Promise<never>((_, reject) => stop.addEventListener('abort', () => reject(ended()), { once: true }))])
    if (size > max) throw hiveError(M.tooLarge, { url, max })
    const bytes = await readFile(path, { signal: stop }).catch((e) => {
      throw stop.aborted ? ended() : e
    })
    if (bytes.length > max) throw hiveError(M.tooLarge, { url, max })
    return { bytes }
  }
  let at = url
  for (let hop = 0; ; hop++) {
    if (!/^https:\/\//i.test(at)) throw hiveError(M.scheme, { url: at })
    if (hop > MAX_REDIRECTS) throw hiveError(M.redirects, { url })
    let res: Response
    try {
      res = await (testHooks.fetch ?? fetch)(at, { redirect: 'manual', signal: stop, headers: etag && hop === 0 ? { 'If-None-Match': etag } : {} })
    } catch (e) {
      if (timeout.aborted) throw timedOut()
      throw e
    }
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      const next = res.headers.get('location')
      await res.body?.cancel().catch(() => undefined)
      if (!next) throw hiveError(M.http, { url: at, status: res.status })
      at = new URL(next, at).href
      continue
    }
    if (res.status === 304) return null
    if (!res.ok) throw hiveError(M.http, { url: at, status: res.status })
    const declared = Number(res.headers.get('content-length') ?? 0)
    if (declared > max) throw hiveError(M.tooLarge, { url, max })
    const chunks: Buffer[] = []
    let got = 0
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        got += chunk.length
        if (got > max) throw hiveError(M.tooLarge, { url, max })
        chunks.push(Buffer.from(chunk))
      }
    } catch (e) {
      if (timeout.aborted) throw timedOut()
      throw e
    }
    return { bytes: Buffer.concat(chunks), etag: res.headers.get('etag') ?? undefined }
  }
}

// ---------------------------------------------------------------------------
// The catalogues read, in memory: at most 8 sources and 16 MB, least recently used out first.
// ---------------------------------------------------------------------------

interface Cached {
  etag?: string
  size: number
  catalog: ReadCatalog | null
  error?: string
}
const cache = new Map<string, Cached>()

function keep(url: string, c: Cached): void {
  cache.delete(url)
  cache.set(url, c)
  let total = [...cache.values()].reduce((n, x) => n + x.size, 0)
  for (const k of cache.keys()) {
    if (cache.size <= CACHE_MAX_SOURCES && total <= CACHE_MAX_BYTES) break
    total -= cache.get(k)!.size
    cache.delete(k)
  }
}

/** For tests: how much the cache holds. */
export const cacheSize = (): { sources: number; bytes: number } => ({ sources: cache.size, bytes: [...cache.values()].reduce((n, x) => n + x.size, 0) })

/**
 * A source read again (its ETag first: unchanged, the cached copy stands), or its error kept to show. Returns what it
 * read, which the reply uses whatever the cache keeps.
 */
async function refreshSource(url: string): Promise<Cached> {
  const was = cache.get(url)
  let read: Cached
  try {
    const got = await download(url, policyOf(url), CATALOG_MAX_BYTES, seconds(FETCH_SECONDS, 15) * 1000, undefined, was?.catalog ? was.etag : undefined)
    if (!got) read = was!
    else {
      const catalog = readCatalog(JSON.parse(got.bytes.toString('utf8')) as unknown, url)
      if (catalog.servers.length > CATALOG_MAX_SERVERS) {
        catalog.skipped += catalog.servers.length - CATALOG_MAX_SERVERS
        catalog.servers = catalog.servers.slice(0, CATALOG_MAX_SERVERS)
      }
      read = { etag: got.etag, size: got.bytes.length, catalog }
    }
  } catch (e) {
    log.warn(`reading the MCP catalogue ${userText(url)}`, e)
    read = { size: 0, catalog: null, error: tr(M.notRead, { reason: e instanceof Error ? e.message : String(e) }) }
  }
  keep(url, read)
  return read
}

// ---------------------------------------------------------------------------
// This PC, for the requirements: probed once per refresh, each probe bounded.
// ---------------------------------------------------------------------------

let facts: Promise<PcFacts> | null = null

function probe(cmd: string, args: string[]): Promise<string> {
  if (testHooks.probe) return testHooks.probe(cmd, args)
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: seconds(PROBE_SECONDS, 5) * 1000, windowsHide: true }, (e, out) => (e ? reject(e) : resolve(String(out))))
  })
}

async function probeFacts(): Promise<PcFacts> {
  if (testHooks.facts) return testHooks.facts
  const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : 'other'
  const reg = (name: string): Promise<string | null> =>
    probe('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion', '/v', name]).then( // i18n-ignore: a registry key, reg.exe's arguments
      (out) => /REG_\w+\s+(.+)$/m.exec(out)?.[1]?.trim() ?? null,
      () => null
    )
  const [editionId, build, node, docker] = await Promise.all([
    os === 'windows' ? reg('EditionID') : Promise.resolve(null),
    os === 'windows' ? reg('CurrentBuildNumber') : Promise.resolve(null),
    probe('node', ['--version']).then(
      (out) => out.trim().replace(/^v/, ''),
      (e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? '' : null)
    ),
    probe('docker', ['--version']).then(
      () => true,
      (e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? false : null)
    )
  ])
  // The features Hive can check without elevation: Windows Sandbox, by its program.
  const features: Record<string, boolean> = os === 'windows' ? { 'Windows Sandbox': existsSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsSandbox.exe')) } : {}
  return { os, edition: editionId ? editionOf(editionId) : null, build: build && /^\d+$/.test(build) ? Number(build) : null, features, node, docker }
}

const checksOf = (server: McpCatalogServer, pc: PcFacts): McpCatalogCheck[] => checkRequirements(server.requires, pc, (kind, value) => tr(M.check[kind], { value }))

// ---------------------------------------------------------------------------
// The view: pages of each source's rows, for a search and a filter.
// ---------------------------------------------------------------------------

/** An installed server from this catalogue entry (its provenance, whatever name it was installed under; ours by any of its addresses, HI-2472). */
const fromEntry = (def: McpServerDef | null | undefined, source: string, name: string): boolean => !!def?.catalog && typeof def.catalog.source === 'string' && sameCatalogSource(def.catalog.source, source) && def.catalog.name === name && typeof def.catalog.version === 'string'

/**
 * Whether a catalogue entry is installed: its version (found by provenance, under any name), `other` when its name is
 * taken by a server not from it, else null.
 */
function installedAs(installed: { name: string; def: McpServerDef | null }[], source: string, server: McpCatalogServer): string | null {
  const mine = installed.find((m) => fromEntry(m.def, source, server.name))
  if (mine) return mine.def!.catalog!.version
  return installed.some((m) => m.name === server.name) ? 'other' : null
}

/**
 * Each listed source's page for the MCP view (HI-545): `refresh` reads the catalogues and this PC again (only on the
 * view's opening and ↻), otherwise the copies read last serve the search, the filter and the next page. `source`: one
 * source's next page (`offset`), the others empty.
 */
export async function catalogPages(opts: { query?: string; filter?: McpCatalogFilter; source?: string; offset?: number; refresh?: boolean }): Promise<McpCatalogSourcePage[]> {
  const sources = catalogSources().filter((s) => !opts.source || s.url === opts.source)
  if (opts.refresh || !facts) facts = probeFacts()
  // Read only on refresh (the view opening, ↻); this reply uses what it read, whatever the cache keeps afterwards. A
  // search or a next page uses the copies kept; one no longer kept says to refresh, never read outside that cadence.
  const fresh = new Map<string, Cached>()
  if (opts.refresh) await Promise.all(sources.map(async (s) => fresh.set(s.url, await refreshSource(s.url))))
  const pc = await facts
  const installed = (await listMcp()).map((m) => ({ name: m.name, def: m.def }))
  return sources.map((s) => {
      const c = fresh.get(s.url) ?? cache.get(s.url)
      const base = { url: s.url, ours: s.ours, noteDue: !s.ours && !s.noted, offset: 0, total: 0, skipped: 0, rows: [] as McpCatalogRow[] }
      if (!c) return { ...base, name: s.url, error: tr(M.refreshAgain) }
      if (!c.catalog) return { ...base, name: s.url, ...(c.error ? { error: c.error } : {}) }
      const rows: McpCatalogRow[] = c.catalog.servers.map((server) => {
        const at = installedAs(installed, s.url, server)
        return { ...server, source: s.url, installed: at, update: !!at && at !== 'other' && compareVersions(server.version, at) > 0, checks: checksOf(server, pc) }
      })
      const shown = rows.filter((r) => catalogRowShown(r, opts.query ?? '', opts.filter ?? 'all'))
      const offset = opts.source === s.url ? Math.max(0, opts.offset ?? 0) : 0
      return { ...base, name: c.catalog.name, skipped: c.catalog.skipped, total: shown.length, offset, rows: shown.slice(offset, offset + CATALOG_PAGE) }
    })
}

// ---------------------------------------------------------------------------
// Install and Update: downloaded and checked first, held for the user's choice, written only for its workspace.
// ---------------------------------------------------------------------------

interface Held {
  prepared: McpCatalogPrepared
  files: Map<string, Uint8Array>
  ws: WorkspaceService
  /** The lifetime of the workspace's open that asked (not the service's current one: a reopen gives it a new one). */
  life: AbortSignal
  path: string
  at: number
}
const held = new Map<string, Held>()

/** The catalogue server read last, by source and name, or an error saying to refresh. */
function listed(source: string, name: string): McpCatalogServer {
  const server = cache.get(source)?.catalog?.servers.find((x) => x.name === name)
  if (!server || !catalogSources().some((s) => s.url === source)) throw hiveError(M.gone, { name }, { kind: 'notFound' })
  return server
}

/**
 * Downloads a catalogue server and checks it (its size and sha256 against the catalogue, its zip as #550 unpacks one,
 * one top folder named after it), for the Install or Update dialog to show what it would run. Refused before any
 * download when this PC doesn't meet a requirement Hive checked. Bound to the workspace that asked: held until the user
 * answers, at most 10 minutes, a few at a time.
 */
export async function prepareCatalogServer(source: string, name: string): Promise<McpCatalogPrepared> {
  // The open that asked, before any await: a close, or a close and reopen of the same folder, ends what it started.
  const ws = currentWorkspace()
  const path = ws.path
  const life = ws.lifetime
  if (!path || life.aborted) throw hiveError(M.workspaceGone, { name })
  // Read once if it isn't yet (the view reads it first; Install from elsewhere may not have).
  if (!cache.has(source) && catalogSources().some((s) => s.url === source)) await refreshSource(source)
  const server = listed(source, name)
  const unmet = checksOf(server, await (facts ?? (facts = probeFacts()))).filter((c) => c.state === 'no')
  if (unmet.length) throw hiveError(M.needs, { name, needs: { list: unmet.map((c) => c.label), type: 'conjunction' } }, { kind: 'conflict' })
  const got = await download(server.zip.url, policyOf(source), Math.min(server.zip.size, ZIP_MAX_BYTES), seconds(DOWNLOAD_SECONDS, 60) * 1000, life)
  if (life.aborted) throw hiveError(M.workspaceGone, { name })
  const bytes = got!.bytes
  if (bytes.length !== server.zip.size || createHash('sha256').update(bytes).digest('hex') !== server.zip.sha256) throw hiveError(M.mismatch, { name })
  const z = serverFromZip(bytes)
  if (z.folder !== name) throw hiveError(M.folder, { name })
  const def: McpServerDef = { ...retarget(z.def, z.folder, name), catalog: { source, name, version: server.version, sha256: server.zip.sha256 } }
  // Installed from this entry already (under any name: an update's), and whether its own name is taken.
  const { existing, nameTaken } = await inWorkspace(ws, async () => {
    const all = await listMcp(true)
    const m = all.find((x) => fromEntry(x.def, source, name))
    return { existing: m ? { name: m.name, version: m.def!.catalog!.version, def: m.def, revision: m.revision, runs: m.runs, projects: m.projects, assistant: m.assistant } : null, nameTaken: all.some((x) => x.name === name) }
  })
  if (life.aborted) throw hiveError(M.workspaceGone, { name })
  // An update of one installed under another name: shown, and written, under that name's folder.
  const shown = existing && existing.name !== name ? retarget(def, name, existing.name) : def
  const prepared: McpCatalogPrepared = { id: randomUUID(), source, server, def: shown, runs: mcpRuns(shown), secretWarnings: findSecretWarnings(shown), files: z.files.size, existing, nameTaken }
  const now = Date.now()
  for (const [k, h] of held) if (now - h.at > PREPARED_MS || h.life.aborted) held.delete(k)
  while (held.size >= PREPARED_MAX) held.delete(held.keys().next().value!)
  held.set(prepared.id, { prepared, files: z.files, ws, life, path, at: now })
  return prepared
}

/** A download held for this workspace, still open at the same path; else an error, and it is dropped. */
function heldFor(id: string): Held {
  const h = held.get(id)
  if (!h || Date.now() - h.at > PREPARED_MS) {
    held.delete(id)
    throw hiveError(M.expired, undefined, { kind: 'conflict' })
  }
  if (h.life.aborted || h.ws.lifetime !== h.life || h.ws.path !== h.path) {
    held.delete(id)
    throw hiveError(M.workspaceGone, { name: h.prepared.server.name }, { kind: 'conflict' })
  }
  return h
}

/** Drops a download the user didn't use (they cancelled). */
export function dropPrepared(id: string): void {
  held.delete(id)
}

/**
 * Installs a downloaded catalogue server as `name` (#550's Add: added nowhere, HI-2059), for the workspace that asked,
 * still open; `replace`: over a server of the name (refused as Replace is while a project can't be read).
 */
export async function installCatalogServer(id: string, name: string, replace: boolean): Promise<void> {
  const h = heldFor(id)
  if (!validMcpName(name)) throw hiveError(msg({ id: 'mcp.catalog.badName', defaultMessage: 'Server names may contain letters, numbers, "-" and "_" (max 64 characters). "hive" is reserved.', description: 'An error installing a catalogue server (HI-545) under a name a server can\'t have.' }), undefined, { kind: 'invalid' })
  const p = h.prepared
  const def = name === p.server.name ? p.def : { ...retarget(p.def, p.server.name, name) }
  await inTurn(() =>
    inWorkspace(h.ws, async () => {
      heldFor(id)
      await writeServerNow(name, def, h.files, replace)
    })
  )
  held.delete(id)
  log.info(`installed ${userText(name)} ${p.server.version} from the MCP catalogue ${userText(p.source)}`)
}

/** The user's values kept over an update's definition (HI-545 Q3): env and headers, for the keys it still has. */
function keepOwnValues(next: McpServerDef, was: McpServerDef | null): McpServerDef {
  if (!was) return next
  const out: McpServerDef = { ...next }
  for (const k of ['env', 'headers'] as const) {
    const n = next[k]
    const o = was[k]
    if (!n || !o || typeof o !== 'object') continue
    out[k] = Object.fromEntries(Object.entries(n).map(([key, v]) => [key, typeof o[key] === 'string' ? o[key] : v]))
  }
  return out
}

/**
 * Updates an installed catalogue server to the downloaded version (HI-545/s17). In the MCP turn, for the workspace that
 * asked, still open: the installed definition must still be the one shown (`shown`), and the places it is added, read
 * strictly now, exactly those shown (`places`); either changed refuses it, so no place loses or gains it from a stale
 * snapshot. Then the new definition (the user's env and header values kept) replaces the old where it is, its places
 * keeping it. A stale dialog (the definition or the places changed) answers `stale` with why, for the window to show
 * the Update dialog again from what is there now; nothing is written then.
 */
export async function updateCatalogServer(id: string, shown: McpShown, places: { projects: string[]; assistant: boolean }): Promise<{ stale?: string }> {
  const h = heldFor(id)
  const p = h.prepared
  // The name it was installed under (the user may have chosen another), found by its provenance.
  const name = p.existing?.name ?? p.server.name
  const stale = await inTurn(() =>
    inWorkspace(h.ws, async () => {
      heldFor(id)
      const now = (await listMcp()).find((m) => m.name === name)
      if (!now || !fromEntry(now.def, p.source, p.server.name)) throw hiveError(M.notInstalled, { name }, { kind: 'conflict' })
      try {
        await checkShown(name, shown)
      } catch (e) {
        return e instanceof Error ? e.message : String(e)
      }
      // Read strictly (a project that can't be read refuses it, HI-2059), and compared with what was shown.
      const where = await placesNow(name)
      const want = [...places.projects].map((x) => x.toLowerCase()).sort()
      if (JSON.stringify(where.projects.map((x) => x.toLowerCase())) !== JSON.stringify(want) || where.assistant !== places.assistant) return tr(M.placesChanged, { name })
      await writeServerNow(name, keepOwnValues(p.def, now.def), h.files, true, true)
      return null
    })
  )
  held.delete(id)
  if (stale) return { stale }
  log.info(`updated ${userText(name)} to ${p.server.version} from the MCP catalogue ${userText(p.source)}`)
  return {}
}

