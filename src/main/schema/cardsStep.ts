import type { DatabaseSync } from 'node:sqlite'
import { composeCard, decomposeCard, readCardRows, writeCardRows } from './cardRows'
import { CARDS_STEP } from './v1_0'

/**
 * The cards step (#1209, in the 1.0 group): today's `cards` (a row a card, its JSON document) moved aside, the 1.0 tables
 * made (v1_0.ts), every card copied into them, each checked to compose back to its document byte for byte, and the old
 * table dropped. Inside the group's transaction: a card that doesn't come back as it was, or a row that isn't a card's
 * document, throws, and the file stays the 0.9 board it was.
 */
export function moveCardsIntoTables(db: DatabaseSync): void {
  // Today's indexes go with their table; their names are the new table's.
  for (const ix of ['cards_place', 'cards_project', 'cards_agent', 'cards_updated']) db.exec(`DROP INDEX IF EXISTS ${ix}`)
  db.exec('ALTER TABLE cards RENAME TO cards_09')
  for (const sql of CARDS_STEP.ddl) db.exec(sql)
  const old = db.prepare('SELECT number, doc FROM cards_09 ORDER BY number').all() as { number: number; doc: string }[]
  const want = new Map<number, string>()
  for (const { number, doc } of old) {
    let parsed: unknown
    try {
      parsed = JSON.parse(doc)
    } catch {
      parsed = null
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`card #${number}'s saved document isn't a JSON object`) // i18n-ignore: an internal check's error, quoted as the upgrade's reason
    want.set(number, JSON.stringify(parsed))
    writeCardRows(db, decomposeCard(number, parsed as Record<string, unknown>))
  }
  const back = readCardRows(db)
  if (back.length !== want.size) throw new Error(`${back.length} cards in the tables, ${want.size} read`) // i18n-ignore: as above
  for (const r of back) if (JSON.stringify(composeCard(r)) !== want.get(r.card.number)) throw new Error(`card #${r.card.number} doesn't come back from the tables as it was saved`) // i18n-ignore: as above
  db.exec('DROP TABLE cards_09')
}
