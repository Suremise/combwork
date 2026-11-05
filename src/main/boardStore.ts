import { AsyncLocalStorage } from 'async_hooks'
import { createHash } from 'crypto'
import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'original-fs'
import { mkdir, writeFile } from 'original-fs/promises'
import { basename, join } from 'path'
import type { StatementSync } from 'node:sqlite'
import { app } from 'electron'
import { CW_DIR } from '../shared/defaults'
import { msg } from '../shared/i18n'
import type { ArchiveBatch, BoardState } from '../shared/types'
import { cardField, composeCard, decomposeCard, readCardRows, writeCardChanges, writeCardRows, type CardPart, type CardRow, type CardRows } from './schema/cardRows'
import { moveCardsIntoTables } from './schema/cardsStep'
import { addKey, cardKeys as keysOfCards, cardOfKey, cardPlace, changeKey, currentKeys, keysHeld, KEYS_STEP, moveKeys, movedCardNames, numberCard } from './schema/keysStep'
import { LANE_RECORD_STEP, moveLaneRecords } from './schema/laneRecordStep'
import { ACTIONS_DELIVERED_STEP, ASSISTANT_CHANGES_STEP, CARD_ATTACHMENTS_STEP, CARD_REVS_STEP, CARD_SEARCH_STEP, CARDS_STEP, FACTS_STEP, QUERIES, QUEUE_PAUSE_BY_STEP, QUEUE_PAUSE_MESSAGE_STEP, QUEUE_PAUSE_STATE_STEP, QUEUE_RUNNERS_STEP, COPIES_STEP, QUEUE_SEEN_STEP, SESSION_LEASES_STEP, SKILL_COPIES_STEP, SLOTS_STEP, UNDO_OUTCOMES_STEP } from './schema/v1_0'
import { NAMES_STEP } from './schema/namesStep'
import { VALUES_STEP } from './schema/valuesStep'
import { backupsOf, DbInUseError, fileSchemaVersion, groupBackupFamily, isIoError, openDb, OPENABLE_WAIT_MS, schemaVersion, soleCopy, untilOpenable, type Db, type Migration, type PendingGroup } from './db'
import { checkpointsReleased, checkpointWhenIdle, timedCommit } from './walCheckpoint'
import { beginWrite, countedWrite } from './dbWrites'
import { timedStep } from './stallWork'
import { moveStores, STORES_STEP } from './schema/storeCodec'
import { emit } from './events'
import { placeKey, realPath, withFileLock } from './fsutil'
import { trash } from './trash'
import { combworkError } from './combworkError'
import { createLogger, userText } from './logger'
import { assertAdmitted, assertPlaceAdmitted, isAdmitted, isRefusal } from './openingFence'
import { HEARTBEAT_MS, othersPresent, profileId, removePresence, writePresence } from './presence'
import { moveStoreRows } from './schema/sessionDeliveryTables'
import type { WorkspaceService } from './workspace'
import { CATEGORY_STAGE, type Category, type StageId } from '../shared/workflow/facts'

const log = createLogger('board')

/**
 * The workspace's task board in SQLite (#1017, design on the card): `.combwork/combwork.db`. Since 1.0's cards step (#1209) a
 * card is a row of typed columns in `cards` with its lists in child tables (labels, links, context, comments, history,
 * decisions, holds; schema/v1_0.ts), and every reader is given the card's JSON document composed from them, byte for
 * byte the document it was saved as (schema/cardRows.ts), so the Agent API's JSON is unchanged. Before the upgrade (a
 * 0.9 board, read-only) a row is the card's document. Every write goes through `boardWrite`: the board's lock, one
 * transaction, and one `tasks-changed` after it commits. Only this module reads or writes cards' rows.
 */

export const DB_FILE = 'combwork.db'
/** The folder the cards' files were in before (#1017), and what an older Hive still looks at. */
const TASKS = 'tasks'

/** The group of the 1.0 upgrade's steps (#1207): every P3 step that changes the schema is in it. */
const UPGRADE_GROUP_ID = '1.0'

/** The board's schema, step by step (db.ts runs the steps a file hasn't had). */
/**
 * board_meta's highest card number from before 1.0 (#1218): the cards the upgrade's adoption handles (workflow/adoption.ts).
 * Set by the 1.0 group's last step, in the upgrade's transaction (0 on a board made by 1.0, which has none), and by the
 * import of card files from before 0.9.
 */
export const ADOPTION_UPTO = 'adoption_upto'
/** The highest card number on the board, as board_meta's ADOPTION_UPTO keeps it. */
const markAdoptionUpto = (db: Db['writer']): void => {
  db.prepare("INSERT INTO board_meta (key, value) SELECT ?, CAST(COALESCE(MAX(number), 0) AS TEXT) FROM cards WHERE 1 ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(ADOPTION_UPTO) // i18n-ignore: SQL
}

export const BOARD_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'cards',
    up: (db) =>
      db.exec(`
        CREATE TABLE cards (
          number     INTEGER PRIMARY KEY,
          doc        TEXT NOT NULL,
          project    TEXT    GENERATED ALWAYS AS (json_extract(doc, '$.project'))   STORED,
          project_id TEXT    GENERATED ALWAYS AS (json_extract(doc, '$.projectId')) STORED,
          col        TEXT    GENERATED ALWAYS AS (json_extract(doc, '$.column'))    STORED,
          ord        REAL    GENERATED ALWAYS AS (json_extract(doc, '$.order'))     STORED,
          agent      TEXT    GENERATED ALWAYS AS (json_extract(doc, '$.agent'))     STORED,
          archived   INTEGER GENERATED ALWAYS AS (coalesce(json_extract(doc, '$.archived') = 1, 0)) STORED,
          updated_at TEXT    GENERATED ALWAYS AS (json_extract(doc, '$.updatedAt')) STORED
        );
        CREATE INDEX cards_place ON cards(archived, col, ord);
        CREATE INDEX cards_project ON cards(project_id, archived);
        CREATE INDEX cards_agent ON cards(agent) WHERE agent IS NOT NULL;
        CREATE INDEX cards_updated ON cards(updated_at);
        CREATE TABLE board_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        CREATE TABLE archive_batches (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, doc TEXT NOT NULL) STRICT;
      `)
  },
  {
    // #1018: the workspace's other stores (lanes, watches, deliveries), a row each of their entries (storeRows.ts).
    version: 2,
    name: 'store_rows',
    up: (db) =>
      db.exec(`
        CREATE TABLE store_rows (
          store TEXT NOT NULL,
          scope TEXT NOT NULL,
          key   TEXT NOT NULL,
          ord   INTEGER NOT NULL,
          doc   TEXT NOT NULL,
          PRIMARY KEY (store, scope, key)
        ) STRICT, WITHOUT ROWID;
        CREATE TABLE store_meta (
          store TEXT NOT NULL,
          scope TEXT NOT NULL,
          key   TEXT NOT NULL,
          value TEXT NOT NULL,
          PRIMARY KEY (store, scope, key)
        ) STRICT, WITHOUT ROWID;
      `)
  },
  {
    // #1207: the first step of the 1.0 upgrade (SPEC §16.17). The group's steps run as one, asked first, with the file
    // locked to this Combwork and a copy of the 0.9 board kept; P3's tables follow it, each the next version, in the group.
    version: 3,
    name: '1.0 upgrade',
    group: UPGRADE_GROUP_ID,
    up: (db) => db.prepare("INSERT INTO board_meta (key, value) VALUES ('format', '1.0') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run() // i18n-ignore: SQL
  },
  {
    // #1212: lanes, watches and metrics out of `store_rows` into their typed tables (schema/storeCodec.ts, storeTables.ts),
    // their values into board_meta.
    version: 4,
    name: STORES_STEP.name,
    group: UPGRADE_GROUP_ID,
    up: (db) => moveStores(db)
  },
  {
    // #1209: cards out of their JSON document into typed columns and child tables (#1208's schema, cardRows.ts's contract).
    version: 5,
    name: CARDS_STEP.name,
    group: UPGRADE_GROUP_ID,
    up: moveCardsIntoTables
  },
  {
    // #1211: sessions and deliveries out of store_rows, into their typed tables (schema/sessionDeliveryTables.ts); the last of
    // store_rows' stores, so store_rows goes with it (store_meta stays: sessions' and deliveries' values).
    version: 6,
    name: 'sessions and deliveries in tables', // i18n-ignore: a schema step's name, recorded in schema_version
    group: UPGRADE_GROUP_ID,
    up: (db) => {
      const n = moveStoreRows(db)
      log.info(`moved ${n.sessions} session record(s) and ${n.deliveries} deliveries into their tables`)
    }
  },
  {
    // #1215: the fact log, durable actions and rulesets (SPEC §16.4), and what the runtime keeps of a card and a project
    // beside them (workflow/factStore.ts), written inside boardWrite.
    version: 7,
    name: FACTS_STEP.name,
    group: UPGRADE_GROUP_ID,
    up: (db) => {
      for (const sql of FACTS_STEP.ddl) db.exec(sql)
      // The cards from before 1.0, for the adoption that follows the upgrade (#1218): in its transaction, so no card made
      // by 1.0 is ever among them.
      markAdoptionUpto(db)
    }
  },
  {
    // #1219: project keys (#704), each card's number in its project (an existing card keeps its own), aliases.
    version: 8,
    name: KEYS_STEP.name,
    group: UPGRADE_GROUP_ID,
    up: (db) => moveKeys(db)
  },
  {
    // #1291: one lane record. The runtime's lanes and a card's lane columns retired into lanes.ts's tables, with what
    // the runtime keeps of a lane beside them (schema/laneRecordStep.ts).
    version: 9,
    name: LANE_RECORD_STEP.name,
    group: UPGRADE_GROUP_ID,
    up: (db) => {
      const n = moveLaneRecords(db)
      if (n.lanes || n.dropped) log.info(`moved ${n.lanes} runtime lane(s) into the lanes (${n.added} new), left out ${n.dropped} with no cards`)
    }
  },
  {
    // #1266: an action's delivery is recorded by its row in `deliveries` (the action's id, unique), and a notice counts its
    // tries instead; `card_actions.delivered` (#1215's stand-in) goes. And what lane notices have told (workflowNotices.ts).
    version: 10,
    name: ACTIONS_DELIVERED_STEP.name,
    group: UPGRADE_GROUP_ID,
    up: (db) => {
      for (const sql of ACTIONS_DELIVERED_STEP.ddl) db.exec(sql)
    }
  },
  {
    // #1237: the board's full-text search, an FTS5 index of the cards' text kept in step by triggers (schema/v1_0.ts).
    version: 11,
    name: CARD_SEARCH_STEP.name,
    group: UPGRADE_GROUP_ID,
    up: (db) => {
      for (const sql of CARD_SEARCH_STEP.ddl) db.exec(sql)
    }
  },
  {
    // #1282: the Assistant's changes, with what each replaced, for undo (schema/v1_0.ts, assistantUndo.ts).
    version: 12,
    name: ASSISTANT_CHANGES_STEP.name,
    group: UPGRADE_GROUP_ID,
    up: (db) => {
      for (const sql of ASSISTANT_CHANGES_STEP.ddl) db.exec(sql)
    }
  },
  {
    // #1283: what undo did with each field of a change, for the panel's Undone, Partly undone and Kept.
    version: 13,
    name: UNDO_OUTCOMES_STEP.name,
    group: UPGRADE_GROUP_ID,
    up: (db) => {
      for (const sql of UNDO_OUTCOMES_STEP.ddl) db.exec(sql)
    }
  },
  {
    // #1360: the merge queue's runner, one per project and target across Combworks, its processes and its worktrees
    // (workflow/queueRunner.ts), and a queue pause's process.
    version: 14,
    name: QUEUE_RUNNERS_STEP.name,
    group: UPGRADE_GROUP_ID,
    up: (db) => {
      for (const sql of QUEUE_RUNNERS_STEP.ddl) db.exec(sql)
    }
  },
  {
    // #1350: a queue pause's message, what git or a signer said (an index lock, a signing error).
    version: 15,
    name: QUEUE_PAUSE_MESSAGE_STEP.name,
    group: UPGRADE_GROUP_ID,
    up: (db) => {
      for (const sql of QUEUE_PAUSE_MESSAGE_STEP.ddl) db.exec(sql)
    }
  },
  {
    // #1353: who paused a merge queue (the user, the Assistant; none: Combwork's own pause) and when.
    version: 16,
    name: QUEUE_PAUSE_BY_STEP.name,
    group: UPGRADE_GROUP_ID,
    up: (db) => {
      for (const sql of QUEUE_PAUSE_BY_STEP.ddl) db.exec(sql)
    }
  },
  {
    // #1351: the state an advance into a checked-out target was left in (its terminal pause): the folder, branch, ref,
    // revisions and journal phase, each listed file's side, and the commands that finish or undo it.
    version: 17,
    name: QUEUE_PAUSE_STATE_STEP.name,
    group: UPGRADE_GROUP_ID,
    up: (db) => {
      for (const sql of QUEUE_PAUSE_STATE_STEP.ddl) db.exec(sql)
    }
  },
  {
    // #1356: when the user saw a merge queue's returned card (the Progress panel's Merges tab).
    version: 18,
    name: QUEUE_SEEN_STEP.name,
    group: UPGRADE_GROUP_ID,
    up: (db) => {
      for (const sql of QUEUE_SEEN_STEP.ddl) db.exec(sql)
    }
  },
  {
    // #1429: a project's slots and their leases (slots.ts), one open lease per slot and per agent kept by SQLite itself.
    version: 19,
    name: SLOTS_STEP.name,
    group: UPGRADE_GROUP_ID,
    up: (db) => {
      for (const sql of SLOTS_STEP.ddl) db.exec(sql)
    }
  },
  {
    // #1435: a project's review and check copies and their leases (copies.ts), one lease not freed per copy.
    version: 20,
    name: COPIES_STEP.name,
    group: UPGRADE_GROUP_ID,
    up: (db) => {
      for (const sql of COPIES_STEP.ddl) db.exec(sql)
    }
  },
  {
    // #1431: which skill copies Combwork made in which folder (skillCopies.ts), so a clean-up removes only its own.
    version: 21,
    name: SKILL_COPIES_STEP.name,
    group: UPGRADE_GROUP_ID,
    up: (db) => {
      for (const sql of SKILL_COPIES_STEP.ddl) db.exec(sql)
    }
  },
  {
    // #1434: the slot lease a session is bound to, and a lease's slot head when it ended (agentFolders.ts).
    version: 22,
    name: SESSION_LEASES_STEP.name,
    group: UPGRADE_GROUP_ID,
    up: (db) => {
      for (const sql of SESSION_LEASES_STEP.ddl) db.exec(sql)
    }
  },
  {
    // HI-1700: files kept with a card (cardAttachments.ts).
    version: 23,
    name: CARD_ATTACHMENTS_STEP.name,
    group: UPGRADE_GROUP_ID,
    up: (db) => {
      for (const sql of CARD_ATTACHMENTS_STEP.ddl) db.exec(sql)
    }
  },
  {
    // HI-1715: each card's revision and the board's mark, kept by triggers, so the window is sent only what changed.
    version: 24,
    name: CARD_REVS_STEP.name,
    group: UPGRADE_GROUP_ID,
    up: (db) => {
      for (const sql of CARD_REVS_STEP.ddl) db.exec(sql)
    }
  },
  {
    // HI-2587, the names upgrade: what the board kept under Hive's names takes Combwork's (comments' `hive_text` column,
    // the 0.9 import's record's old version key). In the 1.0 group, near its end: a board 1.0 or an RC upgraded takes it
    // unasked (as HI-1718's later steps), a 0.9 board with its upgrade.
    version: 25,
    name: NAMES_STEP.name,
    group: UPGRADE_GROUP_ID,
    up: (db) => {
      // Only with 1.0's tables (a board made before them, its group not run, has no comments' column to rename).
      const cols = (db.prepare("SELECT name FROM pragma_table_info('card_comments')").all() as { name: string }[]).map((c) => c.name) // i18n-ignore: SQL
      if (cols.includes('hive_text')) for (const sql of NAMES_STEP.ddl) db.exec(sql)
      db.exec("UPDATE board_meta SET value = json_remove(json_set(value, '$.appVersion', json_extract(value, '$.hiveVersion')), '$.hiveVersion') WHERE key = 'imported' AND json_valid(value) AND json_type(value, '$.hiveVersion') IS NOT NULL") // i18n-ignore: SQL
    }
  },
  {
    // HI-2598, the names upgrade's stored values (its design HI-2598/s9 §2): what 1.0 and the release candidates stored
    // under Hive's names (a fact's actor, who merges, the rulesets compiled from it, a lane's builder, Combwork's own
    // deliveries…) takes Combwork's, once (schema/valuesStep.ts). The 1.0 group's last step: taken unasked as 25 is.
    version: 26,
    name: VALUES_STEP.name,
    group: UPGRADE_GROUP_ID,
    up: (db) => {
      const changed = VALUES_STEP.up(db)
      if (Object.keys(changed).length) log.info(`names: values converted ${JSON.stringify(changed)}`)
    }
  }
]

/** What the import from files recorded (board_meta `imported`). */
interface Imported {
  at: string
  cards: number
  damaged: string[]
  appVersion: string
  /** The folder the files were moved to, as a backup. */
  folder: string
  /** The files' folder couldn't be renamed yet (held open): tried again at the next open. */
  pendingRename?: boolean
}

interface Board {
  /** The workspace folder, as the workspace has it. */
  path: string
  /** Its real location (`placeKey`) as it opened: another spelling's board of the same folder is closed with it (#1402). */
  place: string
  /**
   * Its `.combwork` at that real location, as it opened: every write and removal on disk for it (the heartbeat, the stub, the
   * presence marker's removal) goes there, never through a spelling that may point elsewhere by then (#1402).
   */
  combwork: string
  db: Db
  /** Its cards are still JSON documents, a row each (a 0.9 board waiting for its upgrade to 1.0, read-only), not 1.0's tables. */
  legacy: boolean
  /** Statements made once. */
  version: StatementSync
  /** The writer's data_version when last looked at: another process's commit changes it (#1017's poll). */
  dataVersion: number
  poll: NodeJS.Timeout
  /** The presence marker's heartbeat (presence.ts). */
  presence: NodeJS.Timeout
  /** This process's changes of the board committed since it was opened (boardRevision): its cards' and lanes'. */
  revision: number
  /** Opened for a lease (leaseDb) and not used since by anything that keeps it open: closed as its last lease ends. */
  transient: boolean
  /** The leases on this connection not ended yet (#1383): while any is, closing the board leaves its connection open for them. */
  leases: number
  /** Closed while leased (closeBoard): no longer the workspace's board, its connection closed as its last lease ends. */
  detached: boolean
  /** Which opening of a board this is, in this process (HI-1715): a window's cursor on another opening's marks is void. */
  generation: number
  /** Changes this process committed to it, quiet ones too (HI-1909): `boardReadToken`'s part for this process's writes. */
  commits: number
}

/** Boards opened so far in this process: each opening's `generation`. */
let openings = 0

const boards = new Map<string, Board>()

/** For tests: a card whose save fails (as a full disk would); a folder Windows won't rename (something has a file in it open). */
export const boardTestHooks: {
  failPut: ((n: number) => boolean) | null
  refuseRename: ((from: string) => boolean) | null
  /** The 1.0 upgrade's question answered before it is asked (as CW_TEST_BOARD_UPGRADE does for a test copy). */
  upgradeAnswer: 'yes' | 'no' | null
  /** Runs while the upgrade holds the file's exclusive lock, its steps committed. */
  whileUpgrading: (() => void) | null
  /** Told as a workspace's open starts waiting for its board to be openable (HI-2199). */
  openableWait: ((path: string) => void) | null
} = { failPut: null, refuseRename: null, upgradeAnswer: null, whileUpgrading: null, openableWait: null }
const keyOf = (path: string): string => path.toLowerCase()

/** What the board tells the user about the import (index.ts shows it as a notice). */
export type BoardNotice = { kind: 'imported'; cards: number; damaged: string[]; folder: string } | { kind: 'setAside'; cards: number; folder: string }
let notify: (path: string, n: BoardNotice) => void = () => undefined
export function onBoardNotice(fn: (path: string, n: BoardNotice) => void): void {
  notify = fn
}

const M = {
  noWorkspace: msg({ id: 'board.error.noWorkspace', defaultMessage: 'No workspace is open', description: 'An error: the task board needs an open workspace, and there is none.' }),
  newer: msg({ id: 'board.error.newer', defaultMessage: 'This board was saved by a newer version of Combwork. It is shown read-only: update Combwork to change it.', description: "An error: the workspace's task board was saved by a newer Combwork, whose format this version doesn't know; cards can be read but not changed." }),
  upgradeFirst: msg({ id: 'board.error.upgradeFirst', defaultMessage: "This board is from Combwork 0.9: it is read-only until it is upgraded to 1.0 (Upgrade… on the board's banner).", description: "An error: the workspace's task board hasn't been upgraded to Hive 1.0's format yet (the user was asked and said not now), so cards can be read but not changed. Upgrade… is the button on the banner above the board." }),
  upgradeFirstStart: msg({ id: 'board.error.upgradeFirstStart', defaultMessage: 'This workspace is from Combwork 0.9: upgrade it to 1.0 before starting agents (Upgrade… on the banner at the top of the window).', description: "An error: an agent (or the Assistant) can't start while the workspace's data waits for its upgrade to Hive 1.0's format (the user said Not Now): Combwork couldn't record its session. Upgrade… is the button on the banner at the top of the window." }),
  stopAgentsFirst: msg({ id: 'board.error.stopAgentsFirst', defaultMessage: "Stop this workspace's agents and its Assistant first: once the 0.9 board is back, Combwork can't record them.", description: "An error from Help → Restore the 0.9 Board Backup…: agents of the workspace are running or starting; the board put back is read-only in this Combwork, so their sessions couldn't be recorded. Nothing was changed." }),
  inUse: msg({ id: 'board.error.inUse', defaultMessage: 'Another Combwork has this workspace open: close it first.', description: "An error: the board can't be upgraded to 1.0 (or its 0.9 backup put back) while another copy of Combwork (an older version, or another profile) has the workspace open. Nothing was changed." }),
  noBackup: msg({ id: 'board.error.noBackup', defaultMessage: 'There is no 0.9 board backup to put back: this board was never upgraded to 1.0 here.', description: "An error from Help → Restore the 0.9 Board Backup…: no copy of the board from before its upgrade to Hive 1.0 is kept in the workspace." }),
  unavailable: msg({ id: 'board.error.unavailable', defaultMessage: "The board couldn't be opened: {error}", description: "An error: the workspace's task board database couldn't be opened or its cards couldn't be moved into it; {error} says why (from the system, often in English). Nothing was lost: the cards are still where they were." })
}

const stamp = (): string => new Date().toISOString().replace(/[:.]/g, '-')

/** The highest card number among card files' names, damaged files' too: none of them is ever given to another card. */
const highestName = (names: string[]): number => names.reduce((m, f) => Math.max(m, Number(f.slice(0, -5)) || 0), 0)

const cardFiles = (dir: string): string[] => {
  try {
    return readdirSync(dir).filter((f) => /^\d+\.json$/.test(f))
  } catch {
    return []
  }
}

/** A card file's content, parsed: null when it isn't a card (not JSON, or not an object). */
function parseCard(file: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'))
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

function readJsonFile<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

const meta = (db: Db['writer'], key: string): string | null => (db.prepare('SELECT value FROM board_meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null // i18n-ignore: SQL
const setMeta = (db: Db['writer'], key: string, value: string): void => void db.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value) // i18n-ignore: SQL

/** The next card number: past the one kept and every card's. */
function nextOf(db: Db['writer']): number {
  const saved = Number(meta(db, 'next')) || 1
  const highest = (db.prepare('SELECT max(number) AS m FROM cards').get() as { m: number | null }).m ?? 0 // i18n-ignore: SQL
  return Math.max(saved, highest + 1)
}

/** Renames a folder, retried a few times at once (Windows refuses while something has a file in it open); false if it never went. */
function renameNow(from: string, to: string): boolean {
  if (boardTestHooks.refuseRename?.(from)) return false
  for (let i = 0; i < 5; i++) {
    try {
      renameSync(from, to)
      return true
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') break
    }
  }
  return false
}

/**
 * Moves the cards' files into a new database (#1017), once, in one transaction: every `<n>.json` (never .bak, .tmp or
 * anything else) as its text was, board.json's next number and the archive batches. Checked before it commits: as many
 * rows as card files read, each with its file's number, column and archived. A file that isn't a card is left where it
 * is (in the backup folder after the move) and named. Then the folder becomes `tasks.imported-<time>`, kept as a backup.
 */
function importFiles(b: Board, combwork: string, appVersion: string): void {
  const db = b.db.writer
  const dir = join(combwork, TASKS)
  const names = cardFiles(dir)
  const cards: { n: number; doc: Record<string, unknown> }[] = []
  const damaged: string[] = []
  for (const f of names) {
    const doc = parseCard(join(dir, f))
    if (doc) cards.push({ n: Number(f.slice(0, -5)), doc })
    else damaged.push(f)
  }
  const board = readJsonFile<{ next?: unknown }>(join(dir, 'board.json'), {})
  const batches = readJsonFile<{ batches?: unknown }>(join(dir, 'archive-batches.json'), {})
  const folder = `${TASKS}.imported-${stamp()}`
  const t0 = performance.now()
  const record: Imported = { at: new Date().toISOString(), cards: cards.length, damaged, appVersion, folder, pendingRename: names.length > 0 || existsSync(join(dir, 'board.json')) || existsSync(join(dir, 'archive-batches.json')) }
  timedStep(`db begin ${DB_FILE}`, () => db.exec('BEGIN IMMEDIATE'))
  try {
    for (const c of cards) writeCardRows(db, decomposeCard(c.n, c.doc))
    // Cards from before 1.0 keep their number in their project (#1219: #1061 is HI-1061).
    db.exec("UPDATE cards SET project_number = number WHERE project_id IS NOT NULL AND project_id != ''") // i18n-ignore: SQL
    // Past every card file's number, a damaged one's too (it is kept, and may be mended): as the old allocator was.
    setMeta(db, 'next', String(Math.max(Number(board.next) || 1, highestName(names) + 1)))
    const ins = db.prepare('INSERT OR IGNORE INTO archive_batches (id, doc) VALUES (?, ?)') // i18n-ignore: SQL
    if (Array.isArray(batches.batches)) for (const x of batches.batches) if (x && typeof x === 'object' && typeof (x as ArchiveBatch).id === 'string') ins.run((x as ArchiveBatch).id, JSON.stringify(x))
    // Checked before it commits: every card read is there, its document as its file had it.
    const rows = readCardRows(db)
    if (rows.length !== cards.length) throw new Error(`${rows.length} cards in the database, ${cards.length} card files read`) // i18n-ignore: an internal check's error, logged and quoted as the reason in board.error.unavailable
    const byN = new Map(rows.map((r) => [r.card.number, r]))
    for (const c of cards) {
      const r = byN.get(c.n)
      if (!r || JSON.stringify(composeCard(r)) !== JSON.stringify(c.doc)) throw new Error(`card #${c.n} isn't in the database as its file has it`) // i18n-ignore: an internal check's error, logged and quoted as the reason in board.error.unavailable
    }
    setMeta(db, 'imported', JSON.stringify(record))
    // Cards from before 0.9: the adoption marks them as from before 1.0 too (#1218).
    if (!meta(db, 'adoption')) markAdoptionUpto(db)
    db.exec('COMMIT')
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw e
  }
  log.info(`moved ${cards.length} card(s) from ${userText(dir)} into ${DB_FILE} in ${Math.round(performance.now() - t0)} ms${damaged.length ? `; ${damaged.length} file(s) that aren't cards left in the folder: ${damaged.join(', ')}` : ''}`)
  if (cards.length || damaged.length) notify(b.path, { kind: 'imported', cards: cards.length, damaged, folder })
  finishMove(b, combwork, record)
}

/** Renames the old folder to its backup name (or, refused, tries again at the next open). */
function finishMove(b: Board, combwork: string, record: Imported): void {
  const dir = join(combwork, TASKS)
  if (record.pendingRename && existsSync(dir)) {
    if (!renameNow(dir, join(combwork, record.folder))) {
      log.warn(`couldn't rename ${userText(dir)} to ${record.folder} (held open): tried again at the next open`)
      return
    }
    log.info(`the card files are kept in ${userText(join(combwork, record.folder))}`)
  }
  if (record.pendingRename) setMeta(b.db.writer, 'imported', JSON.stringify({ ...record, pendingRename: false }))
}

/** Where cards an older Hive saved in the stub are set aside, intact, for the user to review (Darren, 17 Oct). */
export const SET_ASIDE = `${TASKS}.set-aside`

/**
 * The numbers of the cards set aside for the user to review (#1044; those an older Hive saved in the stub 0.9 to 1.0
 * left, which the names upgrade sets aside: nameUpgradeFiles.ts moveOldStub, HI-2594) are never given to new cards: the
 * next number is moved past them at each open, in the board's own write. Reads only the set-aside folder.
 */
function keepSetAsideNumbers(b: Board, combwork: string): void {
  let names: string[]
  try {
    names = readdirSync(join(combwork, SET_ASIDE)).filter((f) => SET_ASIDE_NAME.test(f))
  } catch {
    return
  }
  const highest = names.reduce((m, f) => Math.max(m, Number(SET_ASIDE_NAME.exec(f)![1])), 0)
  const db = b.db.writer
  if (highest >= nextOf(db)) setMeta(db, 'next', String(highest + 1))
}

/** Tells the user cards an older version saved were set aside (the names upgrade, HI-2594): the board's notice. */
export function tellSetAside(path: string, cards: number): void {
  log.info(`${cards} card file(s) an older Hive saved set aside in ${SET_ASIDE}`)
  notify(path, { kind: 'setAside', cards, folder: SET_ASIDE })
}

/** A set-aside file's name as it is given (moveOldStub): `<n>.json`, or `<n>.<time>-<i>.json` beside one of that name. */
const SET_ASIDE_NAME = /^(\d+)(?:\.[0-9TZ-]+)?\.json$/
const textHash = (text: string): string => createHash('sha256').update(text).digest('hex')

/**
 * The files set aside in `.combwork/tasks.set-aside` (#1044), oldest number first: each one's name, the number its name
 * gives and its text (null when it can't be read). One already added to the board (its content recorded as added, its
 * file not moved yet: Windows held it) isn't listed, and goes to the Recycle Bin now.
 */
export function setAsideFiles(ws: WorkspaceService): { file: string; number: number; text: string | null }[] {
  if (!ws.path) return []
  const dir = join(ws.path, CW_DIR, SET_ASIDE)
  let names: string[]
  try {
    names = readdirSync(dir).filter((f) => SET_ASIDE_NAME.test(f))
  } catch {
    return []
  }
  const b = boardOf(ws.path)
  const added = new Set<string>(JSON.parse(meta(b.db.writer, 'setAsideAdded') ?? '[]') as string[])
  const out: { file: string; number: number; text: string | null }[] = []
  for (const file of names) {
    let text: string | null = null
    try {
      text = readFileSync(join(dir, file), 'utf8')
    } catch (e) {
      log.warn(`couldn't read ${file} in ${SET_ASIDE}`, e)
    }
    if (text !== null && added.has(textHash(text))) {
      removeAdded(dir, file)
      continue
    }
    out.push({ file, number: Number(SET_ASIDE_NAME.exec(file)![1]), text })
  }
  return out.sort((a, c) => a.number - c.number || (a.file < c.file ? -1 : 1))
}

/** The path of a set-aside file named by the window: only a name of the folder's own form, never a path out of it. */
export function setAsideFile(ws: WorkspaceService, file: string): string | null {
  if (!ws.path || !SET_ASIDE_NAME.test(file)) return null
  const p = join(ws.path, CW_DIR, SET_ASIDE, file)
  return existsSync(p) ? p : null
}

/**
 * A set-aside file's card was added to the board (inside boardWrite): its content is recorded as added in the same
 * transaction, so it is never listed or added again, and its file moved to the Recycle Bin once the change commits (or,
 * held, at the next listing).
 */
export function setAsideAdded(ws: WorkspaceService, file: string, text: string): void {
  writeOp(ws, (b) => {
    const db = b.db.writer
    const added = new Set<string>(JSON.parse(meta(db, 'setAsideAdded') ?? '[]') as string[])
    added.add(textHash(text))
    setMeta(db, 'setAsideAdded', JSON.stringify([...added]))
  })
  const dir = join(ws.path!, CW_DIR, SET_ASIDE)
  afterBoardWrite(ws, () => removeAdded(dir, file))
}

/** A set-aside file whose card is on the board goes to the Recycle Bin (#1044 round 1): the older Hive's copy stays recoverable. */
function removeAdded(dir: string, file: string): void {
  const p = join(dir, file)
  // Once: a listing while its move is under way leaves it to that move.
  if (removing.has(p)) return
  removing.add(p)
  trash(p)
    .catch((e) => log.warn(`couldn't move ${file} from ${SET_ASIDE} to the Recycle Bin (its card is on the board): tried again later`, e))
    .finally(() => removing.delete(p))
}
const removing = new Set<string>()

const appVersion = (): string => {
  try {
    return app.getVersion()
  } catch {
    return '0.0.0'
  }
}

/**
 * Why a workspace's board couldn't be opened (its import failed): every use says so, and nothing was moved. With the place
 * it was tried at, as it was (#1395: closing the workspace clears it by that, never by its spelling resolved again).
 */
const failures = new Map<string, { error: Error; place: string }>()

/**
 * The workspace's board, opened (and moved in from its files, the first time) when first used. Synchronous, so nothing
 * reads the board before its cards are in. Throws when it couldn't be opened, saying why; the cards' files are then
 * as they were.
 */
function boardOf(path: string, transient = false): Board {
  const key = keyOf(path)
  const open = boards.get(key)
  // Kept open only for a workspace a window holds (#1395): late work of one closed (or never opened) is refused, also
  // when a lease has its connection open now (a store's last save), which it neither borrows nor comes to own.
  if (open) {
    if (!transient) assertPlaceAdmitted(open.place)
    return open
  }
  if (!transient) assertAdmitted(join(path, CW_DIR, DB_FILE))
  const failed = failures.get(key)?.error
  if (failed) throw combworkError(M.unavailable, { error: failed.message }, { kind: 'conflict' })
  try {
    const b = openBoard(path, false)
    b.transient = transient
    return b
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e))
    failures.set(key, { error: err, place: placeKey(path) })
    log.error(`opening the board of ${userText(path)}${isIoError(e) ? ` (SQLite code ${(e as { errcode?: number }).errcode})` : ''}`, e)
    throw combworkError(M.unavailable, { error: err.message }, { kind: 'conflict' })
  }
}

/**
 * Before a workspace's open first uses its board (HI-2199): while its file, as a Combwork that ended without quitting left
 * it, can't be opened yet (another process still maps its `-shm`), waits for that, bounded (untilOpenable), so the board
 * opens once it can instead of failing for the rest of the session. At once for a board open already or a file closed
 * cleanly; ended when `signal` (the open's lifetime) aborts.
 */
export async function untilBoardOpenable(path: string, signal: AbortSignal): Promise<void> {
  if (boards.has(keyOf(path))) return
  let waiting = false
  const onWait = (e: Error): void => {
    waiting = true
    boardTestHooks.openableWait?.(path)
    log.warn(`the board of ${userText(path)} can't be opened yet: ${userText(e.message)} (SQLite code ${(e as { errcode?: number }).errcode}; another process still maps its ${DB_FILE}-shm, as just after a Combwork ended without quitting): waiting up to ${OPENABLE_WAIT_MS / 1000} s`)
  }
  const waited = await untilOpenable(join(path, CW_DIR, DB_FILE), { onWait, signal })
  if (waiting) log.info(`the board of ${userText(path)}: ${signal.aborted ? 'its wait ended with its open' : 'openable'} after ${Math.round(waited)} ms`)
}

/**
 * Opens a workspace's board, its file migrated: the 1.0 group (#1207) only when `upgrade` (the user said yes) or a test
 * copy's pre-answer, else the board opens read-only until it is upgraded. Throws as openDb does (DbInUseError: another
 * Combwork has the file open), and when another profile's presence marker is fresh, nothing changed either way.
 */
function openBoard(path: string, upgrade: boolean): Board {
  const key = keyOf(path)
  // The folder's `.combwork` where it really is, now: what every later write and removal for this board uses (#1402), the
  // file itself opened by its spelling (the same file at this instant; db.ts knows it by that).
  const real = realPath(path)
  const combwork = join(real, CW_DIR)
  let db: Db | null = null
  try {
    db = openDb(join(path, CW_DIR, DB_FILE), {
      migrations: BOARD_MIGRATIONS,
      appVersion: appVersion(),
      backupDir: join(path, CW_DIR, BACKUPS),
      approve: (p) => upgrade || upgradeAnswer(p) === 'yes',
      beforeGroup: () => {
        if (othersPresent(combwork, presenceId()).length) throw new OtherCombworkError()
      },
      whileGroupLocked: boardTestHooks.whileUpgrading ?? holdForTest,
      checkpointer: checkpointWhenIdle,
      onIoRetry: (e, ms) => log.warn(`opening the board of ${userText(path)}: ${userText(e.message)} (SQLite code ${(e as { errcode?: number }).errcode}), tried again in ${ms} ms`),
      // Each step's time (HI-1694: an upgrade that took a minute said only that it had finished).
      onSteps: (steps, copyMs) => {
        const ms = (x: number): string => `${Math.round(x)} ms`
        const total = steps.reduce((n, x) => n + x.ms, copyMs ?? 0)
        log.info(`the board of ${userText(path)} took ${steps.length} schema step(s) in ${ms(total)}${copyMs === null ? '' : `, its copy before them ${ms(copyMs)}`}: ${steps.map((x) => `${x.version} ${x.name} ${ms(x.ms)}`).join(', ')}`)
      }
    })
    const w = db.writer
    // Read-only until the user says yes in the window's question (HI-1694: the log said nothing of the wait for it).
    if (db.pending) log.info(`the board of ${userText(path)} waits for its upgrade to 1.0 (from v${db.pending.from}): read-only until the window's question is answered`)
    const b: Board = {
      path,
      place: real.toLowerCase(),
      combwork,
      db,
      legacy: db.reader.prepare("SELECT 1 FROM pragma_table_info('cards') WHERE name = 'doc'").get() !== undefined, // i18n-ignore: SQL
      version: w.prepare('PRAGMA data_version'), // i18n-ignore: SQL
      dataVersion: 0,
      revision: 0,
      transient: false,
      leases: 0,
      detached: false,
      generation: ++openings,
      commits: 0,
      poll: setInterval(() => pollOther(key), POLL_MS),
      presence: setInterval(() => markPresent(combwork), HEARTBEAT_MS)
    }
    b.poll.unref?.()
    b.presence.unref?.()
    if (writable(db)) {
      const raw = meta(w, 'imported')
      const imported = raw ? (JSON.parse(raw) as Imported) : null
      if (!imported) importFiles(b, combwork, appVersion())
      else if (imported.pendingRename) finishMove(b, combwork, imported)
      else keepSetAsideNumbers(b, combwork)
    }
    b.dataVersion = (b.version.get() as { data_version: number }).data_version
    markPresent(combwork)
    boards.set(key, b)
    return b
  } catch (e) {
    db?.close()
    throw e
  }
}

/** Whether a board's file takes writes: not saved by a newer Combwork, nor waiting for its upgrade. */
const writable = (db: Db): boolean => db.newer === null && !db.pending

/** The folder of the board's copies (db.ts keeps the newest three, and the 1.0 group's copy for good). */
const BACKUPS = 'backups'
/** The family of the board's copies; the copy before the 1.0 upgrade is `hive-before-1.0-v<n>-<time>.db`. */
const FAMILY = DB_FILE.replace(/\.db$/, '')
/** Where Restore the 0.9 Board Backup keeps the 1.0 file it replaces: never pruned either. */
const RESTORE_FAMILY = `${FAMILY}-before-restore`

/** Another profile's Combwork has the workspace open, by its presence marker (a 1.0 Hive; a 0.9 one shows by SQLite's lock). */
class OtherCombworkError extends Error {
  constructor() {
    super('another Combwork has the workspace open (its presence marker is fresh)') // i18n-ignore: for the log; the user sees M.inUse
  }
}

/**
 * A test copy's answer to the upgrade's question, given before it is asked (CW_TEST_BOARD_UPGRADE=yes|no, unpackaged
 * builds only; the e2e suites' boards made by 0.9), or a unit test's hook. Anything else: the user is asked.
 */
function upgradeAnswer(p: PendingGroup): 'yes' | 'no' | null {
  if (p.group !== UPGRADE_GROUP_ID) return null
  if (boardTestHooks.upgradeAnswer) return boardTestHooks.upgradeAnswer
  const env = process.env.CW_TEST_BOARD_UPGRADE
  if (packaged() || (env !== 'yes' && env !== 'no')) return null
  return env
}

/**
 * For the S60 suite (unpackaged builds only): CW_TEST_UPGRADE_HOLD=<ms>;<file> keeps the upgrade's exclusive lock that
 * long once its steps are committed, after writing <file>, so the suite can start a 0.9 Hive during the upgrade. Main's
 * thread waits meanwhile, as it would on a slow disk.
 */
function holdForTest(): void {
  const hold = packaged() ? undefined : process.env.CW_TEST_UPGRADE_HOLD
  if (!hold) return
  const [ms, file] = hold.split(';')
  if (file) writeFileSync(file, new Date().toISOString(), 'utf8')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(Number(ms) || 0, 120_000))
}

const packaged = (): boolean => {
  try {
    return app.isPackaged
  } catch {
    return false
  }
}

/** This profile's presence marker name (presence.ts). */
let ownPresence: string | null = null
const presenceId = (): string => (ownPresence ??= profileId(userDataOf()))

/** Writes this Combwork's presence marker in a workspace's .combwork (its heartbeat); a failure only means one heartbeat fewer. */
function markPresent(combwork: string): void {
  try {
    writePresence(combwork, presenceId(), { pid: process.pid, profile: basename(userDataOf()), appVersion: appVersion(), startedAt })
  } catch (e) {
    log.warn('writing the workspace presence marker', e)
  }
}
const startedAt = new Date().toISOString()
const userDataOf = (): string => {
  try {
    return app.getPath('userData')
  } catch {
    // No profile folder: the name alone.
    return 'profile'
  }
}

/** How often each open board looks for another process's changes (a dev Combwork, a script on the same workspace). */
export const POLL_MS = 1000

/** Another connection (another process) committed: the board is told, once. Combwork's own writes don't change the writer's data_version. */
function pollOther(key: string): void {
  const b = boards.get(key)
  if (!b) return
  try {
    const v = (b.version.get() as { data_version: number }).data_version
    if (v === b.dataVersion) return
    b.dataVersion = v
    emit({ type: 'tasks-changed', workspacePath: b.path })
  } catch (e) {
    log.warn('looking for changes to the board', e)
  }
}

/**
 * The board's revision (#1266): what has been committed to its cards and lanes, as a token that only moves on, never a
 * clock. This process's changes are counted as they commit (a board change that changed something, a save of the lanes:
 * noteLanesSaved); another process's move the writer's `data_version`; a database replaced or restored moves its
 * generation. The same revision twice: none of them changed between, so what was read between is still current. Lane
 * notices check it under the board's lock (workflowNotices.ts). Writes nothing.
 */
export function boardRevision(ws: WorkspaceService): string {
  const path = pathOf(ws)
  const b = boardOf(path)
  return `${dbGenerationAt(b.place)}:${(b.version.get() as { data_version: number }).data_version}:${b.revision}`
}

/**
 * A token for what is committed to the board now (HI-1909), for a cache of what is read from it: it moves on with every
 * commit, a quiet one (no tasks-changed) too, another process's (the writer's `data_version`), and a database replaced
 * or opened again, moved as the commit ends, before anything told of it runs. Null inside a write, whose reads see its
 * own changes, and inside a read's snapshot, which may be older: nothing read there may be cached or served from a
 * cache. The same token twice: nothing was committed between.
 */
export function boardReadToken(ws: WorkspaceService): string | null {
  const path = pathOf(ws)
  if (inWrite(keyOf(path))) return null
  const b = boardOf(path)
  // Inside a read's snapshot (readSnapshot), which may be older than what the token would name.
  if (b.db.reader.isTransaction) return null
  return `${b.generation}:${dbGenerationAt(b.place)}:${(b.version.get() as { data_version: number }).data_version}:${b.commits}`
}

/** The lanes were saved (storeTables.ts, in this process): the board's revision moves on. */
export function noteLanesSaved(path: string): void {
  const b = boards.get(keyOf(path))
  if (b) b.revision++
}

/**
 * Closes a workspace's board (it closed, or its file is replaced): the stub's next number brought up to date for older
 * versions. Every board of that folder, however it was spelt as it opened (#1402: one opened through a junction or an
 * 8.3 name, by deliveries say, would otherwise hold the folder until Combwork quits). The folder is `place`, its real
 * location as its window opened it, else as this spelling's board opened: never what the spelling resolves to now, so a
 * junction removed or pointed at another workspace since neither keeps this one's boards open nor closes another's.
 */
export function closeBoard(path: string, place?: string): void {
  const key = keyOf(path)
  const others = [...boards.keys(), ...failures.keys()].some((k) => k !== key)
  const at = others ? (place ?? boards.get(key)?.place ?? placeKey(path)) : ''
  for (const [k, f] of [...failures]) if (k === key || (others && f.place === at)) failures.delete(k)
  for (const [k, b] of [...boards]) if (k === key || (others && b.place === at)) closeOne(k, b)
}

/** Closes the board under that spelling only (a lease's own, Combwork quitting). */
function closeOne(key: string, b: Board): void {
  if (boards.get(key) !== b) return
  boards.delete(key)
  clearInterval(b.poll)
  clearInterval(b.presence)
  // The profile's marker at the place is every open board's of it here (another spelling's too): it goes with the last.
  try {
    if (![...boards.values()].some((o) => o.place === b.place)) removePresence(b.combwork, presenceId())
  } catch (e) {
    log.warn('removing the workspace presence marker', e)
  }
  // A save holding a lease on it goes on with this connection (#1383): closed as the save's lease ends.
  if (b.leases > 0) b.detached = true
  else b.db.close()
}

/** Closes every board (Combwork quits). */
export function closeAllBoards(): void {
  for (const [k, b] of [...boards]) closeOne(k, b)
}

// ---------------------------------------------------------------------------
// Writes: one at a time per board, each one transaction, told once.
// ---------------------------------------------------------------------------

/** The write running here: its board, whether it is still open, whether it changed anything. */
const writing = new AsyncLocalStorage<WriteState>()

/** A board change under way: its board, whether it is still open, whether it changed anything, what runs once it commits, and why it can't commit. */
interface WriteState {
  key: string
  open: boolean
  changed: boolean
  after: (() => void)[]
  /** What to put back on disk if the change (or the savepoint it was asked in) is undone (onBoardUndone), newest first. */
  undone: (() => Promise<void>)[]
  /** SQLite undid its transaction part way (a full disk, an I/O error, #1017 round 1): nothing more is written, and the change fails. */
  lost: Error | null
}

/** The error a change gets once SQLite has undone its transaction part way. */
const lostChange = (cause?: unknown): Error =>
  new Error(`The board's change was undone part way (${cause instanceof Error ? cause.message : 'its transaction ended'}): nothing of it was saved`) // i18n-ignore: an error from SQLite's side, shown as the reason a change failed like a system error

/** The workspace folder, or the error a board change gives without one. */
function pathOf(ws: WorkspaceService): string {
  if (!ws.path) throw combworkError(M.noWorkspace, undefined, { kind: 'conflict' })
  return ws.path
}

/** Whether this code runs inside a write to `ws`'s board (its reads then see the write's own changes). */
const inWrite = (key: string): boolean => {
  const w = writing.getStore()
  return !!w && w.open && w.key === key
}

/**
 * A change of the board: under the board's lock (one change at a time, for every window), in one transaction (all of it
 * or none: a failure or a crash part way leaves the board as it was), and told once (`tasks-changed`) after it commits
 * when it changed anything. Re-entrant: a change inside another (a card of a batch) is part of it. Reads inside it see
 * its own changes; reads elsewhere see the board as last committed.
 */
export async function boardWrite<T>(ws: WorkspaceService, fn: () => Promise<T>, opts: { alive?: () => boolean } = {}): Promise<T> {
  const path = pathOf(ws)
  const key = keyOf(path)
  if (inWrite(key)) return fn()
  // Under way from here, its wait for the lock included (HI-1368: a close command waits for it).
  return countedWrite(path, () => boardWriteLocked(ws, path, key, fn, opts))
}

/** boardWrite's change, once it is counted: under the board's lock. */
function boardWriteLocked<T>(ws: WorkspaceService, path: string, key: string, fn: () => Promise<T>, opts: { alive?: () => boolean }): Promise<T> {
  return withFileLock(boardLock(path), async () => {
    // `alive`: the caller's workspace, as it was when it asked, is still open (a background run's, #1215 round 1): a
    // change that waited for the lock while it closed or switched is refused, and the board isn't opened again for it.
    if (opts.alive && !opts.alive()) throw combworkError(M.noWorkspace, undefined, { kind: 'conflict' })
    const b = boardOf(path)
    if (b.db.newer !== null) throw combworkError(M.newer, undefined, { kind: 'conflict' })
    if (b.db.pending) throw combworkError(M.upgradeFirst, undefined, { kind: 'conflict' })
    const state: WriteState = { key, open: true, changed: false, after: [], undone: [], lost: null }
    const db = b.db.writer
    let committed = false
    timedStep(`db begin ${DB_FILE}`, () => db.exec('BEGIN IMMEDIATE'))
    try {
      const out = await writing.run(state, fn)
      if (!boards.has(key)) throw combworkError(M.noWorkspace, undefined, { kind: 'conflict' })
      // Undone part way, whatever the change made of the error meanwhile (a batch skips a card that fails): it fails whole.
      if (state.lost) throw state.lost
      if (!db.isTransaction) throw lostChange()
      timedCommit(db, b.db.file)
      committed = true
      // Read tokens move on at once (boardReadToken): what runs after the commit (its events, afterBoardWrite) reads it.
      const cb = boards.get(key)
      if (cb) cb.commits++
      return out
    } catch (e) {
      state.changed = false
      state.after = []
      try {
        if (db.isTransaction) db.exec('ROLLBACK')
      } catch {
        // Closed meanwhile (the workspace closed): nothing was committed.
      }
      await undoOnDisk(state.undone.splice(0))
      // Undone part way by SQLite: said so, whichever error the change passed on (a batch's storage error, #1216).
      throw state.lost ?? e
    } finally {
      state.open = false
      if (state.changed) {
        // Committed (a change undone isn't one): the board's revision moves on.
        const ob = boards.get(keyOf(path))
        if (ob) ob.revision++
        emit({ type: 'tasks-changed', workspacePath: path })
      }
      for (const then of state.after) {
        try {
          writing.exit(then)
        } catch (e) {
          log.warn('after a board change', e)
        }
      }
      if (committed) {
        for (const listener of committedListeners) {
          try {
            writing.exit(() => listener(ws))
          } catch (e) {
            log.warn('after a board change', e)
          }
        }
      }
    }
  })
}

const committedListeners = new Set<(ws: WorkspaceService) => void>()
/**
 * Runs `fn` after every board change that commits, outside it (as afterBoardWrite's), with the change's workspace: what
 * follows any change, whoever made it (the actions worker, #1215: a change may have written actions to run). Returns its removal.
 */
export function onBoardCommitted(fn: (ws: WorkspaceService) => void): () => void {
  committedListeners.add(fn)
  return () => void committedListeners.delete(fn)
}

/**
 * Runs `fn` once the board change running here has committed (at once outside one; never if it is undone), outside it:
 * what it starts (a loop's wake, which reads the card) sees the change saved, and a board change it makes is one of its
 * own, waiting for the board's lock like any other.
 */
export function afterBoardWrite(ws: WorkspaceService, fn: () => void): void {
  const w = writing.getStore()
  if (ws.path && w && w.open && w.key === keyOf(ws.path)) w.after.push(fn)
  else writing.exit(fn)
}

/**
 * Asks the board change running here to put something on disk back if it is undone (HI-1700: files renamed into place
 * with rows that are then rolled back): run, newest first, when the change rolls back, or the savepoint it was asked in.
 * Never run once it commits. Outside a change of `ws`'s board there is nothing to undo with: nothing is kept.
 */
export function onBoardUndone(ws: WorkspaceService, fn: () => Promise<void>): void {
  const w = writing.getStore()
  if (ws.path && w && w.open && w.key === keyOf(ws.path)) w.undone.push(fn)
}

async function undoOnDisk(fns: (() => Promise<void>)[]): Promise<void> {
  for (const fn of fns.reverse()) {
    try {
      await fn()
    } catch (e) {
      log.warn('putting back what an undone board change did on disk', e)
    }
  }
}

/** Marks the write running here as a change (told after it commits); outside a write, tells the board now. */
export function boardChanged(ws: WorkspaceService): void {
  if (!ws.path) return
  const w = writing.getStore()
  if (w && w.open && w.key === keyOf(ws.path)) w.changed = true
  else emit({ type: 'tasks-changed', workspacePath: ws.path })
}

/** The connection a read uses: the write's own inside one, else the reader. */
function readConn(ws: WorkspaceService): { b: Board; db: Db['reader'] } {
  const path = pathOf(ws)
  const b = boardOf(path)
  return { b, db: inWrite(keyOf(path)) ? b.db.writer : b.db.reader }
}

/**
 * A read of several statements on one snapshot of the board (#1209 round 1, HR4's finding): a card is its row and its
 * child rows, read by separate statements, and another process (another Combwork, a script) committing between them must
 * never give a card neither of them saved, nor a child query that picks other cards than its parent's. Inside a change
 * (or a read already holding one) it runs on that transaction; else it opens a read transaction on the reader, whose
 * snapshot every statement of `fn` sees, and ends it after. `fn` is synchronous: nothing else uses the reader meanwhile.
 */
/** A read of the board's database on one snapshot, as the board's readers make (the fact store's, #1215). */
export function boardRead<T>(ws: WorkspaceService, fn: (db: Db['reader']) => T): T {
  return readSnapshot(ws, (_b, db) => fn(db))
}

/** What the upgrade's adoption (#1218, workflow/adoption.ts) needs of a card: where it is, whose it is, and whether it has facts. */
export interface AdoptionCard {
  number: number
  project: string
  column: string
  archived: boolean
  agent: string | null
  preWorkflow: boolean
  facts: boolean
}

const ADOPTION_SQL = 'SELECT number, project, col, archived, agent, pre_workflow, EXISTS (SELECT 1 FROM card_facts f WHERE f.card = cards.number) AS facts FROM cards' // i18n-ignore: SQL
type AdoptionRow = { number: number; project: string; col: string; archived: number; agent: string | null; pre_workflow: number; facts: number }
const adoptionCardOf = (r: AdoptionRow): AdoptionCard => ({ number: r.number, project: r.project, column: r.col, archived: r.archived === 1, agent: r.agent, preWorkflow: r.pre_workflow === 1, facts: r.facts === 1 })

/** The AdoptionCard of each card up to `upto` (ADOPTION_UPTO), in number order, on one snapshot ([] on a board still 0.9's, waiting for its upgrade). */
export function adoptionCards(ws: WorkspaceService, upto = Number.MAX_SAFE_INTEGER): AdoptionCard[] {
  return readSnapshot(ws, (b, db) => {
    if (b.legacy || b.db.pending) return []
    return (db.prepare(`${ADOPTION_SQL} WHERE number <= ? ORDER BY number`).all(upto) as AdoptionRow[]).map(adoptionCardOf) // i18n-ignore: SQL
  })
}

/** A card's AdoptionCard as it is now, inside boardWrite (what the adoption checks again before it writes); null when it has gone. */
export function adoptionCardNow(ws: WorkspaceService, n: number): AdoptionCard | null {
  return writeOp(ws, (b) => {
    const r = b.db.writer.prepare(`${ADOPTION_SQL} WHERE number = ?`).get(n) as AdoptionRow | undefined // i18n-ignore: SQL
    return r ? adoptionCardOf(r) : null
  })
}

/**
 * Marks cards as from before 1.0 (#1218, SPEC §16.4.1: no facts), inside boardWrite: each only while it is as the
 * adoption classified it (its project, column and archived state), has no facts and isn't marked yet, so a card a Combwork
 * has meanwhile started, adopted or moved is left alone. `marked`: how many it marked; `changed`: those it left that are
 * still neither marked nor started (classified again from fresh data by the adoption's next run).
 */
export function markPreWorkflow(ws: WorkspaceService, cards: AdoptionCard[]): { marked: number; changed: number } {
  return writeOp(ws, (b) => {
    const db = b.db.writer
    const mark = db.prepare('UPDATE cards SET pre_workflow = 1 WHERE number = ? AND project = ? AND col = ? AND archived = ? AND pre_workflow = 0 AND NOT EXISTS (SELECT 1 FROM card_facts f WHERE f.card = cards.number)') // i18n-ignore: SQL
    const now = db.prepare(`${ADOPTION_SQL} WHERE number = ?`) // i18n-ignore: SQL
    let marked = 0
    let changed = 0
    for (const c of cards) {
      if (Number(mark.run(c.number, c.project, c.column, c.archived ? 1 : 0).changes)) marked++
      else {
        const r = now.get(c.number) as AdoptionRow | undefined
        if (r && !r.facts && !r.pre_workflow) changed++
      }
    }
    return { marked, changed }
  })
}

/** A value the board keeps of its own (board_meta), or null. */
export const boardValue = (ws: WorkspaceService, key: string): string | null => readSnapshot(ws, (_b, db) => meta(db, key))

/**
 * Cards' column, project and whether archived, as committed now, on one snapshot: what lanes.ts checks a decision
 * against under the board's lock, just before it saves (#1270: a lane ended or its queued list applied only if its
 * cards are still where the decision read them). A card not on the board is missing from the map.
 */
export function cardPlacesNow(ws: WorkspaceService, numbers: readonly number[]): Map<number, { column: string; project: string; archived: boolean; agent: string | null }> {
  if (!numbers.length) return new Map()
  return readSnapshot(ws, (_b, db) => {
    const rows = db.prepare(`SELECT number, col, project, archived, agent FROM cards WHERE number IN (${numbers.map(() => '?').join(', ')})`).all(...numbers) as { number: number; col: string; project: string; archived: number; agent: string | null }[] // i18n-ignore: SQL
    return new Map(rows.map((r) => [r.number, { column: r.col, project: r.project, archived: r.archived === 1, agent: r.agent }]))
  })
}
/**
 * Who has each card for the lanes (HI-1821), on one snapshot: its agent on the board, and its owner lane: the running
 * lane of its project now listing it (its list or its queued one; HR4's round 1: never a lane of a project it has
 * left) whose builder is that agent, else the newest such lane (null: none). The runtime's `card.lane` (factStore
 * `inLanes`, filtered to its project) orders them the same way.
 */
export function cardOwnersNow(ws: WorkspaceService, numbers: readonly number[]): Map<number, { agent: string | null; lane: string | null }> {
  if (!numbers.length) return new Map()
  return readSnapshot(ws, (_b, db) => {
    const at = numbers.map(() => '?').join(', ')
    const out = new Map<number, { agent: string | null; lane: string | null }>()
    for (const r of db.prepare(`SELECT number, agent FROM cards WHERE number IN (${at})`).all(...numbers) as { number: number; agent: string | null }[]) out.set(r.number, { agent: r.agent, lane: null }) // i18n-ignore: SQL
    // A 0.9 board waiting for its upgrade to 1.0 has no lane tables yet: no card has an owner lane (HI-1846).
    if (boardReadOnly(ws)) return out
    const rows = db
      .prepare(`SELECT x.card, l.id FROM (SELECT lane, card FROM lane_cards UNION SELECT lane, card FROM lane_pending) x JOIN lanes l ON l.id = x.lane JOIN cards c ON c.number = x.card WHERE x.card IN (${at}) AND l.state = 'active' AND l.project = c.project COLLATE NOCASE ORDER BY (c.agent IS NOT NULL AND c.agent = l.builder_id), l.started_at, l.id`) // i18n-ignore: SQL
      .all(...numbers) as { card: number; id: string }[]
    for (const r of rows) out.get(r.card)!.lane = r.id
    return out
  })
}

/** Sets one of the board's own values (inside boardWrite). */
export const setBoardValue = (ws: WorkspaceService, key: string, value: string): void => writeOp(ws, (b) => setMeta(b.db.writer, key, value))

let savepoints = 0

/**
 * Part of the change running here that can be undone on its own (#1265: a workflow intent's write, a batch's card): if
 * `fn` throws, its writes and what it asked to run after the change (afterBoardWrite) are undone, and the rest of the
 * change goes on (the error is passed on). `keep(e)`: an error whose part is kept all the same (a refusal's own record).
 * Outside a change of `ws`'s board, `fn` as it is.
 */
export async function boardSavepoint<T>(ws: WorkspaceService, fn: () => Promise<T>, keep: (e: unknown) => boolean = () => false): Promise<T> {
  const path = pathOf(ws)
  const state = writing.getStore()
  if (!state || !state.open || state.key !== keyOf(path)) return fn()
  const db = boardOf(path).db.writer
  const name = `part${++savepoints}`
  const after = state.after.length
  const undone = state.undone.length
  const changed = state.changed
  db.exec(`SAVEPOINT ${name}`)
  try {
    const out = await fn()
    db.exec(`RELEASE ${name}`)
    return out
  } catch (e) {
    // Undone part way by SQLite meanwhile: the whole change fails (boardWrite), nothing to undo here.
    if (!state.lost && db.isTransaction) {
      if (!keep(e)) {
        db.exec(`ROLLBACK TO ${name}`)
        state.after.length = after
        state.changed = changed
        await undoOnDisk(state.undone.splice(undone))
      }
      db.exec(`RELEASE ${name}`)
    }
    throw e
  }
}

/** A write to the board's database: inside a change of `ws`'s board only, and only while its transaction is live (writeOp). */
export function boardWriteOp<T>(ws: WorkspaceService, fn: (db: Db['writer']) => T): T {
  return writeOp(ws, (b) => fn(b.db.writer))
}

function readSnapshot<T>(ws: WorkspaceService, fn: (b: Board, db: Db['reader']) => T): T {
  const { b, db } = readConn(ws)
  if (db.isTransaction) return fn(b, db)
  db.exec('BEGIN')
  try {
    const out = fn(b, db)
    db.exec('COMMIT')
    return out
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw e
  }
}

/**
 * A write to the board, inside boardWrite only, and only while its transaction is live: once SQLite has undone it (an
 * error that rolls back the whole transaction), every later write of the change fails too, never going on in autocommit,
 * and the change fails whole as it ends.
 */
function writeOp<T>(ws: WorkspaceService, op: (b: Board) => T): T {
  const path = pathOf(ws)
  const state = writing.getStore()
  if (!state || !state.open || state.key !== keyOf(path)) throw new Error('A board write outside boardWrite') // i18n-ignore: a mistake in Combwork's code, never shown
  const b = boardOf(path)
  if (state.lost) throw state.lost
  if (!b.db.writer.isTransaction) throw (state.lost = lostChange())
  try {
    return op(b)
  } catch (e) {
    if (!b.db.writer.isTransaction) state.lost = lostChange(e)
    throw e
  }
}

// ---------------------------------------------------------------------------
// Reads and writes of cards (tasks.ts keeps every rule; this keeps the rows).
// ---------------------------------------------------------------------------

/** A card's document as saved; null when there is no such card. */
export function cardDoc(ws: WorkspaceService, n: number): Record<string, unknown> | null {
  return readSnapshot(ws, (b, db) => {
    if (b.legacy) {
      const row = db.prepare('SELECT doc FROM cards WHERE number = ?').get(n) as { doc: string } | undefined // i18n-ignore: SQL
      return row ? (JSON.parse(row.doc) as Record<string, unknown>) : null
    }
    const [r] = readCardRows(db, { numbers: [n] })
    return r ? composeCard(r) : null
  })
}

/** Whether there is a card of that number. */
export function hasCard(ws: WorkspaceService, n: number): boolean {
  const { db } = readConn(ws)
  return !!db.prepare('SELECT 1 FROM cards WHERE number = ?').get(n) // i18n-ignore: SQL
}

/**
 * Cards' 1.0 stages (#1223, SPEC §16.4.3), by number: the `stage` column, else (no 1.0 rule has moved the card, or the
 * board waits for its upgrade) the stage its column stands for. A card not on the board isn't in the map.
 */
export function cardStages(ws: WorkspaceService, numbers: number[]): Map<number, StageId> {
  if (!numbers.length) return new Map()
  return readSnapshot(ws, (b, db) => {
    const cols = b.legacy ? "NULL AS stage, doc ->> '$.column' AS col" : 'stage, col' // i18n-ignore: SQL
    const rows = db.prepare(`SELECT number, ${cols} FROM cards WHERE number IN (SELECT value FROM json_each(?))`).all(JSON.stringify(numbers)) as { number: number; stage: StageId | null; col: Category }[] // i18n-ignore: SQL
    return new Map(rows.map((r) => [r.number, r.stage ?? CATEGORY_STAGE[r.col] ?? 'todo']))
  })
}

/** Every card number on the board. */
export function cardNumbers(ws: WorkspaceService): Set<number> {
  const { db } = readConn(ws)
  return new Set((db.prepare('SELECT number FROM cards').all() as { number: number }[]).map((r) => r.number)) // i18n-ignore: SQL
}

/**
 * Which cards a query asks for: archived or not (both when left out), these numbers, given to one of these agents, being
 * reviewed by one of these agents (#1107: picked in the query, so no other card is read).
 */
export interface CardQuery {
  archived?: boolean
  numbers?: number[]
  agents?: string[]
  reviewers?: string[]
}

/**
 * Lower-case letters the index can't be trusted with (#1237 round 2). FTS5 folds case by its own Unicode tables, and
 * `toLowerCase` (what cardMatches compares) lowers some capitals to a letter FTS5 keeps apart from them: İ to i + U+0307,
 * Georgian Mtavruli (Ა) to Mkhedruli (ა), Cherokee capitals to its small letters, and a few dozen more. A card holding the
 * capital matches such a query in memory but not in the index, so a query with one of these letters is matched in memory;
 * so is one ending in `i` (it could be the start of İ's `i̇`), while an `i` before another letter can't be. Most folds
 * FTS5 makes beyond `toLowerCase` (ſ to s, ς to σ) only find more candidates, which cardMatches drops. Generated from
 * SQLite 3.53 (Electron's 3.53.4 and Node's 3.53.3 alike); tests/cardSearch.test.ts works the set out again from the
 * SQLite it runs on and fails if a letter is missing.
 */
const FOLD_APART = /[\u{19b}\u{25c}\u{261}\u{264}\u{26a}\u{26c}\u{282}\u{287}\u{29d}-\u{29e}\u{3f3}\u{529}\u{52b}\u{52d}\u{52f}\u{10d0}-\u{10fa}\u{10fd}-\u{10ff}\u{13f8}-\u{13fd}\u{1c8a}\u{1d8e}\u{2c5f}\u{a699}\u{a69b}\u{a794}\u{a797}\u{a799}\u{a79b}\u{a79d}\u{a79f}\u{a7b5}\u{a7b7}\u{a7b9}\u{a7bb}\u{a7bd}\u{a7bf}\u{a7c1}\u{a7c3}\u{a7c8}\u{a7ca}\u{a7cd}\u{a7cf}\u{a7d1}\u{a7d3}\u{a7d5}\u{a7d7}\u{a7d9}\u{a7db}\u{a7f6}\u{ab53}\u{ab70}-\u{abbf}\u{104d8}-\u{104fb}\u{10597}-\u{105a1}\u{105a3}-\u{105b1}\u{105b3}-\u{105b9}\u{105bb}-\u{105bc}\u{10cc0}-\u{10cf2}\u{10d70}-\u{10d85}\u{118c0}-\u{118df}\u{16e60}-\u{16e7f}\u{16ebb}-\u{16ed3}\u{1e922}-\u{1e943}]/u
/** Whether `words` has a letter the index can't be trusted with (FOLD_APART, or İ's combining dot above, U+0307). */
export const foldsApart = (words: string): boolean => FOLD_APART.test(words) || words.includes('\u0307')

/** An FTS5 query for cards whose searched text contains `words` (one string, spaces and all): a phrase, quotes doubled. */
export const searchMatch = (words: string): string => `{title description project agent labels} : "${words.replace(/"/g, '""')}"` // i18n-ignore: an FTS5 query

/**
 * The board's search through its full-text index (#1237, `card_search`): the cards whose title, description, project,
 * agent's name or labels contain `words` (searchedWords: lower case), as candidates the caller confirms with cardMatches.
 * Null when the index can't answer: words under three characters (it indexes trigrams), words it can't be trusted with
 * (foldsApart), or a board without it (0.9's, waiting for its upgrade).
 */
export function searchCards(ws: WorkspaceService, words: string): Set<number> | null {
  if ([...words].length < 3 || foldsApart(words) || words.endsWith('i')) return null
  return readSnapshot(ws, (b, db) => {
    if (b.legacy || b.db.pending) return null
    return new Set((db.prepare(QUERIES['board.search'].sql).all(searchMatch(words)) as { number: number }[]).map((r) => r.number))
  })
}

/** Cards' documents, by number, as the query asks; in number order. */
export function cardDocs(ws: WorkspaceService, q: CardQuery = {}): { number: number; doc: Record<string, unknown> }[] {
  return readSnapshot(ws, (b, db) => docsOf(b, db, q))
}

function docsOf(b: Board, db: Db['reader'], q: CardQuery): { number: number; doc: Record<string, unknown> }[] {
  const where: string[] = []
  const args: (number | string)[] = []
  if (q.archived !== undefined) where.push(`archived = ${q.archived ? 1 : 0}`)
  if (q.numbers) {
    if (!q.numbers.length) return []
    where.push(`number IN (SELECT value FROM json_each(?))`) // i18n-ignore: SQL
    args.push(JSON.stringify(q.numbers))
  }
  if (q.agents) {
    if (!q.agents.length) return []
    where.push(`agent IN (SELECT value FROM json_each(?))`) // i18n-ignore: SQL
    args.push(JSON.stringify(q.agents))
  }
  if (q.reviewers) {
    if (!q.reviewers.length) return []
    where.push(`${b.legacy ? "doc ->> '$.review.agent'" : 'review_agent'} IN (SELECT value FROM json_each(?))`) // i18n-ignore: SQL
    args.push(JSON.stringify(q.reviewers))
  }
  if (!b.legacy) return readCardRows(db, { where: where.join(' AND ') || undefined, args }).map((r) => ({ number: r.card.number, doc: composeCard(r) }))
  const rows = db.prepare(`SELECT number, doc FROM cards${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY number`).all(...args) as { number: number; doc: string }[] // i18n-ignore: SQL
  return rows.map((r) => ({ number: r.number, doc: JSON.parse(r.doc) as Record<string, unknown> }))
}

/** The `cards` columns each document field is read from (the lists are child tables: readCardRows' parts). */
const FIELD_COLUMNS: Record<string, (keyof CardRow)[]> = {
  title: ['title'], // i18n-ignore: a column's name
  description: ['description'], // i18n-ignore: a column's name
  project: ['project'],
  projectId: ['project_id'],
  agent: ['agent'],
  agentName: ['agent_name'],
  review: ['review_agent', 'review_agent_name', 'review_since'],
  column: ['col'],
  order: ['ord'],
  blocked: ['blocked'],
  archived: ['archived'],
  archivedFor: ['archived_for'],
  archivedBatch: ['archived_batch'],
  contextProblems: ['context_problems'],
  createdAt: ['created_at'],
  createdBy: ['created_by'],
  updatedAt: ['updated_at']
}

/**
 * Some fields of each card a condition picks (every card without one), each as its document has it (null when it hasn't
 * the field), read from only the columns and child tables they need: nothing else of a card (its description, comments…).
 */
function cardFields(db: Db['reader'], keys: string[], sel: { where?: string; args?: (number | string)[]; numbers?: number[]; parts: CardPart[] }): { r: CardRows; fields: Record<string, unknown> }[] {
  const columns = [...new Set(keys.flatMap((k) => FIELD_COLUMNS[k] ?? []))]
  return readCardRows(db, { where: sel.where, args: sel.args, numbers: sel.numbers, parts: sel.parts, columns }).map((r) => ({ r, fields: Object.fromEntries(keys.map((k) => [k, cardField(r, k) ?? null])) }))
}

/**
 * The fields a card's cost needs (cardCosts.ts): its holds, and for a card from before Combwork kept them its history with
 * the agent and reviewer it has now (holdsFromHistory names them by those: HR1's #1210 round 1 finding).
 */
const COST_FIELDS = ['title', 'project', 'projectId', 'column', 'archived', 'held', 'history', 'agent', 'agentName', 'review']

/**
 * The fields a card's cost needs of the cards given (#1210): its title, project, column, holds, history, agent and reviewer, read from
 * their columns and child tables, nothing else of it (its description, comments, decisions). In number order.
 */
export function costDocs(ws: WorkspaceService, numbers: number[]): { number: number; doc: Record<string, unknown> }[] {
  if (!numbers.length) return []
  return readSnapshot(ws, (b, db) => {
    if (b.legacy) return docsOf(b, db, { numbers }).map(({ number, doc }) => ({ number, doc: Object.fromEntries(COST_FIELDS.map((k) => [k, doc[k] ?? null])) }))
    return cardFields(db, COST_FIELDS, { numbers, parts: ['holds', 'history'] }).map(({ r, fields }) => ({ number: r.card.number, doc: fields }))
  })
}

/** The fields of an archived card's summary (archivedSummaryDocs), in its order. */
const SUMMARY = ['title', 'project', 'projectId', 'agent', 'agentName', 'column', 'order', 'labels', 'blocked', 'archivedFor', 'archivedBatch', 'createdAt', 'createdBy', 'updatedAt']

/**
 * The archived cards in short, for the window's board (#1017): title, place, agent, labels and dates, each as the card's
 * document has it (null when it hasn't the field), read from their columns and labels alone. The Archived view and a
 * card's dialog read them in full.
 */
export function archivedSummaryDocs(ws: WorkspaceService): { number: number; doc: Record<string, unknown> }[] {
  return readSnapshot(ws, summariesOf)
}

function summariesOf(b: Board, db: Db['reader']): { number: number; doc: Record<string, unknown> }[] {
  if (!b.legacy) return cardFields(db, SUMMARY, { where: 'archived = 1', parts: ['labels'] }).map(({ r, fields }) => ({ number: r.card.number, doc: { ...fields, archived: true } }))
  const field = (k: string): string => `'${k}', doc -> '$.${k}'`
  const rows = db.prepare(`SELECT number, json_object(${SUMMARY.map(field).join(', ')}, 'archived', json('true')) AS doc FROM cards WHERE archived = 1 ORDER BY number`).all() as { number: number; doc: string }[] // i18n-ignore: SQL
  return rows.map((r) => ({ number: r.number, doc: JSON.parse(r.doc) as Record<string, unknown> }))
}

/** What a window's board read takes from one snapshot of the board (HI-1715, cardChanges). */
export interface CardChanges {
  /** The board's opening it was read from (Board.generation). */
  generation: number
  /** The board's mark in that snapshot; null on a board with no revisions (a 0.9 board waiting for its upgrade). */
  mark: number | null
  /** Every card's number. */
  numbers: number[]
  keys: Map<number, string>
  /** The live cards changed (all of them without `since`), in full. */
  live: { number: number; doc: Record<string, unknown> }[]
  /** The archived cards changed (all of them without `since`), in short (archivedSummaryDocs). */
  summaries: { number: number; doc: Record<string, unknown> }[]
}

/**
 * The board as a window reads it (HI-1715): every number and key, and the cards at revision `since` or above (every card
 * when null, or on a board with no revisions), the live ones in full and the archived in short, with the mark, all from one
 * snapshot. A write committed after it raises what it changes to the mark or above, so the next read from this mark has
 * it (CARD_REVS_STEP).
 */
export function cardChanges(ws: WorkspaceService, since: number | null): CardChanges {
  return readSnapshot(ws, (b, db) => {
    const numbers = (db.prepare('SELECT number FROM cards ORDER BY number').all() as { number: number }[]).map((r) => r.number) // i18n-ignore: SQL
    if (b.legacy) return { generation: b.generation, mark: null, numbers, keys: new Map(), live: docsOf(b, db, { archived: false }), summaries: summariesOf(b, db) }
    const mark = (db.prepare('SELECT g FROM board_rev').get() as { g: number }).g // i18n-ignore: SQL
    const changed = since === null ? '' : ' AND rev >= ?' // i18n-ignore: SQL
    const args = since === null ? [] : [since]
    return {
      generation: b.generation,
      mark,
      numbers,
      keys: keysOfCards(db),
      live: readCardRows(db, { where: `archived = 0${changed}`, args }).map((r) => ({ number: r.card.number, doc: composeCard(r) })),
      summaries: cardFields(db, SUMMARY, { where: `archived = 1${changed}`, args, parts: ['labels'] }).map(({ r, fields }) => ({ number: r.card.number, doc: { ...fields, archived: true } }))
    }
  })
}

/** What a decision notice reads of a card (decisionNotices.ts): where it is, whose, its review and block, its history and decisions. */
const DECISION_FIELDS = ['project', 'projectId', 'column', 'agent', 'agentName', 'review', 'blocked', 'history', 'decisions']

/**
 * The live cards at revision `since` or above (every live card when null): their numbers, and DECISION_FIELDS of those
 * with decisions, with the board's mark and its opening, from one snapshot (HI-1789). Nothing else of any card is read:
 * no comments or description, and nothing of the cards unchanged (cardChanges reads every card's number and key). Null
 * on a board with no revisions (a 0.9 board waiting for its upgrade).
 */
export function decisionChanges(ws: WorkspaceService, since: number | null): { generation: number; mark: number; changed: number[]; docs: { number: number; doc: Record<string, unknown> }[] } | null {
  return readSnapshot(ws, (b, db) => {
    if (b.legacy) return null
    const mark = (db.prepare('SELECT g FROM board_rev').get() as { g: number }).g // i18n-ignore: SQL
    // By the revision's index alone (archived picked here: a condition on it, or an ORDER BY, can make SQLite take
    // another index or scan every card), then the decided ones by number.
    const changed = (since === null ? db.prepare('SELECT number, archived FROM cards WHERE archived = 0').all() : db.prepare('SELECT number, archived FROM cards WHERE rev >= ?').all(since)) as { number: number; archived: number }[] // i18n-ignore: SQL
    const numbers = changed.filter((r) => r.archived === 0).map((r) => r.number)
    const decided = numbers.length ? (db.prepare('SELECT DISTINCT card FROM card_decisions WHERE card IN (SELECT value FROM json_each(?))').all(JSON.stringify(numbers)) as { card: number }[]).map((r) => r.card) : [] // i18n-ignore: SQL
    const docs = decided.length ? cardFields(db, DECISION_FIELDS, { numbers: decided, parts: ['history', 'decisions'] }).map(({ r, fields }) => ({ number: r.card.number, doc: fields })) : []
    return { generation: b.generation, mark, changed: numbers, docs }
  })
}

/** Which of these cards are on the board (with `live`, and not archived). */
export function cardsOnBoard(ws: WorkspaceService, numbers: readonly number[], o: { live?: boolean } = {}): Set<number> {
  if (!numbers.length) return new Set()
  const { db } = readConn(ws)
  const rows = db.prepare(`SELECT number FROM cards WHERE number IN (SELECT value FROM json_each(?))${o.live ? ' AND archived = 0' : ''}`).all(JSON.stringify([...new Set(numbers)])) as { number: number }[] // i18n-ignore: SQL
  return new Set(rows.map((r) => r.number))
}

/** Which opening of the workspace's board is open now (Board.generation), opening it if it isn't. */
export function boardGeneration(ws: WorkspaceService): number {
  return readConn(ws).b.generation
}

/**
 * Each card's holds (#602), archived cards too (#1107: what costs need of every card, without its comments): its
 * project, agent, reviewer and holds (null for a field the card hasn't), and its history only for a card that keeps no
 * holds (holdsFromHistory), read for those cards alone.
 */
export function holdDocs(ws: WorkspaceService, o: { live?: boolean } = {}): { number: number; doc: Record<string, unknown> }[] {
  // One snapshot for both reads: the history read for the cards without holds sees the cards the first read saw.
  return readSnapshot(ws, (b, db) => {
    if (!b.legacy) return holdRows(db, o.live ? { where: 'archived = 0' } : {})
    const rows = db.prepare(`SELECT number, json_object('project', doc -> '$.project', 'projectId', doc -> '$.projectId', 'agent', doc -> '$.agent', 'agentName', doc -> '$.agentName', 'review', doc -> '$.review', 'held', doc -> '$.held', 'history', CASE WHEN json_type(doc, '$.held') = 'array' THEN NULL ELSE doc -> '$.history' END) AS doc FROM cards${o.live ? " WHERE coalesce(json_extract(doc, '$.archived'), 0) = 0" : ''} ORDER BY number`).all() as { number: number; doc: string }[] // i18n-ignore: SQL
    return rows.map((r) => ({ number: r.number, doc: JSON.parse(r.doc) as Record<string, unknown> }))
  })
}

/** holdDocs' rows of the cards `sel` picks, on a board with revisions. */
function holdRows(db: Db['reader'], sel: { where?: string; args?: number[] }): { number: number; doc: Record<string, unknown> }[] {
  const cards = cardFields(db, ['project', 'projectId', 'agent', 'agentName', 'review', 'held'], { parts: ['holds'], ...sel })
  const need = cards.filter((c) => !Array.isArray(c.fields.held)).map((c) => c.r.card.number)
  const history = new Map(need.length ? readCardRows(db, { numbers: need, parts: ['history'], columns: [] }).map((r) => [r.card.number, cardField(r, 'history') ?? null]) : [])
  return cards.map(({ r, fields }) => ({ number: r.card.number, doc: { ...fields, history: Array.isArray(fields.held) ? null : (history.get(r.card.number) ?? null) } }))
}

/**
 * The holds (holdDocs) of the cards at revision `since` or above (every card's when null), with the board's mark, its
 * opening (Board.generation) and every card's number, from one snapshot (HI-1748: what the usage history keeps of the
 * board, read again only for the cards a change touched, as cardChanges does for a window). Null on a board with no
 * revisions (a 0.9 board waiting for its upgrade): holdDocs reads it whole.
 */
export function holdChanges(ws: WorkspaceService, since: number | null): { generation: number; mark: number; numbers: number[]; docs: { number: number; doc: Record<string, unknown> }[] } | null {
  return readSnapshot(ws, (b, db) => {
    if (b.legacy) return null
    const mark = (db.prepare('SELECT g FROM board_rev').get() as { g: number }).g // i18n-ignore: SQL
    const numbers = (db.prepare('SELECT number FROM cards ORDER BY number').all() as { number: number }[]).map((r) => r.number) // i18n-ignore: SQL
    return { generation: b.generation, mark, numbers, docs: holdRows(db, since === null ? {} : { where: 'rev >= ?', args: [since] }) }
  })
}

/**
 * These cards' revisions (CARD_REVS_STEP), the board's mark and its opening, from one snapshot; a card not on the board
 * has none. A write raises a card's revision only while it is below the mark (a card at the mark keeps it), so a card
 * read at the mark may change without its revision moving: only one read below the mark is known to be the card until
 * its revision moves. Null on a board with no revisions (a 0.9 board waiting for its upgrade). What a read kept per
 * card checks itself against (HI-1780).
 */
export function cardRevs(ws: WorkspaceService, numbers: readonly number[]): { generation: number; mark: number; revs: Map<number, number> } | null {
  return readSnapshot(ws, (b, db) => {
    if (b.legacy) return null
    const mark = (db.prepare('SELECT g FROM board_rev').get() as { g: number }).g // i18n-ignore: SQL
    const rows = numbers.length ? (db.prepare('SELECT number, rev FROM cards WHERE number IN (SELECT value FROM json_each(?))').all(JSON.stringify(numbers)) as { number: number; rev: number }[]) : [] // i18n-ignore: SQL
    return { generation: b.generation, mark, revs: new Map(rows.map((r) => [r.number, r.rev])) }
  })
}

/**
 * Each card's place fields, from their columns (nothing else of a card read): what placing a card needs (#458). With
 * `live`, only the live cards in its column and those whose column is none of `known` (a reader takes them as To Do's):
 * where a change's card is in its column (HI-1887: every agent's comment asks).
 */
export function cardPlaces(ws: WorkspaceService, live?: { column: string; known: readonly string[] }): { number: number; raw: { column: unknown; order: unknown; archived: boolean; project: unknown; projectId: unknown } }[] {
  const where = live ? 'archived = 0 AND (col IS NULL OR col = ? OR col NOT IN (SELECT value FROM json_each(?)))' : undefined // i18n-ignore: SQL
  const args = live ? [live.column, JSON.stringify(live.known)] : []
  return readSnapshot(ws, (b, db) => {
    // Order and archived as the 0.9 index gave them (cardRows.ts): its order a number where the document's was one in another form.
    if (!b.legacy) return cardFields(db, ['column', 'order', 'project', 'projectId'], { where, args, parts: [] }).map(({ r, fields }) => ({ number: r.card.number, raw: { column: fields.column, order: r.card.ord, archived: r.card.archived === 1, project: fields.project, projectId: fields.projectId } }))
    const rows = db.prepare(`SELECT number, col, ord, archived, project, project_id FROM cards${where ? ` WHERE ${where}` : ''}`).all(...args) as { number: number; col: unknown; ord: unknown; archived: number; project: unknown; project_id: unknown }[] // i18n-ignore: SQL
    return rows.map((r) => ({ number: r.number, raw: { column: r.col, order: r.ord, archived: r.archived === 1, project: r.project, projectId: r.project_id } }))
  })
}

/** A card's head (HI-1690): whose it is, where it is (its column and order there), who works on it and who reviews it. */
const HEAD_FIELDS = ['title', 'project', 'projectId', 'column', 'order', 'archived', 'agent', 'agentName', 'review']

/**
 * The live cards' heads (HI-1690: what readers run for each board change need of the board), or with `done` the live Done
 * cards' alone: HEAD_FIELDS from their columns, nothing else of a card (its description, comments, history) and no
 * archived card. In number order.
 */
export function cardHeadDocs(ws: WorkspaceService, o: { done?: boolean } = {}): { number: number; doc: Record<string, unknown> }[] {
  const where = o.done ? "col = 'done' AND archived = 0" : 'archived = 0' // i18n-ignore: SQL
  return readSnapshot(ws, (b, db) => {
    if (!b.legacy) return cardFields(db, HEAD_FIELDS, { where, parts: [] }).map(({ r, fields }) => ({ number: r.card.number, doc: fields }))
    const field = (k: string): string => `'${k}', doc -> '$.${k}'`
    const rows = db.prepare(`SELECT number, json_object(${HEAD_FIELDS.map(field).join(', ')}) AS doc FROM cards WHERE ${where} ORDER BY number`).all() as { number: number; doc: string }[] // i18n-ignore: SQL
    return rows.map((r) => ({ number: r.number, doc: JSON.parse(r.doc) as Record<string, unknown> }))
  })
}

/**
 * The heads (cardHeadDocs) of the live cards at revision `since` or above (every live card's when null), with every live
 * card's number, the board's mark and its opening, from one snapshot (HI-1909: the readers of each board change, read
 * again only for the cards it touched, as holdChanges does for the usage history). Null on a board with no revisions (a
 * 0.9 board waiting for its upgrade): cardHeadDocs reads it whole.
 */
export function headChanges(ws: WorkspaceService, since: number | null): { generation: number; mark: number; live: number[]; docs: { number: number; doc: Record<string, unknown> }[] } | null {
  return readSnapshot(ws, (b, db) => {
    if (b.legacy) return null
    const mark = (db.prepare('SELECT g FROM board_rev').get() as { g: number }).g // i18n-ignore: SQL
    const live = (db.prepare('SELECT number FROM cards WHERE archived = 0 ORDER BY number').all() as { number: number }[]).map((r) => r.number) // i18n-ignore: SQL
    // The changed ones' numbers by the revision's index alone, then those cards by number (a condition on archived, or
    // readCardRows' ORDER BY, makes SQLite scan every card, each row read whole: decisionChanges), archived ones dropped.
    const changed = since === null ? null : (db.prepare('SELECT number FROM cards WHERE rev >= ?').all(since) as { number: number }[]).map((r) => r.number) // i18n-ignore: SQL
    const sel = changed ? { numbers: changed } : { where: 'archived = 0' } // i18n-ignore: SQL
    const docs = changed?.length === 0 ? [] : cardFields(db, HEAD_FIELDS, { ...sel, parts: [] }).filter(({ r }) => r.card.archived === 0)
    return { generation: b.generation, mark, live, docs: docs.map(({ r, fields }) => ({ number: r.card.number, doc: fields })) }
  })
}

/**
 * These cards' project (as saved), column and agent, each as its document has it (null when it hasn't the field), from
 * their columns: what a change reads of its cards before it (#1216's reads), no document composed.
 */
export function cardHeads(ws: WorkspaceService, numbers: number[]): { number: number; project: unknown; column: unknown; agent: unknown }[] {
  if (!numbers.length) return []
  return readSnapshot(ws, (b, db) => {
    if (!b.legacy) return cardFields(db, ['project', 'column', 'agent'], { numbers, parts: [] }).map(({ r, fields }) => ({ number: r.card.number, project: fields.project, column: fields.column, agent: fields.agent }))
    const rows = db.prepare("SELECT number, doc ->> '$.project' AS project, doc ->> '$.column' AS col, doc ->> '$.agent' AS agent FROM cards WHERE number IN (SELECT value FROM json_each(?))").all(JSON.stringify(numbers)) as { number: number; project: unknown; col: unknown; agent: unknown }[] // i18n-ignore: SQL
    return rows.map((r) => ({ number: r.number, project: r.project, column: r.col, agent: r.agent }))
  })
}

/** How many archived cards each project has (the board's Archived count, without reading them). */
export function archivedCounts(ws: WorkspaceService): { project: string; count: number }[] {
  const { db } = readConn(ws)
  return (db.prepare("SELECT coalesce(project, '') AS project, count(*) AS count FROM cards WHERE archived = 1 GROUP BY project").all() as { project: string; count: number }[]).map((r) => ({ project: String(r.project), count: Number(r.count) })) // i18n-ignore: SQL
}

/**
 * Saves a card's document (inside boardWrite): its rows replaced by the document's (cardRows.ts), then its number in its
 * project given or kept (#1219, keysStep.ts: a new card, or one moved to another project, takes that project's next).
 */
export function putCard(ws: WorkspaceService, n: number, doc: Record<string, unknown>): void {
  writeOp(ws, (b) => {
    if (boardTestHooks.failPut?.(n)) throw new Error(`SQLITE_FULL: database or disk is full (test, card #${n})`) // i18n-ignore: a test's stand-in for SQLite's error
    // Only what changed (#1210): the card as saved, read in this change's transaction, against the card given.
    const db = b.db.writer
    const was = cardPlace(db, n)
    const [before] = readCardRows(db, { numbers: [n] })
    const rows = decomposeCard(n, doc)
    // Moving to another project: its number there comes after (numberCard); the one it had can't follow it in.
    if (was && was.projectNumber !== null && (was.projectId || null) !== (rows.card.project_id || null)) db.prepare('UPDATE cards SET project_number = NULL WHERE number = ?').run(n) // i18n-ignore: SQL
    writeCardChanges(db, before ?? null, rows)
    numberCard(db, n, was)
  })
}

// ---------------------------------------------------------------------------
// Project keys (#1219, #704): the queries are keysStep.ts's; these run them on the board's connections.
// ---------------------------------------------------------------------------

/** Each card's key (`HI-12`), by number: these cards, or all (none for one with no key: a workspace card, a 0.9 board). */
export function cardKeys(ws: WorkspaceService, numbers?: readonly number[]): Map<number, string> {
  return readSnapshot(ws, (b, db) => (b.legacy ? new Map() : keysOfCards(db, numbers)))
}

/**
 * A card's key, with its project as saved: the folder name and the id (the project it is now is the one with that id:
 * projectNow), or null when it has no key.
 */
export function cardKeyOf(ws: WorkspaceService, n: number): { key: string; project: string; projectId: string | null } | null {
  return readSnapshot(ws, (b, db) => {
    if (b.legacy) return null
    const key = keysOfCards(db, [n]).get(n)
    const r = key ? (db.prepare('SELECT project, project_id FROM cards WHERE number = ?').get(n) as { project: string; project_id: string | null } | undefined) : undefined // i18n-ignore: SQL
    return key && r ? { key, project: r.project, projectId: r.project_id } : null
  })
}

/** The names moved cards keep in the projects they left (`HI-1` → card), for the window (#1221). */
export function movedNames(ws: WorkspaceService): Record<string, number> {
  return readSnapshot(ws, (b, db) => (b.legacy ? {} : movedCardNames(db)))
}

/** The card a key names (`HI-12`, any case, an old key or a card's old number in another project too), or null. */
export function cardNamed(ws: WorkspaceService, key: string, number: number): number | null {
  return readSnapshot(ws, (b, db) => (b.legacy ? null : cardOfKey(db, key, number)))
}

/** Every key the projects hold: current and old (aliases), each with its project's id. */
export function projectKeys(ws: WorkspaceService): { key: string; projectId: string; current: boolean }[] {
  return readSnapshot(ws, (b, db) => (b.legacy ? [] : keysHeld(db)))
}

/** Gives projects that have none their key (inside boardWrite): `pick` chooses each from the keys held so far. */
export function addProjectKeys(ws: WorkspaceService, projects: { id: string; pick: (held: { key: string; projectId: string }[]) => string }[]): string[] {
  return writeOp(ws, (b) => {
    const db = b.db.writer
    const have = currentKeys(db)
    const added: string[] = []
    for (const p of projects) {
      if (have.has(p.id)) continue
      const key = p.pick(keysHeld(db))
      addKey(db, p.id, key)
      have.set(p.id, key)
      added.push(key)
    }
    return added
  })
}

/**
 * A card from before 1.0 that has just been given its project's id (#508's stamp, after the upgrade): its own number in
 * its project, as every card from before 1.0 has (#1219), where no card there has it. Inside boardWrite.
 */
export function keepOwnNumber(ws: WorkspaceService, n: number): void {
  writeOp(ws, (b) => {
    const db = b.db.writer
    const c = db.prepare('SELECT project_id FROM cards WHERE number = ?').get(n) as { project_id: string | null } | undefined // i18n-ignore: SQL
    if (!c?.project_id || cardOfKeyIn(db, c.project_id, n) !== null) return
    db.prepare('UPDATE cards SET project_number = ? WHERE number = ?').run(n, n) // i18n-ignore: SQL
  })
}
const cardOfKeyIn = (db: Db['writer'], projectId: string, n: number): number | null =>
  ((db.prepare('SELECT number FROM cards WHERE project_id = ? AND project_number = ? UNION SELECT card FROM card_aliases WHERE project_id = ? AND number = ?').get(projectId, n, projectId, n) as { number: number } | undefined)?.number ?? null) // i18n-ignore: SQL

/** Makes `key` a project's key (inside boardWrite; checked by the caller), its key before kept as an alias. */
export function setProjectKey(ws: WorkspaceService, projectId: string, key: string): void {
  writeOp(ws, (b) => changeKey(b.db.writer, projectId, key))
}

/** Whether the window still has to say that projects have keys now (once, after the upgrade gave them), and saying it. */
export function keysNoticeDue(ws: WorkspaceService): boolean {
  const { b, db } = readConn(ws)
  return !b.legacy && meta(db, 'keys.notice') === 'due'
}
export function keysNoticeSaid(ws: WorkspaceService): void {
  writeOp(ws, (b) => setMeta(b.db.writer, 'keys.notice', 'said'))
}

/** Removes a card (inside boardWrite), and its child rows with it (ON DELETE CASCADE); false when there was none. */
export function deleteCard(ws: WorkspaceService, n: number): boolean {
  return writeOp(ws, (b) => Number(b.db.writer.prepare('DELETE FROM cards WHERE number = ?').run(n).changes) > 0) // i18n-ignore: SQL
}

/** The next card number, taken (inside boardWrite): never one a card has or had. */
export function takeNumber(ws: WorkspaceService): number {
  return writeOp(ws, (b) => takeNumberIn(b.db.writer))
}

/** The next card number, taken on a connection inside its transaction (the fact store's cards, #1215): as takeNumber, but for the stub. */
export function takeNumberIn(db: Db['writer']): number {
  const n = nextOf(db)
  setMeta(db, 'next', String(n + 1))
  return n
}

/** The bulk archives kept, oldest first. */
export function archiveBatchDocs(ws: WorkspaceService): unknown[] {
  const { db } = readConn(ws)
  return (db.prepare('SELECT doc FROM archive_batches ORDER BY seq').all() as { doc: string }[]).map((r) => JSON.parse(r.doc) as unknown) // i18n-ignore: SQL
}

/** Replaces the bulk archives kept (inside boardWrite), oldest first. */
export function setArchiveBatches(ws: WorkspaceService, batches: ArchiveBatch[]): void {
  writeOp(ws, (b) => {
    const db = b.db.writer
    db.exec('DELETE FROM archive_batches')
    const ins = db.prepare('INSERT INTO archive_batches (id, doc) VALUES (?, ?)') // i18n-ignore: SQL
    for (const x of batches) ins.run(x.id, JSON.stringify(x))
  })
}

/**
 * The workspace database's connections, for the stores kept beside the board (#1018, storeRows.ts): opened (and moved in
 * from files) as the board is. Their changes take the board's lock, so they never run inside one of its transactions.
 */
export const workspaceDb = (workspacePath: string): Db => boardOf(workspacePath).db
/** A lease on a workspace's database connection (leaseDb). */
export interface DbLease {
  db: Db
  /** Whether the connection stays open once the lease ends (the workspace's board, not opened for leases alone). */
  readonly kept: boolean
  /** Ends the lease (once; again does nothing): the connection is closed if it was opened for leases, or closed while leased. */
  release(): void
}

/**
 * The workspace database's connection for a save that may come as its workspace closes (a store's last save): a
 * transient open, needing no admission (#1395), so it still lands, leaving nothing open. The lease owns that exact
 * connection (#1383): a board opened for it is closed as its last lease ends unless a window has the workspace open by
 * then (admitted, by the place the board recorded), and a board closed meanwhile (its
 * window closed, or closed and opened again) keeps this connection open for the lease, so its writer is never closed
 * under it, and the lease never closes another opening's board.
 */
export function leaseDb(workspacePath: string): DbLease {
  const b = boardOf(workspacePath, true)
  b.leases++
  // A write under way until the lease ends (HI-1368: a close command waits for it), its connection closed by then.
  const written = beginWrite(workspacePath)
  let ended = false
  return {
    db: b.db,
    get kept() {
      return !b.detached && (!b.transient || isAdmitted(b.place))
    },
    release() {
      if (ended) return
      ended = true
      try {
        if (--b.leases > 0) return
        if (b.detached) b.db.close()
        // Whether a window has the workspace open is asked now, not when the lease began: one may have opened it since,
        // before or after this board was opened, and uses this connection as its board.
        else if (b.transient && !isAdmitted(b.place)) closeOne(keyOf(b.path), b)
      } finally {
        written()
      }
    }
  }
}

/** Runs `fn` with a lease on the workspace database (leaseDb), ended after it, however it ends. */
export async function withLeasedDb<T>(workspacePath: string, fn: (db: Db, lease: DbLease) => Promise<T> | T): Promise<T> {
  const lease = leaseDb(workspacePath)
  try {
    return await fn(lease.db, lease)
  } finally {
    lease.release()
  }
}
/** The lock the board's changes take, which the stores beside it take too. */
export const boardLock = (workspacePath: string): string => `board-lock:${workspacePath}`
/** Whether a workspace's database is open now (its workspace is, or something used it since). */
export const boardOpen = (workspacePath: string): boolean => boards.has(keyOf(workspacePath))
/** Whether this code runs inside a change of that workspace's board. */
export const inBoardWrite = (workspacePath: string): boolean => inWrite(keyOf(workspacePath))

/** The board's file (for the log, diagnostics and tests). */
export const boardFile = (workspacePath: string): string => join(workspacePath, CW_DIR, DB_FILE)

/** Whether the board is shown read-only: saved by a newer Combwork, or waiting for its upgrade to 1.0. */
export const boardReadOnly = (ws: WorkspaceService): boolean => (ws.path ? !writable(boardOf(ws.path).db) : false)

// ---------------------------------------------------------------------------
// The 1.0 upgrade (#1207, SPEC §16.17): asked first, the file locked to this Combwork, the 0.9 copy kept, and a way back.
// ---------------------------------------------------------------------------

/** The board's state for the window: why it is read-only, and the copy kept from before its upgrade to 1.0. */
export function boardState(ws: WorkspaceService): BoardState {
  const path = pathOf(ws)
  const b = boardOf(path)
  const kept = copy09(path)
  return { readOnly: b.db.newer !== null ? 'newer' : b.db.pending ? 'upgrade' : null, backup09: kept ? { at: isoOf(kept.at) } : null }
}

/** The 1.0 group's first version: a copy of the file before it is a 0.9 board. */
const FIRST_10 = Math.min(...BOARD_MIGRATIONS.filter((m) => m.group === UPGRADE_GROUP_ID).map((m) => m.version))

/**
 * The newest copy kept from before the board's upgrade to 1.0: of the group's family, and of a version before the group
 * (by its name; the restore checks the file itself). A copy made before a later step of the group is a 1.0 board's, and
 * db.ts keeps those with the ordinary copies anyway.
 */
const copy09 = (path: string): { file: string; version: number; at: string } | undefined =>
  backupsOf(join(path, CW_DIR, BACKUPS), groupBackupFamily(FAMILY, UPGRADE_GROUP_ID))
    .filter((c) => c.version < FIRST_10)
    .at(-1)

/**
 * The workspace database's generation (#1207 round 2): a number that changes each time its file is replaced under the
 * services (the upgrade to 1.0, Restore the 0.9 Board Backup), whose caches were read from the file before. What a
 * service read in an older generation is stale: it reads again, and a save made from it is refused (`saveStore`'s guard),
 * so nothing written meanwhile (by a 0.9 Hive while the upgrade waited) is overwritten from an old snapshot.
 */
/** By the workspace's place (#1395: a store loaded through another spelling of its folder is the same database's). */
const generations = new Map<string, number>()
/**
 * The generation of a workspace's database by a path entering now: its open board's place, as `replaced` counts it
 * (HI-1797: resolving the path on each call cost a realpath on main's thread, read on every lanes refresh), else the
 * place resolved here.
 */
export const dbGeneration = (workspacePath: string): number => dbGenerationAt(boards.get(keyOf(workspacePath))?.place ?? placeKey(workspacePath))
/** The generation of a workspace's database by the place a caller recorded as it entered. */
export const dbGenerationAt = (place: string): number => generations.get(place) ?? 0
const replacedListeners = new Set<(workspacePath: string, place: string) => void>()
/**
 * Called, under the board's lock and with nothing awaited, once a workspace's database file was replaced: a service
 * drops (or reads again) what it keeps from it, matching by `place` (the replaced board's, as it opened) what it keeps
 * under any spelling. Its saves begun before are refused by their generation.
 */
export function onDbReplaced(fn: (workspacePath: string, place: string) => void): void {
  replacedListeners.add(fn)
}
function replaced(path: string): void {
  const place = boards.get(keyOf(path))?.place ?? placeKey(path)
  generations.set(place, dbGenerationAt(place) + 1)
  for (const fn of replacedListeners) {
    try {
      fn(path, place)
    } catch (e) {
      log.warn('a service following the replaced workspace database', e)
    }
  }
}

/**
 * Whether a workspace's data waits for its upgrade to 1.0 (the user said Not Now): combwork.db then takes no writes, so
 * nothing that must be recorded may start (an agent's session, #1207 round 1). False when the board can't be opened at
 * all: that is told where it is used. Throws the refusal for a workspace no window holds (#1395).
 */
export function upgradeWaiting(workspacePath: string): boolean {
  try {
    return !!boardOf(workspacePath).db.pending
  } catch (e) {
    // A workspace no window holds (#1395) is refused, never taken for one with nothing pending.
    if (isRefusal(e)) throw e
    return false
  }
}

/**
 * Whether a workspace's board waits for its upgrade to 1.0 (HI-1694): its tables are still 0.9's and it takes no writes,
 * so background work for the workspace (the line updater, metrics, the opening's board steps) waits for it too, and runs
 * once it is upgraded. False for a workspace no window holds (its work stops on that anyway) or with no board.
 */
export function boardWaits(ws: WorkspaceService): boolean {
  if (!ws.path) return false
  try {
    return upgradeWaiting(ws.path)
  } catch {
    return false
  }
}

/** Throws the user's reason when the workspace's upgrade to 1.0 waits: for what can't run without combwork.db (an agent's start). */
export function assertUpgraded(workspacePath: string): void {
  if (upgradeWaiting(workspacePath)) throw combworkError(M.upgradeFirstStart, undefined, { kind: 'conflict' })
}

/** A copy's time as its name has it (`2026-10-20T14-06-21-256Z`), as ISO. */
const isoOf = (at: string): string => at.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z$/, 'T$1:$2:$3.$4Z')

/** The user's errors for another Combwork on the file (SQLite's lock or a fresh presence marker). */
const inUse = (e: unknown): boolean => e instanceof DbInUseError || e instanceof OtherCombworkError

const upgradedListeners = new Set<(ws: WorkspaceService) => void>()
/**
 * Called once a workspace's board was upgraded (#1621), after its lock is let go: what a service skipped as the
 * workspace opened, its board then read-only (the merge queues, the repairs that write), it runs now, without a restart.
 * Returns the unsubscribe.
 */
export function onBoardUpgraded(fn: (ws: WorkspaceService) => void): () => void {
  upgradedListeners.add(fn)
  return () => upgradedListeners.delete(fn)
}

/**
 * Upgrades the board to 1.0, the user having said yes: under the board's lock (no change of it under way), the board
 * closed and opened again with the 1.0 group approved, which db.ts runs with the file locked to this Combwork, after a copy
 * kept for good, in one transaction. Another Combwork with the workspace open: refused, nothing changed, and the board opens
 * read-only again. Replies with the kept copy's file.
 */
export async function upgradeBoard(ws: WorkspaceService): Promise<{ backup: string | null }> {
  const path = pathOf(ws)
  const key = keyOf(path)
  const started = performance.now()
  let upgraded = false
  // Counted as a write (HI-1368): a close command waits for it.
  const out = await countedWrite(path, () => withFileLock(boardLock(path), async () => {
    const pending = boardOf(path).db.pending
    if (!pending) return { backup: null }
    const from09 = pending.from < FIRST_10
    // The group runs with the file locked to one connection: the checkpoints' worker lets go of it first (HI-1691),
    // awaited before the close, so nothing opens it again between the close and the upgrade's open.
    await checkpointsReleased(join(path, CW_DIR, DB_FILE))
    // Opened for keeps: only while a window holds it (#1395), checked after that wait, nothing awaited since.
    assertAdmitted(join(path, CW_DIR, DB_FILE))
    closeBoard(path)
    try {
      openBoard(path, true)
    } catch (e) {
      // Opened again as it was (read-only, its upgrade waiting); a failure there is the board's to tell.
      failures.delete(key)
      if (inUse(e)) {
        log.info(`the board of ${userText(path)} wasn't upgraded: another Combwork has it open`)
        boardOf(path)
        throw combworkError(M.inUse, undefined, { kind: 'conflict' })
      }
      log.error(`upgrading the board of ${userText(path)}`, e)
      boardOf(path)
      throw combworkError(M.unavailable, { error: e instanceof Error ? e.message : String(e) }, { kind: 'conflict' })
    }
    // A 0.9 board's copy is the one kept for good; a 1.0 board taking a later step of the group gets an ordinary one.
    const kept = from09 ? copy09(path) : undefined
    log.info(`upgraded the board of ${userText(path)} to 1.0 (from v${pending.from}) in ${Math.round(performance.now() - started)} ms; ${kept ? `the 0.9 board is kept as ${basename(kept.file)}` : 'it was a 1.0 board already'}`)
    replaced(path)
    upgraded = true
    return { backup: kept?.file ?? null }
  }))
  emit({ type: 'tasks-changed', workspacePath: path })
  if (upgraded) for (const fn of upgradedListeners) {
    try {
      fn(ws)
    } catch (e) {
      log.warn('a service following the upgraded board', e)
    }
  }
  return out
}

/**
 * Help → Restore the 0.9 Board Backup… (SPEC §16.17): the board as it is now copied aside first (kept for good), then the
 * copy made before its upgrade to 1.0 put back in its place, and the board opened again: read-only in this Hive (its
 * upgrade waiting again), writable for a 0.9 Hive. Nothing is deleted. Refused while another Combwork has the workspace open:
 * it would go on with the 1.0 file under the copy put back. Replies with the copy of the 1.0 board.
 */
export async function restoreBoardBackup(ws: WorkspaceService, agentsRunning: () => number): Promise<{ saved: string; restored: string }> {
  const path = pathOf(ws)
  const combwork = join(path, CW_DIR)
  const file = join(combwork, DB_FILE)
  // Counted as a write (HI-1368): a close command waits for it.
  const out = await countedWrite(path, () => withFileLock(boardLock(path), async () => {
    // Opened first: an open is what upgrades it (a test copy's answer), and so makes its copy.
    const version = schemaVersion(boardOf(path).db.reader)
    const kept = copy09(path)
    // The file itself, not only its name: a 0.9 board, which a 0.9 Hive can change again.
    if (!kept || !(fileSchemaVersion(kept.file) < FIRST_10)) throw combworkError(M.noBackup, undefined, { kind: 'conflict' })
    // The board put back takes no writes here: an agent running on would go unrecorded. Starts are refused from then on.
    if (agentsRunning() > 0) throw combworkError(M.stopAgentsFirst, undefined, { kind: 'conflict' })
    if (othersPresent(combwork, presenceId()).length) throw combworkError(M.inUse, undefined, { kind: 'conflict' })
    // Copied as its only connection, then replaced: the checkpoints' worker lets go of it first (HI-1691), awaited
    // before the close, so nothing opens it again between the close and the copy.
    await checkpointsReleased(file)
    // As they are after that wait: still a window's (#1395, HR6's round 3: closed meanwhile, nothing is changed), and no
    // agent or other Combwork on it.
    assertAdmitted(file)
    if (agentsRunning() > 0) throw combworkError(M.stopAgentsFirst, undefined, { kind: 'conflict' })
    if (othersPresent(combwork, presenceId()).length) throw combworkError(M.inUse, undefined, { kind: 'conflict' })
    closeBoard(path)
    let saved: string
    try {
      saved = soleCopy(file, join(combwork, BACKUPS), RESTORE_FAMILY, version)
    } catch (e) {
      failures.delete(keyOf(path))
      boardOf(path)
      if (e instanceof DbInUseError) throw combworkError(M.inUse, undefined, { kind: 'conflict' })
      throw e
    }
    // Closed by its only connection, SQLite has folded its log back in and removed it: what is left of one is another
    // process's, which opened the file meanwhile.
    if (existsSync(`${file}-wal`)) {
      boardOf(path)
      throw combworkError(M.inUse, undefined, { kind: 'conflict' })
    }
    const next = `${file}.restoring`
    copyFileSync(kept.file, next)
    rmSync(`${file}-shm`, { force: true })
    renameSync(next, file)
    failures.delete(keyOf(path))
    boardOf(path)
    log.info(`put the 0.9 board back in ${userText(path)} (${basename(kept.file)}); the 1.0 board is kept as ${basename(saved)}`)
    replaced(path)
    return { saved, restored: kept.file }
  }))
  emit({ type: 'tasks-changed', workspacePath: path })
  return out
}

/**
 * Exports the board to plain files (Export Board to JSON): a folder with `<n>.json` for each card, exactly as the cards'
 * files were before 0.9 (so an older Hive can read them), with board.json and archive-batches.json. Returns how many cards.
 */
export async function exportBoard(ws: WorkspaceService, dir: string, mask: <T>(v: T) => T = (v) => v): Promise<number> {
  // Its cards, next number and batches as one snapshot of the board.
  const { docs, next, batches } = readSnapshot(ws, (_b, db) => ({ docs: cardDocs(ws), next: nextOf(db), batches: archiveBatchDocs(ws) }))
  await mkdir(dir, { recursive: true })
  // `mask`: each value masked before it is written (HI-1772: no server connection's key in an export).
  for (const { number, doc } of docs) await writeFile(join(dir, `${number}.json`), JSON.stringify(mask(doc), null, 2) + '\n', 'utf8')
  await writeFile(join(dir, 'board.json'), JSON.stringify({ version: 1, next }, null, 2) + '\n', 'utf8')
  if (batches.length) await writeFile(join(dir, 'archive-batches.json'), JSON.stringify({ version: 1, batches: mask(batches) }, null, 2) + '\n', 'utf8')
  log.info(`exported ${docs.length} card(s) to ${userText(dir)}`)
  return docs.length
}
