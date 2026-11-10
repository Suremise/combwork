import type { DatabaseSync } from 'node:sqlite'

/**
 * jj's integrations' durable records (HI-2882's J9b2, design HI-2882/s10–s22; boardStore.ts BOARD_MIGRATIONS version 29),
 * each keyed by the project's canonical id, so two projects' targets of one name never share a row:
 * - `jj_obligations`: HI-2873's publish obligations (one per Integrated fact's card, cycle and bundle), their state and
 *   what a settle was based on; indexed for the bounded reads (owed rows by target, settled rows by target and seq);
 * - `jj_oblig_targets`: per project and target, the settle sequence and the re-check sweep (its generation and range);
 * - `jj_retained`: the retained proof bundles of Integrated jj cards, each with when it was last verified and how, for the
 *   fair retention pass (oldest first).
 * Created only when missing (a board whose later steps are run again takes it again).
 */
export const JJ_PUBLISH_STEP = { name: 'jj publish records', up: addJjPublishTables } as const

export function addJjPublishTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jj_obligations (
      project TEXT NOT NULL,
      card TEXT NOT NULL,
      cycle INTEGER NOT NULL,
      bundle TEXT NOT NULL,
      target TEXT NOT NULL,
      result TEXT NOT NULL,
      since INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('owed', 'published', 'notHeld', 'checkThis')),
      pushed TEXT,
      at INTEGER,
      seq INTEGER,
      seen TEXT,
      "check" TEXT,
      PRIMARY KEY (project, card, cycle, bundle)
    );
    CREATE INDEX IF NOT EXISTS jj_obligations_state ON jj_obligations (project, target, state);
    CREATE INDEX IF NOT EXISTS jj_obligations_seq ON jj_obligations (project, target, seq);
    CREATE TABLE IF NOT EXISTS jj_oblig_targets (
      project TEXT NOT NULL,
      target TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0,
      gen INTEGER NOT NULL DEFAULT 0,
      after INTEGER NOT NULL DEFAULT 0,
      "end" INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project, target)
    );
    CREATE TABLE IF NOT EXISTS jj_retained (
      project TEXT NOT NULL,
      card TEXT NOT NULL,
      cycle INTEGER NOT NULL,
      bundle TEXT NOT NULL,
      checked_at INTEGER NOT NULL DEFAULT 0,
      outcome TEXT,
      PRIMARY KEY (project, card, cycle, bundle)
    );
    CREATE INDEX IF NOT EXISTS jj_retained_due ON jj_retained (project, checked_at);
  `) // i18n-ignore: SQL
}
