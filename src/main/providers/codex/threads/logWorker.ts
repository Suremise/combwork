import { existsSync } from 'original-fs'
import { parentPort } from 'worker_threads'
import { DatabaseSync } from 'node:sqlite'

/**
 * Codex's log's worker (HI-1972): a thread of its own that reads Codex's own log database (`logs_2.sqlite` in a
 * CODEX_HOME), read-only, for the newest row of one kind a session's thread wrote: the only place Codex records that it
 * is waiting to retry its model request (a 429). Off main's thread because a read of a file another process writes can
 * wait on its locks (bounded here by a 200 ms busy timeout) and an open can be slow (a scan). Never writes, never creates
 * a file, and keeps nothing open between reads: on Windows an open file can't be deleted or renamed, and the file is
 * Codex's (and a connection's folder Combwork may remove). Any error answers no row, with why. No Electron here (a worker
 * can't load it): main logs.
 */

const BUSY_MS = 200

export type LogRequest = { id: number; file: string; thread: string; target: string; sinceSec: number }

/** A row: its time (Unix seconds and the nanoseconds past them, as Codex writes them) and its message. */
export interface LogRow {
  ts: number
  nanos: number
  body: string
}

/** Why there was no row: the file isn't there, it was locked, it has no `logs` table, or another error (`error`). */
export type NoRow = 'missing' | 'busy' | 'noTable' | 'error'

export type LogAnswer = { row: LogRow | null; why?: NoRow; detail?: string }
export type LogReply = { id: number; answer: LogAnswer }

const whyOf = (e: unknown): NoRow => {
  const m = e instanceof Error ? e.message : String(e)
  if (/SQLITE_BUSY|database is locked/i.test(m)) return 'busy'
  if (/no such table/i.test(m)) return 'noTable'
  if (/unable to open|SQLITE_CANTOPEN/i.test(m)) return 'missing'
  return 'error'
}

/** The newest row the thread wrote for the target since `sinceSec`, or none and why. */
export function handleRequest(m: LogRequest): LogAnswer {
  if (!existsSync(m.file)) return { row: null, why: 'missing' }
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(m.file, { readOnly: true, timeout: BUSY_MS })
    // Codex's own index on (thread_id, ts DESC, ts_nanos DESC, id DESC) finds it.
    const r = db.prepare('SELECT ts, ts_nanos, feedback_log_body FROM logs WHERE thread_id = ? AND target = ? AND ts >= ? ORDER BY ts DESC, ts_nanos DESC, id DESC LIMIT 1').get(m.thread, m.target, Math.floor(m.sinceSec)) as { ts: number; ts_nanos: number; feedback_log_body: string | null } | undefined
    return { row: r ? { ts: Number(r.ts), nanos: Number(r.ts_nanos), body: String(r.feedback_log_body ?? '') } : null }
  } catch (e) {
    return { row: null, why: whyOf(e), detail: (e instanceof Error ? e.message : String(e)).slice(0, 200) }
  } finally {
    try {
      db?.close()
    } catch {
      // Not open: nothing to let go of.
    }
  }
}

const port = parentPort
if (port) port.on('message', (m: LogRequest) => port.postMessage({ id: m.id, answer: handleRequest(m) } satisfies LogReply))
