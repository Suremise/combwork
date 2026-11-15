import type { DatabaseSync } from 'node:sqlite'
import type { FactKind } from '../../shared/workflow/facts'

/**
 * HI-3296 (boardStore.ts BOARD_MIGRATIONS version 32): each project's queue revision, `queue_revs`, what a project's queue
 * listings are kept by (queueControls.ts viewsStamp). It is raised, in the writer's transaction, by every write that raises
 * the project's revision (PROJECT_REVS_STEP, HI-3291) except the writes proven unread by the listings, and by one more:
 *
 * - **Quiet** (left out, QUIET_FACT_KINDS, QUIET_TABLES, QUIET_CARD_COLUMNS): facts `TargetMoved`, `HeadMoved`, `LoopStep`
 *   and `UserComment` (the fold's commentGeneration, which a submit's guard reads), and `CheckRan` not run by the merge
 *   queue (entryTook reads only the queue's own); a card's comments, their archive, its history and its holds (who had it
 *   when, rewritten by a comment on a card in Doing); and a card's row rewritten with only its time, its revision or its
 *   key order (`layout`) changed, which is what a comment or a history line does to it. A listing reads the board through
 *   the workflow's store alone (its cards as CardRecord, which has none of those tables, its facts, its queue tables and
 *   values), and nothing on its path reads them (queueOrder, queueWaitingOn, foldCard's entries, stage,
 *   started, forward and resolves, rulesetOf, recentOutcomes, historyOf, entryTook, cardsInFlight, cardsOpen,
 *   cardsNumbered, openPairs). tests/queueRevs.test.ts holds each against a listing made fresh, in each state it matters in.
 * - **Everything else raises it**: any other fact kind (one added later too), any fact rewritten or deleted, a card's
 *   labels, links, context and decisions, any other column of its row, a card inserted, deleted or moved to another
 *   project (both projects).
 * - **A blocker's projects** (the bug HI-3291's revision had): a queued card shows what it waits for (queueWaitingOn: its
 *   blockers not Done), and a blocker may be another project's. A card whose row changes other than quietly, that is
 *   deleted, or that is inserted (a link to a number not on the board stays, shown as waited for: a card coming back
 *   under it, restored or written by another Combwork, ends that), raises the queue revision of every project with a card
 *   blocked by it; for a delete, before the delete, while the links naming it are still there to read.
 *
 * Created only when missing (a board whose later steps are run again takes it again).
 */
export const QUEUE_REVS_STEP = { name: 'queue revisions', up: addQueueRevs } as const

/** The fact kinds no queue listing reads (a CheckRan only when not the merge queue's: QUEUE_CHECKS_BY). */
export const QUIET_FACT_KINDS = ['TargetMoved', 'HeadMoved', 'LoopStep', 'UserComment'] as const satisfies readonly FactKind[]

/** CheckRan's `by` for the merge queue's own checks (progress.ts CW_RUNS, which entryTook reads): those raise it. */
export const QUEUE_CHECKS_BY = 'Combwork (merge queue)' // i18n-ignore: a run's stored name, never shown

/** The card tables no queue listing reads. */
export const QUIET_TABLES = ['card_comments', 'card_comments_archive', 'card_history', 'card_holds'] as const

/**
 * The card tables whose writes raise it (PROJECT_REVS_STEP's REV_TABLES less the quiet ones): labels and links are the
 * workflow's card (CardRecord's labels and blockedBy); context and decisions are not, but are kept raising it (rare).
 */
export const QUEUE_TABLES = ['card_labels', 'card_links', 'card_context', 'card_decisions'] as const

/**
 * The columns of `cards` a write changing only these leaves quiet: its time, its revision and `layout` (the document's
 * key order, which a hold coming or going changes); no CardRecord field is read from them. Every other column is compared,
 * so the trigger names them all (CARD_COLUMNS): tests/queueRevs.test.ts fails when `cards` has a column it doesn't.
 */
export const QUIET_CARD_COLUMNS = ['updated_at', 'rev', 'layout'] as const

/** The columns of `cards` as this step knows them (all but QUIET_CARD_COLUMNS are compared). */
export const CARD_COLUMNS = [
  'number', 'title', 'description', 'project', 'project_id', 'agent', 'agent_name', 'review_agent', 'review_agent_name', 'review_since', 'col', 'stage',
  'ord', 'blocked', 'archived', 'archived_for', 'archived_batch', 'context_problems', 'pre_workflow', 'created_at', 'created_by', 'updated_at', 'extra',
  'layout', 'kind', 'target', 'paths_declared', 'project_number', 'rev'
] as const

/** Raises the queue revision of the project an expression names (none for a null or empty one). */
const raise = (project: string, when = '1'): string =>
  `INSERT INTO queue_revs (project, q) SELECT p, 1 FROM (SELECT ${project} AS p) WHERE p IS NOT NULL AND p <> '' AND (${when}) ON CONFLICT (project) DO UPDATE SET q = q + 1;`

/** Raises the queue revision of a card's project, by its number. */
const raiseCard = (card: string, when = '1'): string => raise(`(SELECT project FROM cards WHERE number = ${card})`, when)

/** Raises the queue revision of every project with a card blocked by this one (a blocker's change shows in their queues). */
const raiseDependents = (card: string): string =>
  `INSERT INTO queue_revs (project, q) SELECT DISTINCT c.project, 1 FROM card_links l JOIN cards c ON c.number = l.card WHERE l.target = ${card} AND l.kind = 'blockedBy' AND c.project IS NOT NULL AND c.project <> '' ON CONFLICT (project) DO UPDATE SET q = q + 1;`

/** Whether a row update changed a column other than the quiet ones. */
const rowChanged = CARD_COLUMNS.filter((c) => !(QUIET_CARD_COLUMNS as readonly string[]).includes(c))
  .map((c) => `NEW.${c} IS NOT OLD.${c}`)
  .join(' OR ')

// A CheckRan whose data can't be read isn't quiet (CASE: json_extract is never reached for it).
const quietFact = `(NEW.kind IN (${QUIET_FACT_KINDS.map((k) => `'${k}'`).join(', ')}) OR (NEW.kind = 'CheckRan' AND CASE WHEN json_valid(NEW.data) THEN json_extract(NEW.data, '$.by') IS NOT '${QUEUE_CHECKS_BY}' ELSE 0 END))`

/** A table whose rows belong to a card (`card`): every write raises the card's project, both cards' when one moves. */
const cardTriggers = (t: string): string[] => [
  `CREATE TRIGGER IF NOT EXISTS ${t}_qrev_ai AFTER INSERT ON ${t} BEGIN ${raiseCard('NEW.card')} END`,
  `CREATE TRIGGER IF NOT EXISTS ${t}_qrev_au AFTER UPDATE ON ${t} BEGIN ${raiseCard('OLD.card')} ${raiseCard('NEW.card', 'NEW.card IS NOT OLD.card')} END`,
  `CREATE TRIGGER IF NOT EXISTS ${t}_qrev_ad AFTER DELETE ON ${t} BEGIN ${raiseCard('OLD.card')} END`
]

export function addQueueRevs(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS queue_revs (project TEXT NOT NULL COLLATE NOCASE PRIMARY KEY, q INTEGER NOT NULL) STRICT, WITHOUT ROWID;')
  const triggers = [
    `CREATE TRIGGER IF NOT EXISTS cards_qrev_ai AFTER INSERT ON cards BEGIN ${raise('NEW.project')} ${raiseDependents('NEW.number')} END`,
    // Not for the revision triggers' own raise of `rev` (CARD_REVS_STEP), nor a rewrite changing only quiet columns.
    `CREATE TRIGGER IF NOT EXISTS cards_qrev_au AFTER UPDATE ON cards WHEN NEW.rev = OLD.rev AND (${rowChanged}) BEGIN ${raise('OLD.project')} ${raise('NEW.project', 'NEW.project IS NOT OLD.project')} ${raiseDependents('NEW.number')} END`,
    // Before the delete: the links naming it are still there (another card's link to it has no foreign key, but its own
    // cascade, and a delete's clean-up of references, may run in the same statement).
    `CREATE TRIGGER IF NOT EXISTS cards_qrev_bd BEFORE DELETE ON cards BEGIN ${raise('OLD.project')} ${raiseDependents('OLD.number')} END`,
    `CREATE TRIGGER IF NOT EXISTS card_facts_qrev_ai AFTER INSERT ON card_facts WHEN NOT ${quietFact} BEGIN ${raiseCard('NEW.card')} END`,
    // A fact rewritten or deleted raises it whatever its kinds, before and after.
    `CREATE TRIGGER IF NOT EXISTS card_facts_qrev_au AFTER UPDATE ON card_facts BEGIN ${raiseCard('OLD.card')} ${raiseCard('NEW.card', 'NEW.card IS NOT OLD.card')} END`,
    `CREATE TRIGGER IF NOT EXISTS card_facts_qrev_ad AFTER DELETE ON card_facts BEGIN ${raiseCard('OLD.card')} END`,
    ...QUEUE_TABLES.flatMap((t) => cardTriggers(t))
  ]
  for (const t of triggers) db.exec(t)
}
