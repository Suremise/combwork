// A verified capture's fingerprint (J5's, HI-2798, extracted for J7's Operations preview, HI-2800): the raw bytes of
// every source a decision rests on, read synchronously with no process, hashed. Never interpreted: two prints differ when
// anything changed, whether or not it matters. A decision takes a print, makes its awaited reads, takes another (equal:
// the answers belong to those bytes), and checks it once more synchronously in the continuation that answers. Each
// caller names its own sources; jj's operation heads are always among them.

import { opendirSync, readFileSync } from 'original-fs'
import { createHash } from 'crypto'
import { join } from 'path'
import { readOpHeads } from './jjView'

/** At most this many files a print's trees hold by default (more is no print: unknown). */
export const PRINT_TREE_MAX = 20_000

/**
 * A print's bounds (HR2's HI-2800 round 3): the files its trees hold, the folders it walks and the bytes it reads in all.
 * Past any, the print is `over`: its caller refuses rather than read on.
 */
export interface PrintBounds {
  files: number
  dirs: number
  bytes: number
}

const UNBOUNDED_BYTES: PrintBounds = { files: PRINT_TREE_MAX, dirs: Number.POSITIVE_INFINITY, bytes: Number.POSITIVE_INFINITY }

export interface PrintSources {
  /** The shared jj repository, whose operation heads are printed. */
  jjRepo: string
  /** Files printed by their bytes, an absent one as absent, each under its label. */
  files: readonly { label: string; path: string }[]
  /** Folders printed whole, every file under them by its relative path and bytes; an absent folder as absent. */
  trees?: readonly { label: string; path: string }[]
  /** Text that steers the sources (an environment), printed as it is. */
  env?: string
}

/** A file's bytes, null when absent, undefined when it can't be read. */
function bytesOf(f: string): Buffer | null | undefined {
  try {
    return readFileSync(f)
  } catch (e) {
    const code = (e as { code?: string }).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? null : undefined
  }
}

/** What a print has spent of its bounds so far. */
interface Spent {
  files: number
  dirs: number
  bytes: number
  over: boolean
}

/** A file's bytes within the budget: null when absent, undefined when unreadable, 'over' past the bytes. */
function bytesWithin(f: string, spent: Spent, b: PrintBounds): Buffer | null | undefined | 'over' {
  const got = bytesOf(f)
  if (got === null || got === undefined) return got
  spent.bytes += got.length
  if (spent.bytes > b.bytes) {
    spent.over = true
    return 'over'
  }
  return got
}

/** Every file under a folder, sorted, with its bytes' hash; null when absent, undefined when unreadable or past a bound. */
function treeOf(dir: string, spent: Spent, b: PrintBounds): string[] | null | undefined {
  const out: string[] = []
  const walk = (d: string, rel: string): boolean => {
    if (++spent.dirs > b.dirs) {
      spent.over = true
      return false
    }
    let h
    try {
      h = opendirSync(d)
    } catch {
      return false
    }
    try {
      for (let e = h.readSync(); e; e = h.readSync()) {
        const p = join(d, e.name)
        const r = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) {
          if (!walk(p, r)) return false
        } else if (e.isFile()) {
          if (++spent.files > b.files) {
            spent.over = true
            return false
          }
          const got = bytesWithin(p, spent, b)
          if (got === undefined || got === 'over') return false
          out.push(`${r}=${got === null ? '-' : createHash('sha256').update(got).digest('hex')}`)
        } else return false
      }
    } finally {
      h.closeSync()
    }
    return true
  }
  try {
    opendirSync(dir).closeSync()
  } catch (e) {
    const code = (e as { code?: string }).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? null : undefined
  }
  return walk(dir, '') ? out.sort() : undefined
}

/**
 * The print of every source within `bounds`: its hash, `over` past a bound, or undefined when any source can't be read
 * (a read error, not "not there").
 */
export function sourcesPrintWithin(s: PrintSources, bounds: PrintBounds): string | 'over' | undefined {
  const h = createHash('sha256')
  const heads = readOpHeads(s.jjRepo)
  if (!heads) return undefined
  h.update(`heads:${[...heads].sort().join(',')}\n`)
  if (s.env !== undefined) h.update(`env:${s.env}\n`)
  const spent: Spent = { files: 0, dirs: 0, bytes: 0, over: false }
  for (const f of s.files) {
    const b = bytesWithin(f.path, spent, bounds)
    if (b === 'over') return 'over'
    if (b === undefined) return undefined
    h.update(`${f.label}:${b === null ? '-' : createHash('sha256').update(b).digest('hex')}\n`)
  }
  for (const t of s.trees ?? []) {
    const files = treeOf(t.path, spent, bounds)
    if (spent.over) return 'over'
    if (files === undefined) return undefined
    h.update(`${t.label}:${files === null ? '-' : files.join(',')}\n`)
  }
  return h.digest('hex')
}

/** The print of every source (J5's: a few small files, no byte bound), or undefined when any can't be read or a tree is past its bound. */
export function rawSourcesPrint(s: PrintSources): string | undefined {
  const p = sourcesPrintWithin(s, UNBOUNDED_BYTES)
  return p === 'over' ? undefined : p
}
