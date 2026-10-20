// The None platform adapter (SPEC §16.3.3): no version control, not no workflow. A card's revision is a content hash of
// its declared paths, so any edit to them, or a change to the list, is a new revision; acceptance records an approved
// revision only if the paths still hash to it. Hashing is incremental: a cache of (path, size, time) → hash per
// project, which a write event invalidates even when size and time didn't change.
//
// P2 spike (#1118): not wired into the app yet.

import { createHash } from 'crypto'
import { readdirSync, readFileSync, statSync } from 'original-fs'
import { isAbsolute, join, relative, sep } from 'path'
import type { FileChange, Manifest } from '../../shared/workflow/facts'
import { isUnknown, unknown, type Maybe } from './types'

/** At most this many files or bytes per card; beyond, the revision is unknown and the option row says to narrow it. */
export const NONE_MAX_FILES = 20_000
export const NONE_MAX_BYTES = 2 * 1024 ** 3

const DELETED = 'deleted'

const toPosix = (p: string): string => p.split(sep).join('/')

export interface NoneRevision {
  revision: string
  manifest: Manifest
}

export class NoneAdapter {
  private cache = new Map<string, { size: number; mtimeMs: number; hash: string }>()

  constructor(
    readonly project: string,
    /** Names of folders left out of the deliverables (N4); `.hive` always is. */
    private excluded: string[] = []
  ) {}

  /** A watcher write event for a path: its cached hash goes, even if its size and time look unchanged. */
  invalidate(path: string): void {
    this.cache.delete(toPosix(path))
  }

  private skip(name: string): boolean {
    return name === '.hive' || name === '.git' || this.excluded.includes(name)
  }

  /** The deliverable files under a path of the project (a file, or a folder's files), relative and with `/`. */
  private files(rel: string, out: string[], limit: { n: number }): void {
    const abs = join(this.project, rel)
    let st
    try {
      st = statSync(abs)
    } catch {
      return
    }
    if (st.isFile()) {
      out.push(toPosix(rel))
      limit.n++
      return
    }
    if (!st.isDirectory()) return
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (limit.n > NONE_MAX_FILES) return
      if (this.skip(e.name)) continue
      this.files(rel ? join(rel, e.name) : e.name, out, limit)
    }
  }

  /** Every deliverable file of the project (N4). */
  deliverables(): Maybe<string[]> {
    const out: string[] = []
    const limit = { n: 0 }
    this.files('', out, limit)
    return limit.n > NONE_MAX_FILES ? unknown(`the deliverables of ${this.project} (over ${NONE_MAX_FILES} files)`) : out.sort()
  }

  private hashFile(rel: string): string {
    const abs = join(this.project, rel)
    let st
    try {
      st = statSync(abs)
    } catch {
      return DELETED
    }
    const hit = this.cache.get(rel)
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.hash
    const hash = createHash('sha256').update(readFileSync(abs)).digest('hex')
    this.cache.set(rel, { size: st.size, mtimeMs: st.mtimeMs, hash })
    return hash
  }

  /** A declared path stays inside the project: no `..` out of it, no absolute path, no `.hive`. */
  static inside(p: string): boolean {
    const posix = toPosix(p)
    return !!posix && !isAbsolute(p) && !posix.split('/').some((part) => part === '..' || part === '.hive')
  }

  /** The manifest of some paths: each file under them with its content hash; a declared path that's gone is "deleted". */
  manifest(paths: string[]): Maybe<Manifest> {
    const out: Manifest = {}
    const limit = { n: 0 }
    let bytes = 0
    const outside = paths.find((p) => !NoneAdapter.inside(p))
    if (outside !== undefined) return unknown(`the path ${outside}, outside the project`)
    for (const p of [...new Set(paths.map(toPosix))].sort()) {
      const found: string[] = []
      this.files(p, found, limit)
      if (limit.n > NONE_MAX_FILES) return unknown(`the card's paths (over ${NONE_MAX_FILES} files)`)
      if (!found.length) out[p] = DELETED
      for (const f of found) {
        try {
          bytes += statSync(join(this.project, f)).size
        } catch {
          // Gone meanwhile: hashed as deleted below.
        }
        if (bytes > NONE_MAX_BYTES) return unknown(`the card's paths (over 2 GB)`)
        out[f] = this.hashFile(f)
      }
    }
    return out
  }

  /**
   * The revision of a card's paths (§16.3.3): SHA-256 over the sorted (path, hash or "deleted") list together with the
   * path list itself, so changing the list is a new revision too. Computable at any time.
   */
  revision(paths: string[]): Maybe<NoneRevision> {
    const m = this.manifest(paths)
    if (isUnknown(m)) return m
    const list = [...new Set(paths.map(toPosix))].sort()
    const body = JSON.stringify({ paths: list, files: Object.keys(m).sort().map((k) => [k, m[k]]) })
    return { revision: createHash('sha256').update(body).digest('hex'), manifest: m }
  }

  /** The files that differ between two manifests (A / M / D), for a submission's files. */
  static diff(before: Manifest, after: Manifest): FileChange[] {
    const out: FileChange[] = []
    for (const p of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const a = before[p]
      const b = after[p]
      if (a === b) continue
      out.push({ path: p, status: !a || a === DELETED ? 'A' : !b || b === DELETED ? 'D' : 'M' })
    }
    return out.sort((x, y) => (x.path < y.path ? -1 : 1))
  }

  /** Whether a project-relative path is in the deliverables (no part of it is `.hive`, `.git` or an excluded folder). */
  isDeliverable(rel: string): boolean {
    const parts = toPosix(rel).split('/').filter(Boolean)
    return parts.length > 0 && !parts.some((part) => this.skip(part))
  }

  /** A path relative to the project, with `/`. */
  rel(abs: string): string {
    return toPosix(relative(this.project, abs))
  }
}
