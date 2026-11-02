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
import { UNREADABLE } from '../../shared/workflow/texts'
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
    private excluded: string[] = [],
    /**
     * Whether names match whatever their case, as the file system resolves them (Windows: `NODE_MODULES` is
     * `node_modules`, #1511 round 1): what is left out is matched so everywhere, a declared path, a folder's walk, a stored
     * path and N4's writes.
     */
    private readonly anyCase = process.platform === 'win32'
  ) {}

  /** The folders left out changed (the project's options, #1263): what is hashed follows from the next read. */
  setExcluded(excluded: string[]): void {
    if (JSON.stringify(excluded) === JSON.stringify(this.excluded)) return
    this.excluded = [...excluded]
    this.cache.clear()
  }

  /** Every cached hash goes (writes may have been missed: the watcher's record isn't complete), each path read again. */
  forget(): void {
    this.cache.clear()
  }

  /** A watcher write event for a path: its cached hash goes, even if its size and time look unchanged. */
  invalidate(path: string): void {
    this.cache.delete(toPosix(path))
  }

  private skip(name: string): boolean {
    const fold = (s: string): string => (this.anyCase ? s.toLowerCase() : s)
    const n = fold(name)
    return n === '.hive' || n === '.git' || this.excluded.some((x) => fold(x) === n)
  }

  /**
   * Whether declared paths cover a file (HI-2339): it is one of them, or under one (a folder's files), as the file system
   * names them (`/` or `\`, `./`, a trailing `/`; on Windows any case). A sibling sharing a prefix (`src-other` beside
   * `src`) isn't under it. The project's root (`.`, `./`, `.\`: a valid declaration, which the manifest walks whole)
   * covers every deliverable, as its revision does; an empty path covers nothing (never a valid declaration: `inside`).
   */
  covers(paths: readonly string[], file: string): boolean {
    const norm = (p: string): string => {
      const s = toPosix(p).replace(/\\/g, '/').split('/').filter((x) => x && x !== '.').join('/')
      return this.anyCase ? s.toLowerCase() : s
    }
    const f = norm(file)
    return paths.some((p) => {
      const d = norm(p)
      if (!d) return NoneAdapter.inside(p) && this.isDeliverable(file)
      return f === d || f.startsWith(`${d}/`)
    })
  }

  /** A manifest without the paths a card's work never covers (#1511): a starting one recorded before, compared with now. */
  covering(m: Manifest): Manifest {
    return Object.fromEntries(Object.entries(m).filter(([p]) => this.excludedPart(p) === null))
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
    return limit.n > NONE_MAX_FILES ? unknown(UNREADABLE.deliverables, { project: this.project, n: NONE_MAX_FILES }) : out.sort()
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

  /**
   * The part of a project-relative path that keeps it out of the deliverables (`.hive`, `.git` or an excluded folder), or
   * null (#1511). A card's paths narrow the deliverables, never widen them: declaring such a path is refused, and one
   * stored from before is left out of the card's revision (`leftOut`).
   */
  excludedPart(rel: string): string | null {
    return (
      toPosix(rel)
        .split('/')
        .filter(Boolean)
        .find((part) => this.skip(part)) ?? null
    )
  }

  /** The declared paths a revision leaves out (#1511): those under `.hive`, `.git` or an excluded folder. */
  leftOut(paths: string[]): string[] {
    return [...new Set(paths.map(toPosix))].filter((p) => this.excludedPart(p) !== null).sort()
  }

  /** The declared paths a revision covers: the rest. */
  private covered(paths: string[]): string[] {
    return [...new Set(paths.map(toPosix))].filter((p) => this.excludedPart(p) === null).sort()
  }

  /**
   * The manifest of some paths: each file under them with its content hash; a declared path that's gone is "deleted".
   * Declared paths under an excluded folder are left out (#1511), as a folder's excluded descendants are.
   */
  manifest(paths: string[]): Maybe<Manifest> {
    const out: Manifest = {}
    const limit = { n: 0 }
    let bytes = 0
    const kept = this.covered(paths)
    const outside = kept.find((p) => !NoneAdapter.inside(p))
    if (outside !== undefined) return unknown(UNREADABLE.pathOutside, { path: outside })
    for (const p of kept) {
      const found: string[] = []
      this.files(p, found, limit)
      if (limit.n > NONE_MAX_FILES) return unknown(UNREADABLE.cardPathsFiles, { n: NONE_MAX_FILES })
      if (!found.length) out[p] = DELETED
      for (const f of found) {
        try {
          bytes += statSync(join(this.project, f)).size
        } catch {
          // Gone meanwhile: hashed as deleted below.
        }
        if (bytes > NONE_MAX_BYTES) return unknown(UNREADABLE.cardPathsSize, { n: NONE_MAX_BYTES / 1024 ** 3 })
        out[f] = this.hashFile(f)
      }
    }
    return out
  }

  /**
   * The revision of a card's paths (§16.3.3): SHA-256 over the sorted (path, hash or "deleted") list together with the
   * path list itself, so changing the list is a new revision too. Computable at any time. The paths it covers: those
   * left out (#1511) are in neither.
   */
  revision(paths: string[]): Maybe<NoneRevision> {
    const m = this.manifest(paths)
    if (isUnknown(m)) return m
    const list = this.covered(paths)
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
    return toPosix(rel).split('/').filter(Boolean).length > 0 && this.excludedPart(rel) === null
  }

  /** A path relative to the project, with `/`. */
  rel(abs: string): string {
    return toPosix(relative(this.project, abs))
  }
}
