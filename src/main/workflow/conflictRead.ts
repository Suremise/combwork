// Reads a returned card's conflicting files from the merge queue's own folder before its test merge is aborted (HI-1181,
// design s10 checked by HR4): bounded before anything is read, and confined to that folder. A path git named is never
// followed through a link, nor read outside the folder; what can't be read safely is recorded as such (metadata only),
// never as "no conflict". The parsing is shared/workflow/conflicts.ts's.

import { isAbsolute, join, normalize, sep } from 'path'
import { lstat, open } from 'original-fs/promises'
import { CONFLICT_LIMITS, parseConflicts, type ConflictFile, type ConflictNotRead, type ConflictsRecord } from '../../shared/workflow/conflicts'
import { containsPlace } from '../fsutil'

/** The budgets a read keeps to (tests pass smaller ones); CONFLICT_LIMITS' by default. */
export interface ConflictBudget {
  files: number
  fileBytes: number
  totalBytes: number
}

const notRead = (file: string, why: ConflictNotRead): ConflictFile => ({ file, notRead: why, hunks: [] })

/**
 * Where `file` is under `folder`, or why it can't be read there: a path that isn't relative or climbs out (rejected as
 * written, before any of it is looked at), a link anywhere on the way (never followed), not there, or not a file.
 */
async function placeOf(folder: string, file: string): Promise<{ path: string; size: number } | { why: ConflictNotRead }> {
  const rel = normalize(file)
  if (!file || isAbsolute(file) || /^[a-zA-Z]:/.test(file) || rel === '..' || rel.startsWith(`..${sep}`) || rel.split(/[\\/]/).includes('..')) return { why: 'outside' } // i18n-ignore: a reason's code (ConflictNotRead), worded by the window
  const parts = rel.split(/[\\/]/).filter(Boolean)
  let at = folder
  for (const [i, part] of parts.entries()) {
    at = join(at, part)
    let st
    try {
      st = await lstat(at)
    } catch {
      return { why: 'missing' } // i18n-ignore: a reason's code (ConflictNotRead), worded by the window
    }
    // A symlink or a junction, the file itself or a folder on the way: its target may be anywhere.
    if (st.isSymbolicLink()) return { why: 'link' } // i18n-ignore: a reason's code (ConflictNotRead), worded by the window
    if (i === parts.length - 1) {
      if (!st.isFile()) return { why: 'missing' } // i18n-ignore: a reason's code (ConflictNotRead), worded by the window
      // The folder's own real place holds it (a link above the folder is the folder's, not the path's).
      if (!containsPlace(folder, at)) return { why: 'outside' } // i18n-ignore: a reason's code (ConflictNotRead), worded by the window
      return { path: at, size: st.size }
    }
    if (!st.isDirectory()) return { why: 'missing' } // i18n-ignore: a reason's code (ConflictNotRead), worded by the window
  }
  return { why: 'missing' } // i18n-ignore: a reason's code (ConflictNotRead), worded by the window
}

/**
 * The conflicted files' hunks in `folder` (the queue's worktree, mid-merge or mid-rebase), at most `budget.files` of
 * them, each read up to `budget.fileBytes` and all up to `budget.totalBytes`: a fixed buffer each, never the whole file.
 * `oursIs`: which side git wrote first. Never throws: a file it can't read is recorded with why.
 */
export async function readConflicts(folder: string, files: readonly string[], oursIs: ConflictsRecord['oursIs'], budget: ConflictBudget = CONFLICT_LIMITS): Promise<ConflictsRecord> {
  const out: ConflictFile[] = []
  const room = { chars: CONFLICT_LIMITS.chars }
  let left = budget.totalBytes
  for (const file of files.slice(0, budget.files)) {
    const place = await placeOf(folder, file).catch((): { why: ConflictNotRead } => ({ why: 'error' })) // i18n-ignore: a reason's code (ConflictNotRead), worded by the window
    if ('why' in place) {
      out.push(notRead(file, place.why))
      continue
    }
    // Over the whole read's budget: the rest aren't opened.
    if (left <= 0) {
      out.push(notRead(file, 'budget'))
      continue
    }
    const n = Math.min(budget.fileBytes, left, place.size)
    const whole = n >= place.size
    let buf: Buffer
    try {
      const fh = await open(place.path, 'r')
      try {
        buf = Buffer.alloc(n)
        const { bytesRead } = await fh.read(buf, 0, n, 0)
        buf = buf.subarray(0, bytesRead)
      } finally {
        await fh.close()
      }
    } catch {
      out.push(notRead(file, 'error'))
      continue
    }
    left -= buf.length
    if (buf.includes(0)) {
      out.push(notRead(file, 'binary'))
      continue
    }
    let text: string
    try {
      // Cut at the budget, a character split at the end is the cut's, not invalid text (HR4's s10): `stream` leaves
      // an incomplete last sequence out; only bytes that are wrong where they are fail.
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf, { stream: !whole })
    } catch {
      out.push(notRead(file, 'notText'))
      continue
    }
    out.push(parseConflicts(file, text, whole && buf.length === place.size, room))
  }
  return { oursIs, files: out, ...(files.length > budget.files ? { filesLeft: files.length - budget.files } : {}) }
}
