// Git's index, read synchronously with no process (#1206): what the evidence fingerprint needs of it. An index rewritten
// only to refresh its cached stat data (an outside `git status`, an editor's git integration) keeps every entry's mode,
// object id, stage and path, so a fingerprint made of those doesn't change; a staged change does. Each entry's stat data
// is kept too, to tell a tracked file whose content is the index's (its size and time match, and the entry isn't racy).
//
// Versions 2, 3 and 4 (4's prefix-compressed paths), SHA-1 and SHA-256 object ids. A split index (its entries partly in
// another file) or anything unreadable is null: the caller then falls back to the index file's stat (fail safe).

import { readFileSync } from 'original-fs'

export interface IndexEntry {
  path: string
  mode: number
  oid: string
  stage: number
  size: number
  /** The entry's modification time, in milliseconds (git's seconds and nanoseconds). */
  mtimeMs: number
}

export interface GitIndex {
  entries: IndexEntry[]
  /** When the index file was written: an entry modified at or after it is racy (its stat data proves nothing). */
  writtenMs: number
}

/** Reads an index file; `oidBytes` is 20 for SHA-1 repositories, 32 for SHA-256. Null when it can't be read or isn't one this reads. */
export function readIndex(file: string, oidBytes: 20 | 32, writtenMs: number): GitIndex | null {
  let buf: Buffer
  try {
    buf = readFileSync(file)
  } catch {
    return null
  }
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'DIRC') return null
  const version = buf.readUInt32BE(4)
  if (version < 2 || version > 4) return null
  const count = buf.readUInt32BE(8)
  const entries: IndexEntry[] = []
  let at = 12
  let prev = ''
  try {
    for (let i = 0; i < count; i++) {
      const start = at
      const mtimeMs = buf.readUInt32BE(at + 8) * 1000 + Math.floor(buf.readUInt32BE(at + 12) / 1e6)
      const mode = buf.readUInt32BE(at + 24)
      const size = buf.readUInt32BE(at + 36)
      at += 40
      const oid = buf.toString('hex', at, at + oidBytes)
      at += oidBytes
      const flags = buf.readUInt16BE(at)
      at += 2
      // An extended entry (v3+): its second flags word.
      if (flags & 0x4000) at += 2
      const stage = (flags >> 12) & 0x3
      let path: string
      if (version === 4) {
        // How much of the previous path to drop (an offset varint), then the rest, NUL-terminated.
        let n = buf[at] & 0x7f
        while (buf[at++] & 0x80) n = ((n + 1) << 7) | (buf[at] & 0x7f)
        const end = buf.indexOf(0, at)
        if (end < 0 || n > prev.length) return null
        path = prev.slice(0, prev.length - n) + buf.toString('utf8', at, end)
        at = end + 1
      } else {
        const end = buf.indexOf(0, at)
        if (end < 0) return null
        path = buf.toString('utf8', at, end)
        // Padded with NULs to a multiple of 8 bytes, counted from the entry's start.
        at = start + Math.ceil((end + 1 - start) / 8) * 8
      }
      prev = path
      entries.push({ path, mode, oid, stage, size, mtimeMs })
    }
  } catch {
    // Cut short (rewritten while read): not an index this can read.
    return null
  }
  // A split index: its entries are partly in the shared index, which this doesn't read.
  for (let x = at; x + 8 <= buf.length - oidBytes; ) {
    const sig = buf.toString('latin1', x, x + 4)
    if (sig === 'link') return null
    const len = buf.readUInt32BE(x + 4)
    x += 8 + len
  }
  return { entries, writtenMs }
}

/**
 * Whether a file's stat shows the index's content: its size and time match the entry's, and the entry isn't racy (git's
 * own rule: modified in the second the index was written or later, its content may have changed unseen). An index
 * without nanoseconds (Git for Windows' default) is compared in whole seconds.
 */
export function statMatches(e: IndexEntry, size: number, mtimeMs: number, writtenMs: number): boolean {
  const sameTime = e.mtimeMs % 1000 === 0 ? Math.floor(e.mtimeMs / 1000) === Math.floor(mtimeMs / 1000) : Math.floor(e.mtimeMs) === Math.floor(mtimeMs)
  return e.size === size % 2 ** 32 && sameTime && Math.floor(e.mtimeMs / 1000) < Math.floor(writtenMs / 1000)
}
