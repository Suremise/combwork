// A workspace board's cards read and written by a test on a connection of its own, whichever form its file has (#1209):
// Hive 1.0's tables, through src/main/schema/cardRows.ts (the card JSON contract; Node runs it as it is, its types
// stripped, and it imports nothing), or 0.9's, a row per card holding its JSON document (a board waiting for its upgrade).

/** The 1.0 card rows' module, loaded when first needed. */
const cardRows = () => require('../../src/main/schema/cardRows.ts')

/** Whether the board's cards are 0.9's JSON documents. */
const legacy = (db) => db.prepare("SELECT 1 FROM pragma_table_info('cards') WHERE name = 'doc'").get() !== undefined

/** Every card's document (or these numbers'), in number order: [{ number, doc }]. */
function readDocs(db, numbers) {
  if (legacy(db)) {
    const rows = numbers ? db.prepare('SELECT number, doc FROM cards WHERE number IN (SELECT value FROM json_each(?)) ORDER BY number').all(JSON.stringify(numbers)) : db.prepare('SELECT number, doc FROM cards ORDER BY number').all()
    return rows.map((r) => ({ number: r.number, doc: JSON.parse(r.doc) }))
  }
  const { readCardRows, composeCard } = cardRows()
  return readCardRows(db, numbers ? { numbers } : {}).map((r) => ({ number: r.card.number, doc: composeCard(r) }))
}

/**
 * The documents of the cards that may cite test output (evidence.cjs): those neither Done nor archived, with their
 * comments as the only child rows (HI-2364: every card's every row took about 200 ms on a board of 2,400, read once for
 * each run folder a prune looked at). The caller still judges each document; the condition only leaves out rows it
 * would drop. A 0.9 board's documents are all read (its upgrade is due).
 */
function readCitingDocs(db) {
  if (legacy(db)) return readDocs(db)
  // A board this build hasn't opened yet (the installed Combwork's, before the names upgrade's step 25, HI-2587): its
  // comments' column has the old name. Read through a view of this connection's own, so the file is never changed.
  if (db.prepare("SELECT 1 FROM pragma_table_info('card_comments') WHERE name = 'hive_text'").get() !== undefined) db.exec('CREATE TEMP VIEW IF NOT EXISTS card_comments AS SELECT *, hive_text AS app_text FROM main.card_comments')
  const { readCardRows, composeCard } = cardRows()
  return readCardRows(db, { where: "archived = 0 AND col <> 'done'", parts: ['comments'] }).map((r) => ({ number: r.card.number, doc: composeCard(r) }))
}

/** Saves a card's document as another program would, in one transaction (a running Combwork sees it within about a second). */
function writeDoc(db, n, doc) {
  if (legacy(db)) {
    db.prepare('INSERT INTO cards (number, doc) VALUES (?, ?) ON CONFLICT(number) DO UPDATE SET doc = excluded.doc').run(n, JSON.stringify(doc))
    return
  }
  const { decomposeCard, writeCardRows } = cardRows()
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('BEGIN IMMEDIATE')
  try {
    writeCardRows(db, decomposeCard(n, doc))
    db.exec('COMMIT')
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw e
  }
}

module.exports = { readCitingDocs, readDocs, writeDoc }
