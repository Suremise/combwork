import type { DatabaseSync } from 'node:sqlite'
import type { SchemaStep } from './v1_0'

/**
 * A card's archived comments (HI-2641, SPEC §16.4): the oldest ones past the 500 a card keeps (tasks.ts MAX_COMMENTS),
 * moved here instead of dropped. This module keeps their rows: written in the change that evicts them, read a page at a
 * time, counted. They aren't part of the card's document (composeCard never reads them), so the table is no card
 * revision's (CARD_REVS_STEP's REV_TABLES): archiving a comment doesn't make the window read the card again.
 *
 * Each row is a comment as the card had it, its exact JSON (`doc`: nothing in it is queried, and JSON keeps any field
 * and string as it was), in the order it was archived (`ord`, oldest first), with `akey`: the key tasks.ts gave it when
 * it was evicted, never taken from its content, so saving the same eviction twice (or again after a change rolled back)
 * adds it once, and two comments alike in every field are still two.
 *
 * The board step (BOARD_MIGRATIONS version 27) also records which cards held 500 comments or more when it ran
 * (`commentsMayHaveBeenLost` in board_meta): those may have lost older comments before archiving existed, which can't be
 * recovered and are never counted or made up.
 */
export const COMMENT_ARCHIVE_STEP: SchemaStep = {
  name: 'comment archive',
  ddl: [
    `CREATE TABLE card_comments_archive (
      card      INTEGER NOT NULL REFERENCES cards (number) ON DELETE CASCADE,
      ord       INTEGER NOT NULL,
      akey      TEXT    NOT NULL,
      doc       TEXT    NOT NULL,
      PRIMARY KEY (card, ord),
      UNIQUE (card, akey)
    ) STRICT, WITHOUT ROWID`
  ]
}

/** The board_meta key of the cards that may have lost comments before archiving existed (a JSON list of numbers). */
export const MAY_HAVE_LOST_KEY = 'commentsMayHaveBeenLost'

/** How many comments a card keeps before its oldest are archived; tasks.ts' MAX_COMMENTS, the step's measure. */
export const COMMENTS_KEPT = 500

/** The step: the table, and the cards that held the cap already (they may have lost comments before it). */
export function addCommentArchive(db: DatabaseSync): void {
  for (const sql of COMMENT_ARCHIVE_STEP.ddl) db.exec(sql)
  const capped = (db.prepare('SELECT card FROM card_comments GROUP BY card HAVING count(*) >= ? ORDER BY card').all(COMMENTS_KEPT) as { card: number }[]).map((r) => r.card) // i18n-ignore: SQL
  if (capped.length) db.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(MAY_HAVE_LOST_KEY, JSON.stringify(capped)) // i18n-ignore: SQL
}

/** A comment waiting to be archived: its key (given when it was evicted) and the comment as the card had it. */
export interface Evicted {
  key: string
  comment: unknown
}

/** Archives a card's evicted comments, oldest first, after what it has; one already there by its key is skipped. Returns how many were added. */
export function archiveCommentRows(db: DatabaseSync, card: number, evicted: readonly Evicted[]): number {
  if (!evicted.length) return 0
  const has = db.prepare('SELECT 1 FROM card_comments_archive WHERE card = ? AND akey = ?') // i18n-ignore: SQL
  const next = db.prepare('SELECT coalesce(max(ord) + 1, 0) AS n FROM card_comments_archive WHERE card = ?') // i18n-ignore: SQL
  const ins = db.prepare('INSERT INTO card_comments_archive (card, ord, akey, doc) VALUES (?, ?, ?, ?)') // i18n-ignore: SQL
  let added = 0
  let ord = (next.get(card) as { n: number }).n
  for (const e of evicted) {
    if (has.get(card, e.key)) continue
    ins.run(card, ord++, e.key, JSON.stringify(e.comment))
    added++
  }
  return added
}

/** How many comments a card has archived. */
export function archivedCommentCount(db: DatabaseSync, card: number): number {
  return (db.prepare('SELECT count(*) AS n FROM card_comments_archive WHERE card = ?').get(card) as { n: number }).n // i18n-ignore: SQL
}

/** A page of a card's archived comments, oldest first, each exactly as the card had it. */
export function archivedCommentRows(db: DatabaseSync, card: number, offset: number, limit: number): unknown[] {
  const rows = db.prepare('SELECT doc FROM card_comments_archive WHERE card = ? ORDER BY ord LIMIT ? OFFSET ?').all(card, limit, offset) as { doc: string }[] // i18n-ignore: SQL
  return rows.map((r) => JSON.parse(r.doc) as unknown)
}

/** Every card's archived comments (Export Board), by card number, oldest first. */
export function allArchivedComments(db: DatabaseSync): Map<number, unknown[]> {
  const out = new Map<number, unknown[]>()
  const rows = db.prepare('SELECT card, doc FROM card_comments_archive ORDER BY card, ord').all() as { card: number; doc: string }[] // i18n-ignore: SQL
  for (const r of rows) {
    const list = out.get(r.card) ?? []
    if (!out.has(r.card)) out.set(r.card, list)
    list.push(JSON.parse(r.doc) as unknown)
  }
  return out
}

/** The cards the step found at the cap (MAY_HAVE_LOST_KEY), from board_meta's value. */
export function mayHaveLostCards(db: DatabaseSync): Set<number> {
  const row = db.prepare('SELECT value FROM board_meta WHERE key = ?').get(MAY_HAVE_LOST_KEY) as { value: string } | undefined // i18n-ignore: SQL
  if (!row) return new Set()
  try {
    const v: unknown = JSON.parse(row.value)
    return new Set(Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x)) : [])
  } catch {
    return new Set()
  }
}
