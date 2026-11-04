import { parentPort, workerData } from 'worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { movedContextRef, rewriteMovedPaths, type FolderMove } from '../shared/hiveFolderMove'

/**
 * The folder move's card rewrite (HI-2462), in a thread of its own: a connection of its own to the workspace's board
 * rewrites, in batches, every card's description, comment text and context reference that names a path into a folder
 * that moved, so main's thread (which carries every keystroke) never reads the board whole. Only rows that name `.hive`
 * are read, and only those that change are written. Card history isn't touched: it records what was. A board without
 * the 1.0 tables (still 0.9's, its upgrade waiting) is left for a later open: `deferred`. The board's readers see the
 * change by its data_version (another connection's commit), as they see another process's. No Electron here.
 */

export interface CardsRewrite {
  file: string
  moves: FolderMove[]
  /** The workspace's own folder moved: context references to `.hive/shared/…` read `shared:…` now. */
  workspaceMoved: boolean
}

export type CardsAnswer = { ok: true; changed: number; deferred: boolean } | { ok: false; error: string }

/** Rows written in one transaction: short, so main's own writes never wait long behind it. */
const BATCH = 200

/** Whether the board has 1.0's table with this column (a 0.9 board, its upgrade waiting, has neither). */
const has = (db: DatabaseSync, table: string, column: string): boolean => (db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as { name: string }[]).some((c) => c.name === column) // i18n-ignore: SQL

export function rewriteCards(job: CardsRewrite): CardsAnswer {
  const db = new DatabaseSync(job.file, { timeout: 10_000 })
  try {
    if (!(has(db, 'cards', 'description') && has(db, 'card_comments', 'text') && has(db, 'card_context', 'ref'))) return { ok: true, changed: 0, deferred: true }
    const text = (s: string): string => rewriteMovedPaths(s, job.moves)
    const ref = (s: string): string => {
      const r = text(s)
      return job.workspaceMoved ? movedContextRef(r) : r
    }
    let changed = 0
    // Each table by its key, in key order, a batch at a time: a write between batches can't make one be missed.
    const run = (select: string, update: string, keyCols: string[], col: string, f: (s: string) => string): void => {
      let after: unknown[] | null = null
      for (;;) {
        const rows = (after ? db.prepare(`${select} AND (${keyCols.join(', ')}) > (${keyCols.map(() => '?').join(', ')}) ORDER BY ${keyCols.join(', ')} LIMIT ${BATCH}`).all(...(after as never[])) : db.prepare(`${select} ORDER BY ${keyCols.join(', ')} LIMIT ${BATCH}`).all()) as Record<string, unknown>[]
        if (!rows.length) return
        db.exec('BEGIN IMMEDIATE')
        try {
          const up = db.prepare(update)
          for (const r of rows) {
            const before = String(r[col])
            const now = f(before)
            if (now !== before) {
              up.run(now, ...(keyCols.map((k) => r[k]) as never[]))
              changed++
            }
          }
          db.exec('COMMIT')
        } catch (e) {
          if (db.isTransaction) db.exec('ROLLBACK')
          throw e
        }
        const last = rows[rows.length - 1]
        after = keyCols.map((k) => last[k])
      }
    }
    run("SELECT number, description FROM cards WHERE description LIKE '%.hive%'", 'UPDATE cards SET description = ? WHERE number = ?', ['number'], 'description', text) // i18n-ignore: SQL
    run("SELECT card, ord, text FROM card_comments WHERE text LIKE '%.hive%'", 'UPDATE card_comments SET text = ? WHERE card = ? AND ord = ?', ['card', 'ord'], 'text', text) // i18n-ignore: SQL
    run("SELECT card, ord, ref FROM card_context WHERE ref LIKE '%.hive%'", 'UPDATE card_context SET ref = ? WHERE card = ? AND ord = ?', ['card', 'ord'], 'ref', ref) // i18n-ignore: SQL
    return { ok: true, changed, deferred: false }
  } finally {
    db.close()
  }
}

const port = parentPort
if (port && workerData) {
  try {
    port.postMessage(rewriteCards(workerData as CardsRewrite))
  } catch (e) {
    port.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) } satisfies CardsAnswer)
  }
}
