// The board's cards as tests read and change them by hand (#1017): in the workspace's database, as Combwork keeps them now.
import { DatabaseSync } from 'node:sqlite'
import { BOARD_MIGRATIONS, boardChanged, boardFile, boardWrite, cardDoc, deleteCard, putCard } from '../src/main/boardStore'
import { composeCard, decomposeCard, readCardRows, writeCardRows } from '../src/main/schema/cardRows'
import { CARDS_STEP } from '../src/main/schema/v1_0'
import type { WorkspaceService } from '../src/main/workspace'

/** A card's document as saved (what its file held before 0.9); throws when there is no such card. */
export function readCard(ws: WorkspaceService, n: number): Record<string, unknown> {
  const doc = cardDoc(ws, n)
  if (!doc) throw new Error(`no card #${n}`)
  return doc
}

/** Saves a card's document as it is given, as an edit by hand or another program would: the board is told. */
export function writeCard(ws: WorkspaceService, n: number, doc: Record<string, unknown>): Promise<void> {
  return boardWrite(ws, async () => {
    putCard(ws, n, doc)
    boardChanged(ws)
  })
}

/** Changes a card's saved document. */
export async function editCard(ws: WorkspaceService, n: number, edit: (doc: Record<string, unknown>) => Record<string, unknown> | void): Promise<void> {
  const doc = readCard(ws, n)
  await writeCard(ws, n, edit(doc) ?? doc)
}

/** Removes a card as a program outside Combwork would (no reference to it dropped). */
export function removeCard(ws: WorkspaceService, n: number): Promise<void> {
  return boardWrite(ws, async () => {
    deleteCard(ws, n)
    boardChanged(ws)
  })
}

/**
 * Saves a card's document from outside this Combwork (another copy of Combwork, a script): its own connection to the board's file,
 * past the board's lock in this process (a test holding it to make a change wait).
 */
export function writeCardOutside(workspacePath: string, n: number, doc: Record<string, unknown>): void {
  const db = new DatabaseSync(boardFile(workspacePath), { timeout: 5000 })
  try {
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('BEGIN IMMEDIATE')
    writeCardRows(db, decomposeCard(n, doc))
    db.exec('COMMIT')
  } finally {
    db.close()
  }
}

/**
 * Puts a 1.0 board's file back as 0.9 left it (#1209): its cards as JSON documents in 0.9's `cards` table (from the
 * board's own first step), every table of the 1.0 group's steps dropped (#1212's too), 0.9's tables it no longer has made again (store_rows, #1211), and none of them recorded. For a board made by
 * this Combwork (a new file takes every step) that a test needs from before its upgrade. The file must be closed.
 */
export function as09(file: string): void {
  const db = new DatabaseSync(file, { timeout: 5000 })
  try {
    const docs = readCardRows(db).map((r) => [r.card.number, JSON.stringify(composeCard(r))] as const)
    // 0.9's tables, and its cards table with its indexes, as the steps before the 1.0 group make them.
    const v09 = new DatabaseSync(':memory:')
    for (const m of BOARD_MIGRATIONS.filter((x) => !x.group)) m.up(v09)
    const tablesOf = (d: DatabaseSync): string[] => (d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name)
    const keep = new Set([...tablesOf(v09), 'schema_version'])
    const ddl = (v09.prepare("SELECT sql FROM sqlite_master WHERE tbl_name = 'cards' AND sql IS NOT NULL ORDER BY type DESC").all() as { sql: string }[]).map((r) => r.sql)
    // 0.9's tables a 1.0 file no longer has (#1211's step drops store_rows), made again empty, with their indexes.
    const had = new Set(tablesOf(db))
    const missing = (v09.prepare("SELECT tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND tbl_name <> 'cards' ORDER BY type DESC").all() as { tbl_name: string; sql: string }[]).filter((r) => !had.has(r.tbl_name)).map((r) => r.sql)
    v09.close()
    const cardTables = CARDS_STEP.ddl.map((sql) => /^CREATE TABLE (\w+)/.exec(sql)?.[1]).filter((t): t is string => !!t)
    db.exec('PRAGMA foreign_keys = OFF')
    db.exec('BEGIN IMMEDIATE')
    // The 1.0 card tables (`cards` among them), and every other table of a later step (#1212's on).
    for (const t of cardTables.reverse()) db.exec(`DROP TABLE ${t}`)
    // A virtual table's own tables (card_search's, #1237) go with it: each is looked for again before it is dropped.
    for (const t of tablesOf(db)) if (!keep.has(t) && tablesOf(db).includes(t)) db.exec(`DROP TABLE "${t}"`)
    for (const sql of ddl) db.exec(sql)
    for (const sql of missing) db.exec(sql)
    const put = db.prepare('INSERT INTO cards (number, doc) VALUES (?, ?)')
    for (const [n, doc] of docs) put.run(n, doc)
    db.prepare('DELETE FROM schema_version WHERE version >= ?').run(Math.min(...BOARD_MIGRATIONS.filter((m) => m.group === '1.0').map((m) => m.version)))
    db.exec("DELETE FROM board_meta WHERE key = 'format'")
    db.exec('COMMIT')
  } finally {
    db.close()
  }
}

/** The key of the board's lock in this process (a test holds it to make a change wait). */
export const boardLockKey = (workspacePath: string): string => `board-lock:${workspacePath}`

/** A card's document read from the board's file on its own connection (any workspace, open in this Combwork or not). */
export function readCardIn(workspacePath: string, n: number): Record<string, unknown> {
  const db = new DatabaseSync(boardFile(workspacePath), { readOnly: true, timeout: 5000 })
  try {
    const [r] = readCardRows(db, { numbers: [n] })
    if (!r) throw new Error(`no card #${n}`)
    return composeCard(r)
  } finally {
    db.close()
  }
}
