import type { DatabaseSync } from 'node:sqlite'

/**
 * The child tables a window's card is made of, as CARD_REVS_STEP (v1_0.ts) has them: a card's comments, labels, holds…
 * Written out here, since v1_0.ts stays as 1.0.0 released it (tests/combworkMove10.test.ts).
 */
const REV_TABLES = ['card_labels', 'card_links', 'card_context', 'card_comments', 'card_history', 'card_decisions', 'card_holds']

/**
 * HI-3291 (boardStore.ts BOARD_MIGRATIONS version 31): what a cache of a project's board reads is checked against, kept
 * by the database itself, so another Combwork's writes count as Combwork's own do and a rolled-back write undoes its raise:
 * - `project_revs`: each project's revision, raised in the writer's transaction by every write to one of its cards' rows,
 *   facts or the child tables a card is made of (REV_TABLES: comments, labels, holds…), whatever revision the card is at.
 *   A card moving between projects (or a project renamed) raises both. A queue listing kept by it is rebuilt when its own
 *   project changes, not when any card of the board does.
 * - `facts_epoch`: raised whenever facts may have gone or changed hands (a fact deleted or rewritten, a card deleted or
 *   moved to another project), so a cache of facts read by rowid from a high-water mark (FactStore.factsOfKind) reads them
 *   all again: a fact appended above the mark is new only while the epoch is unchanged (a deleted top rowid can be reused).
 * Created only when missing (a board whose later steps are run again takes it again). `project_revs` and its triggers
 * are dropped at v33 (projectRevsDropStep.ts, HI-3306), unread since HI-3296's queue revisions; `facts_epoch` stays.
 */
export const PROJECT_REVS_STEP = { name: 'project revisions', up: addProjectRevs } as const

/** Raises the revision of the project an expression names (none for a null or empty one: a cascade's card already gone). */
const raise = (project: string, when = '1'): string =>
  `INSERT INTO project_revs (project, g) SELECT p, 1 FROM (SELECT ${project} AS p) WHERE p IS NOT NULL AND p <> '' AND (${when}) ON CONFLICT (project) DO UPDATE SET g = g + 1;`

/** Raises the revision of a card's project, by its number. */
const raiseCard = (card: string, when = '1'): string => raise(`(SELECT project FROM cards WHERE number = ${card})`, when)

const EPOCH = 'UPDATE facts_epoch SET g = g + 1;'

/** A table whose rows belong to a card (`card`): every write raises the card's project, both cards' when one moves. */
const cardTriggers = (t: string, extra = ''): string[] => [
  `CREATE TRIGGER IF NOT EXISTS ${t}_prev_ai AFTER INSERT ON ${t} BEGIN ${raiseCard('NEW.card')} END`,
  `CREATE TRIGGER IF NOT EXISTS ${t}_prev_au AFTER UPDATE ON ${t} BEGIN ${raiseCard('OLD.card')} ${raiseCard('NEW.card', 'NEW.card IS NOT OLD.card')} ${extra} END`,
  `CREATE TRIGGER IF NOT EXISTS ${t}_prev_ad AFTER DELETE ON ${t} BEGIN ${raiseCard('OLD.card')} ${extra} END`
]

export function addProjectRevs(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_revs (project TEXT NOT NULL COLLATE NOCASE PRIMARY KEY, g INTEGER NOT NULL) STRICT, WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS facts_epoch (id INTEGER PRIMARY KEY CHECK (id = 1), g INTEGER NOT NULL) STRICT;
    INSERT OR IGNORE INTO facts_epoch (id, g) VALUES (1, 1);
  `)
  const triggers = [
    `CREATE TRIGGER IF NOT EXISTS cards_prev_ai AFTER INSERT ON cards BEGIN ${raise('NEW.project')} END`,
    // Not for the revision triggers' own raise of `rev` (CARD_REVS_STEP), which a child table's write makes: that write
    // raised the project itself.
    `CREATE TRIGGER IF NOT EXISTS cards_prev_au AFTER UPDATE ON cards WHEN NEW.rev = OLD.rev BEGIN ${raise('OLD.project')} ${raise('NEW.project', 'NEW.project IS NOT OLD.project')} END`,
    `CREATE TRIGGER IF NOT EXISTS cards_prev_ad AFTER DELETE ON cards BEGIN ${raise('OLD.project')} ${EPOCH} END`,
    // A card's facts go with it to another project: a cache of either project's facts reads them all again.
    `CREATE TRIGGER IF NOT EXISTS cards_epoch_au AFTER UPDATE OF project ON cards WHEN NEW.project IS NOT OLD.project BEGIN ${EPOCH} END`,
    // Facts: appended ones raise their project; a deleted or rewritten one, the epoch too.
    `CREATE TRIGGER IF NOT EXISTS card_facts_prev_ai AFTER INSERT ON card_facts BEGIN ${raiseCard('NEW.card')} END`,
    ...cardTriggers('card_facts', EPOCH).slice(1),
    ...REV_TABLES.flatMap((t) => cardTriggers(t))
  ]
  for (const t of triggers) db.exec(t)
}
