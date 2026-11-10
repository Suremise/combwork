// A verified capture's fingerprint (J5's, HI-2798, extracted for J7's Operations preview, HI-2800): the raw bytes of
// every source a decision rests on, read synchronously with no process, hashed. Never interpreted: two prints differ when
// anything changed, whether or not it matters. A decision takes a print, makes its awaited reads, takes another (equal:
// the answers belong to those bytes), and checks it once more synchronously in the continuation that answers. Each
// caller names its own sources; jj's operation heads are always among them.

import { opendirSync, readFileSync } from 'original-fs'
import { createHash } from 'crypto'
import { join } from 'path'
import { readOpHeads } from './jjView'

/** At most this many files a print's trees hold (more is no print: unknown). */
export const PRINT_TREE_MAX = 20_000

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

/** Every file under a folder, sorted, with its bytes' hash; null when absent, undefined when unreadable or past the bound. */
function treeOf(dir: string): string[] | null | undefined {
  const out: string[] = []
  const walk = (d: string, rel: string): boolean => {
    let h
    try {
      h = opendirSync(d)
    } catch (e) {
      const code = (e as { code?: string }).code
      if (rel === '' && (code === 'ENOENT' || code === 'ENOTDIR')) return true
      return false
    }
    try {
      for (let e = h.readSync(); e; e = h.readSync()) {
        if (out.length >= PRINT_TREE_MAX) return false
        const p = join(d, e.name)
        const r = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) {
          if (!walk(p, r)) return false
        } else if (e.isFile()) {
          const b = bytesOf(p)
          if (b === undefined) return false
          out.push(`${r}=${b === null ? '-' : createHash('sha256').update(b).digest('hex')}`)
        } else return false
      }
    } finally {
      h.closeSync()
    }
    return true
  }
  let there = true
  try {
    opendirSync(dir).closeSync()
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === 'ENOENT' || code === 'ENOTDIR') there = false
    else return undefined
  }
  if (!there) return null
  return walk(dir, '') ? out.sort() : undefined
}

/** The print of every source, or undefined when any can't be read (a read error, not "not there"). */
export function rawSourcesPrint(s: PrintSources): string | undefined {
  const h = createHash('sha256')
  const heads = readOpHeads(s.jjRepo)
  if (!heads) return undefined
  h.update(`heads:${[...heads].sort().join(',')}\n`)
  if (s.env !== undefined) h.update(`env:${s.env}\n`)
  for (const f of s.files) {
    const b = bytesOf(f.path)
    if (b === undefined) return undefined
    h.update(`${f.label}:${b === null ? '-' : createHash('sha256').update(b).digest('hex')}\n`)
  }
  for (const t of s.trees ?? []) {
    const files = treeOf(t.path)
    if (files === undefined) return undefined
    h.update(`${t.label}:${files === null ? '-' : files.join(',')}\n`)
  }
  return h.digest('hex')
}
