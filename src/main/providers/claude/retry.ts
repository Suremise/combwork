import { open } from 'original-fs/promises'
import type { RetryWait } from '../../../shared/types'
import { advanced } from '../../advanced'

/**
 * Claude Code waiting to retry its model request (HI-1973): its transcript records each try as a system entry
 * (`claude-code.retry.subtype`, recorded as api_error) with which try it is of how many, the wait before the next and the
 * error (its HTTP status; none when the service couldn't be reached). Hive reads only the transcript's end, where a turn
 * still retrying has them last, and never holds a file open past the read.
 */

/** How much of a transcript's end is read: a try's entry is under 2 KB, and a turn makes at most a few dozen. */
export const RETRY_TAIL_BYTES = 64 * 1024
/** The most tries, and the longest wait (ms), a believable entry names. */
const MOST_TRIES = 100
const LONGEST_WAIT_MS = 24 * 60 * 60_000

/** The retry wait in a transcript's end (`path`), recorded since `since` (ms); null: none, or it couldn't be read. */
export async function claudeRetryWait(path: string | undefined, since: number, now = Date.now()): Promise<RetryWait | null> {
  if (!path) return null
  const fh = await open(path, 'r').catch(() => null)
  if (!fh) return null
  let text: string
  let partial: boolean
  try {
    const { size } = await fh.stat()
    const from = Math.max(0, size - RETRY_TAIL_BYTES)
    const buf = Buffer.alloc(size - from)
    const { bytesRead } = await fh.read(buf, 0, buf.length, from)
    text = buf.subarray(0, bytesRead).toString('utf8')
    partial = from > 0
  } catch {
    return null
  } finally {
    await fh.close().catch(() => undefined)
  }
  const lines = text.split('\n')
  // Read from the middle of the file: its first line is the end of one cut short.
  if (partial) lines.shift()
  return retryWaitIn(lines, since, now)
}

const whole = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null)

/**
 * The newest retry entry of `lines` (a transcript's, oldest first) recorded since `since` and no later than a minute
 * from `now`, with the first of them as the wait's start (one turn's tries, nothing heard between: the caller's `since`
 * is the last hook). Lines that aren't such an entry, or whose numbers don't hold up (a try past its tries, a wait over a
 * day, a status that isn't HTTP's), are skipped.
 */
export function retryWaitIn(lines: readonly string[], since: number, now = Date.now()): RetryWait | null {
  const subtype = advanced.get<string>('claude-code.retry.subtype')
  const f = { attempt: advanced.get<string>('claude-code.retry.attemptField'), max: advanced.get<string>('claude-code.retry.maxField'), wait: advanced.get<string>('claude-code.retry.waitField'), status: advanced.get<string>('claude-code.retry.statusField') }
  let first: string | null = null
  let newest: RetryWait | null = null
  for (const line of lines) {
    if (!line.includes(subtype)) continue
    let o: Record<string, unknown>
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if (!o || typeof o !== 'object' || o.type !== 'system' || o.subtype !== subtype) continue
    const at = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN
    if (!Number.isFinite(at) || at < since || at > now + 60_000) continue
    const attempt = whole(o[f.attempt])
    const max = whole(o[f.max])
    const wait = typeof o[f.wait] === 'number' ? (o[f.wait] as number) : NaN
    if (attempt === null || max === null || attempt < 1 || max < attempt || max > MOST_TRIES || !Number.isFinite(wait) || wait < 0 || wait > LONGEST_WAIT_MS) continue
    const err = o.error && typeof o.error === 'object' ? (o.error as Record<string, unknown>) : {}
    const s = whole(err[f.status])
    const status = s !== null && s >= 100 && s <= 599 ? s : null
    const told = new Date(at).toISOString()
    first ??= told
    // No HTTP status: the service didn't answer (refused, not found, timed out), so it couldn't be reached.
    newest = { at: told, since: first, retryAt: new Date(at + wait).toISOString(), attempt, max, status, ...(status === null ? { network: true as const } : {}) }
  }
  return newest
}
