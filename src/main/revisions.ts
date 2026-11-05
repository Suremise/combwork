import { stat } from 'original-fs/promises'
import { resolve, sep } from 'path'
import { ContentTooLarge, contentHash, HASH_LIMITS, overBytes, readCapped, readStats, treeSignature } from './fsutil'
import { resourcesDir } from './paths'
import { currentWorkspace, workspaceFor, type WorkspaceService } from './workspace'
import { metricsHandle, recordSkills } from './metrics'

/**
 * The revisions (contentHash) of skills and modes, and their SKILL.md headers (headerOf), kept so a status poll doesn't read every file again: one
 * inventory per open workspace, and one for what ships with Combwork. A kept revision is used only while its path's
 * treeSignature (sizes, times, file ids; no file contents) is the one it was taken with, so an edit, a new file or a
 * restore is hashed again on the next call and a stale revision is never given. A workspace's inventory goes when it
 * closes, and hashing for it stops there (its lifetime signal); nothing is shared between workspaces.
 */

interface Kept {
  signature: string
  revision: string
  /** Over the byte limit (ContentTooLarge's reason): kept like a revision, so an unchanged too-big skill isn't read again. */
  tooLarge?: string
}

/**
 * How much each inventory keeps. Revisions: the workspace's skills (at most MAX_SKILL_FOLDERS, 1000) and modes,
 * with room to spare. Headers: those, plus the user's, plugin and projects' local skills Combwork lists, and a byte budget,
 * since a description can be long. Within them a repeated scan reads nothing; past them the least recently used entries
 * go one at a time, never all at once.
 */
export const RETENTION = { revisions: 4096, headers: 8192, headerBytes: 16 * 1024 * 1024 }

/**
 * Entries kept in the order they were last used: a hit moves an entry to the newest end, and a new one past the limits
 * (`max` entries, `maxBytes` by `weigh`) makes room by dropping the oldest, one at a time.
 */
class Retained<V> {
  private map = new Map<string, { value: V; weight: number }>()
  private bytes = 0
  constructor(
    private limits: () => { max: number; maxBytes?: number },
    private weigh: (v: V) => number = () => 0
  ) {}

  get size(): number {
    return this.map.size
  }

  get(key: string): V | undefined {
    const e = this.map.get(key)
    if (!e) return undefined
    this.map.delete(key)
    this.map.set(key, e)
    return e.value
  }

  set(key: string, value: V): void {
    const old = this.map.get(key)
    if (old) {
      this.bytes -= old.weight
      this.map.delete(key)
    }
    const weight = this.weigh(value)
    this.map.set(key, { value, weight })
    this.bytes += weight
    const { max, maxBytes = Infinity } = this.limits()
    for (const [k, e] of this.map) {
      if (this.map.size <= max && this.bytes <= maxBytes) break
      if (k === key) continue
      this.map.delete(k)
      this.bytes -= e.weight
    }
  }
}

/** A header's rough size in memory: its strings' lengths (two bytes a character). */
function headerWeight(h: { value: unknown }): number {
  const v = h.value as Record<string, unknown> | null
  if (!v || typeof v !== 'object') return 64
  return 64 + Object.values(v).reduce<number>((n, x) => n + (typeof x === 'string' ? x.length * 2 : 8), 0)
}

interface Inventory {
  signal?: AbortSignal
  /** Whose work it is, for metrics: the workspace; Combwork's shipped resources are the current workspace's to count. */
  owner: WorkspaceService | null
  kept: Retained<Kept>
  /** SKILL.md headers (headerOf), by path. */
  headers: Retained<{ signature: string; value: unknown }>
  /** Hashes running now, by path and signature: callers asking for the same one share it. */
  running: Map<string, Promise<string>>
}

const newInventory = (signal?: AbortSignal, owner: WorkspaceService | null = null): Inventory => ({
  signal,
  owner,
  kept: new Retained<Kept>(() => ({ max: RETENTION.revisions })),
  headers: new Retained<{ signature: string; value: unknown }>(() => ({ max: RETENTION.headers, maxBytes: RETENTION.headerBytes }), headerWeight),
  running: new Map()
})

const shipped: Inventory = newInventory()
const inventories = new WeakMap<WorkspaceService, Inventory>()

function inside(path: string, dir: string): boolean {
  const p = path.toLowerCase()
  const d = resolve(dir).toLowerCase()
  return p === d || p.startsWith(d + sep)
}

function inventoryFor(path: string): Inventory {
  if (inside(path, resourcesDir())) return shipped
  const w = workspaceFor(path) ?? currentWorkspace()
  let inv = inventories.get(w)
  if (!inv || inv.signal !== w.lifetime) {
    inv = newInventory(w.lifetime, w)
    inventories.set(w, inv)
  }
  return inv
}

/**
 * A skill's or mode's revision (contentHash), hashed again only when its signature has changed. Rejects like
 * contentHash: a missing path, ContentTooLarge, or the workspace closing.
 *
 * Too big is decided without reading where it can be: over the entry or depth limit, the signature's walk stops (a
 * bounded walk each time, no content); over the byte limit by its files' sizes, it is refused before reading, and kept
 * against the signature like a revision. A file that grows while it is read is still stopped by contentHash's own
 * limit on bytes read; that outcome is kept too if nothing changed meanwhile. Other errors (a file gone, the workspace
 * closing) are never kept.
 */
export async function revisionOf(path: string): Promise<string> {
  const abs = resolve(path)
  const inv = inventoryFor(abs)
  const key = process.platform === 'win32' ? abs.toLowerCase() : abs
  // Whose work this is, taken now: if that workspace closes meanwhile, nothing is recorded for it (or for the next).
  const owner = metricsHandle(inv.owner ?? currentWorkspace())
  const count = { files: 0, bytes: 0, entries: 0 }
  const { signature, bytes } = await treeSignature(abs, { signal: inv.signal, count })
  const had = inv.kept.get(key)
  if (had?.signature === signature) {
    recordSkills(owner, { hits: 1, entries: count.entries })
    if (had.tooLarge) throw new ContentTooLarge(had.tooLarge)
    return had.revision
  }
  recordSkills(owner, { misses: 1, entries: count.entries, ...(had ? { invalidations: 1 } : {}) })
  const keep = (k: Kept): void => {
    inv.kept.set(key, k)
  }
  if (bytes > HASH_LIMITS.bytes) {
    const reason = overBytes(HASH_LIMITS.bytes)
    keep({ signature, revision: '', tooLarge: reason })
    recordSkills(owner, { tooLarge: 1 })
    throw new ContentTooLarge(reason)
  }
  const job = `${key}\0${signature}`
  let run = inv.running.get(job)
  if (!run) {
    run = (async () => {
      // Changed while it was read: the outcome is of something in between, so it isn't kept.
      const unchanged = async (): Promise<boolean> => (await treeSignature(abs, { signal: inv.signal }).catch(() => null))?.signature === signature
      let revision: string
      const read = { files: 0, bytes: 0, entries: 0 }
      try {
        revision = await contentHash(abs, { signal: inv.signal, count: read })
      } catch (e) {
        if (e instanceof ContentTooLarge && (await unchanged())) keep({ signature, revision: '', tooLarge: e.message })
        if (e instanceof ContentTooLarge) recordSkills(owner, { tooLarge: 1 })
        throw e
      } finally {
        recordSkills(owner, read)
      }
      if (await unchanged()) keep({ signature, revision })
      return revision
    })().finally(() => inv.running.delete(job))
    inv.running.set(job, run)
  }
  return run
}

/** The most of a SKILL.md headerOf reads: its frontmatter is at the top, and the rest is for the model. */
export const SKILL_HEAD_MAX = 64 * 1024

/**
 * `parse` of the start of a file (at most SKILL_HEAD_MAX bytes; `truncated` when the file is longer), read again only once the file has changed (its size,
 * times or file id), kept like revisions. null if it isn't a file.
 */
export async function headerOf<T>(file: string, parse: (text: string, truncated: boolean) => T): Promise<T | null> {
  const abs = resolve(file)
  const inv = inventoryFor(abs)
  inv.signal?.throwIfAborted()
  const owner = metricsHandle(inv.owner ?? currentWorkspace())
  const st = await stat(abs, { bigint: true }).catch(() => null)
  if (!st?.isFile()) return null
  const key = process.platform === 'win32' ? abs.toLowerCase() : abs
  const signature = `${st.size}:${st.mtimeNs}:${st.ctimeNs}:${st.ino}`
  const had = inv.headers.get(key)
  if (had?.signature === signature) return had.value as T
  const { data, more } = await readCapped(abs, SKILL_HEAD_MAX)
  readStats.metaBytes += data.length
  recordSkills(owner, { headerBytes: data.length })
  const value = parse(data.toString('utf8'), more)
  inv.headers.set(key, { signature, value })
  return value
}

/**
 * Runs `scan` for each caller, sharing runs between callers: one asking while a run is going waits for the next run
 * (shared by everyone who asked meanwhile), so its answer is never from a scan that started before it asked.
 */
export function coalesced<T>(scan: () => Promise<T>, onShare?: () => void): () => Promise<T> {
  let current: Promise<T> | null = null
  let next: Promise<T> | null = null
  const start = (): Promise<T> => {
    const p = scan().finally(() => {
      if (current === p) current = null
    })
    current = p
    return p
  }
  return () => {
    if (!current) return start()
    onShare?.()
    next ??= current.then(
      () => undefined,
      () => undefined
    ).then(() => {
      next = null
      return current ?? start()
    })
    return next
  }
}
