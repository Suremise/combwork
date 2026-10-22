/**
 * Reading a live transcript's turns for hooks health (#1371), one look at a time: which bytes are new since the last look,
 * as whole lines, for one conversation's file. A reading belongs to a conversation and a file: another path or
 * conversation, a shrink, or other first bytes (a file replaced under the same name) start it again, from the file's end
 * (what is there is history), unless this is the launch's new conversation (`fresh`: from its start). A gap of more than
 * `MAX_SPAN` since the last look forgets what the adapter knew (its memo), so a turn whose prompt wasn't read is unknown.
 */

/** Its first bytes, kept to tell a replaced file. */
const HEAD = 4096
/** The most read in one look: the latest bytes. */
export const MAX_SPAN = 4 * 1024 * 1024

export interface TurnsReading {
  sessionId: string
  path: string
  /** How far it has read: the end of a whole line. */
  offset: number
  head: string
  headBytes: number
  /** The adapter's, kept between reads of this file. */
  memo: Record<string, unknown>
}

/** The bytes of the file from start to end as text, or null when it is gone. */
export type ReadSpan = (start: number, end: number) => Promise<string | null>

export interface TurnsLook {
  /** The reading after this look (a new one when it started again). */
  reading: TurnsReading
  /** It started again: what the old reading found is let go. */
  restarted: boolean
  /** Whole new lines, or null when there are none. */
  lines: string | null
}

/**
 * One look at the file (`size`: its size at a stat just before), from the reading as it was (or none). Null when the file
 * went meanwhile: nothing changes.
 */
export async function lookAtTurns(prev: TurnsReading | undefined, at: { path: string; sessionId: string; size: number; fresh: boolean }, read: ReadSpan): Promise<TurnsLook | null> {
  const { path, sessionId, size } = at
  let r = prev && prev.path === path && prev.sessionId === sessionId && size >= prev.offset ? prev : undefined
  if (r) {
    const head = await read(0, r.headBytes)
    if (head === null) return null
    if (head !== r.head) r = undefined
  }
  let restarted = false
  if (!r) {
    const headBytes = Math.min(HEAD, size)
    const head = await read(0, headBytes)
    if (head === null) return null
    r = { sessionId, path, offset: at.fresh ? 0 : size, head, headBytes, memo: {} }
    restarted = true
  } else if (r.headBytes < HEAD && size > r.headBytes) {
    const headBytes = Math.min(HEAD, size)
    const head = await read(0, headBytes)
    if (head === null) return null
    r = { ...r, head, headBytes }
  }
  if (size <= r.offset) return { reading: r, restarted, lines: null }
  const start = Math.max(r.offset, size - MAX_SPAN)
  // From the byte before, to tell whether it starts a line: one begun before it is dropped.
  let text = await read(start > 0 ? start - 1 : 0, size)
  if (text === null) return null
  if (start > 0) text = text.startsWith('\n') ? text.slice(1) : text.slice(text.indexOf('\n') + 1 || text.length)
  const end = text.lastIndexOf('\n')
  const reading: TurnsReading = { ...r, offset: size - Buffer.byteLength(text.slice(end + 1)), memo: start > r.offset ? {} : r.memo }
  return { reading, restarted, lines: end < 0 ? null : text.slice(0, end + 1) }
}
