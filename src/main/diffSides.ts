// A diff's sides as every version control shows them (HI-3218, moved from git.ts): the largest side read, a binary side,
// and what a side over the limit shows instead. git.ts re-exports them; jj's revision reads use them as they are.

import { msg, tr } from '../shared/i18n'
import type { GitDiff } from '../shared/types'

/** The largest side of a diff read, in bytes: past it the file is said as too large, never read. */
export const MAX_DIFF_BYTES = 2 * 1024 * 1024

const M = {
  tooLarge: msg({ id: 'service.git.tooLarge', defaultMessage: 'File is too large to diff ({kb, number} KB).', description: "Shown in place of a file's changes in the Changes tab: the file is too large ({kb} KB) to compare." })
}

/** Shown in place of a file's diff when it is over MAX_DIFF_BYTES. */
export const tooLargeDiff = (path: string, bytes: number): GitDiff => ({ path, original: '', modified: tr(M.tooLarge, { kb: Math.round(bytes / 1024) }), binary: true })

/** Whether a side is binary: a NUL in its first 8,000 bytes, as git decides. */
export function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}
