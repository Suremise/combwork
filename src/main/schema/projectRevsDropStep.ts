import type { DatabaseSync } from 'node:sqlite'

/**
 * The child tables PROJECT_REVS_STEP (projectRevsStep.ts, v31) put its triggers on, written out here as that step has
 * them, so this step drops exactly what it made.
 */
const REV_TABLES = ['card_labels', 'card_links', 'card_context', 'card_comments', 'card_history', 'card_decisions', 'card_holds']

/** v31's triggers raising `project_revs` (cards_epoch_au, which raises only the epoch, stays). */
export const PROJECT_REV_TRIGGERS = [
  'cards_prev_ai', 'cards_prev_au', 'cards_prev_ad', 'card_facts_prev_ai', 'card_facts_prev_au', 'card_facts_prev_ad',
  ...REV_TABLES.flatMap((t) => [`${t}_prev_ai`, `${t}_prev_au`, `${t}_prev_ad`])
]

const EPOCH = 'UPDATE facts_epoch SET g = g + 1;'

/**
 * HI-3306 (boardStore.ts BOARD_MIGRATIONS version 33): `project_revs` goes. HI-3291 kept each project's revision for its
 * queue listings; HI-3296's `queue_revs` replaced it there, and nothing read it after, yet its triggers still raised it
 * on every write to a card's row, a fact or a child table (a comment wrote two rows, not one: tests/cardWrites.test.ts).
 * Its triggers and table are dropped; `facts_epoch` (FactStore's facts cache) stays as it is, its value kept, and the
 * epoch raises v31 made inside the dropped triggers (a card deleted, a fact rewritten or deleted) are made by triggers of
 * their own, as `cards_epoch_au` (a card moved to another project) already was. v31 stays as released, so a new board
 * makes the table and this step drops it again. Safe to run again (IF EXISTS, IF NOT EXISTS), and run in the migration's
 * transaction (db.ts migrate): a failure leaves the board at v32, its triggers whole.
 */
export const PROJECT_REVS_DROP_STEP = { name: 'project revisions dropped', up: dropProjectRevs } as const

export function dropProjectRevs(db: DatabaseSync): void {
  for (const t of PROJECT_REV_TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${t}`)
  db.exec('DROP TABLE IF EXISTS project_revs')
  for (const t of [
    `CREATE TRIGGER IF NOT EXISTS cards_epoch_ad AFTER DELETE ON cards BEGIN ${EPOCH} END`,
    `CREATE TRIGGER IF NOT EXISTS card_facts_epoch_au AFTER UPDATE ON card_facts BEGIN ${EPOCH} END`,
    `CREATE TRIGGER IF NOT EXISTS card_facts_epoch_ad AFTER DELETE ON card_facts BEGIN ${EPOCH} END`
  ]) db.exec(t)
}
