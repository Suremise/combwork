/**
 * hive.db's 1.0 schema (#1208, SPEC §16.12, §16.4, §16.17; #1025, #704, #1119): every table P3's migration makes, grouped
 * into the steps the storage cards register in `BOARD_MIGRATIONS`, in this order (each takes the next version number when
 * it merges, never out of order: db.ts skips a version below the file's). #1207's 1.0 group runs them in one
 * transaction, after one ask, one backup and one exclusive lock. Registered so far: the cards step (#1209, cardsStep.ts).
 *
 * Each step's `ddl` makes its tables on a file that has today's (0.9) schema: the step that copies data into them
 * (moving today's `cards` aside first, `store_rows` rows into the typed tables) is the registering card's. Which module
 * owns each table, and what stays JSON and why, is in docs/ARCHITECTURE.md (Storage).
 *
 * Conventions: STRICT tables; a card's child rows reference `cards(number)` ON DELETE CASCADE (a card's facts, comments
 * and the rest go only with the card itself: Delete permanently); `ord` is an entry's place in its list, from 0; times
 * are ISO strings as today; keys compare case-insensitively (COLLATE NOCASE); a typed store row keeps the fields this
 * build has no column for in `extra` (a JSON object), so an older Hive saving a newer one's row loses nothing.
 *
 * `QUERIES` are the modules' real queries against these tables, each with the index it must use: tests/schemaV1_0.test.ts
 * checks every one with EXPLAIN QUERY PLAN, and the modules import them from here as they move onto the tables.
 */

export interface SchemaStep {
  /** The step's name in `schema_version` (and BOARD_MIGRATIONS). */
  name: string
  ddl: string[]
}

/** Cards in typed columns and child tables (#1025), replacing today's `cards` (a JSON document with generated columns). */
export const CARDS_STEP: SchemaStep = {
  name: 'cards in tables',
  ddl: [
    // The card itself. `number` is the card's permanent global number (`#N`, never reused; P8 keeps it as the internal id
    // and alias). `col` is the category (today's column, kept for every reader), `stage` the 1.0 stage cached from the
    // facts (null for a card no 1.0 rule has moved). `extra`/`layout`: the card JSON contract (cardRows.ts).
    `CREATE TABLE cards (
      number            INTEGER PRIMARY KEY,
      title             TEXT    NOT NULL,
      description       TEXT    NOT NULL,
      project           TEXT    NOT NULL,
      project_id        TEXT,
      agent             TEXT,
      agent_name        TEXT,
      review_agent      TEXT,
      review_agent_name TEXT,
      review_since      TEXT,
      col               TEXT    NOT NULL,
      stage             TEXT,
      ord               REAL    NOT NULL,
      blocked           TEXT,
      archived          INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
      archived_for      TEXT,
      archived_batch    TEXT,
      context_problems  TEXT,
      pre_workflow      INTEGER NOT NULL DEFAULT 0 CHECK (pre_workflow IN (0, 1)),
      created_at        TEXT    NOT NULL,
      created_by        TEXT    NOT NULL,
      updated_at        TEXT    NOT NULL,
      extra             TEXT,
      layout            TEXT
    ) STRICT`,
    'CREATE INDEX cards_place ON cards (archived, col, ord)',
    'CREATE INDEX cards_project ON cards (project_id, archived)',
    'CREATE INDEX cards_archived_project ON cards (archived, project)',
    'CREATE INDEX cards_agent ON cards (agent) WHERE agent IS NOT NULL',
    'CREATE INDEX cards_reviewer ON cards (review_agent) WHERE review_agent IS NOT NULL',
    'CREATE INDEX cards_updated ON cards (updated_at)',
    // Labels as a table, not a JSON array: cards by label is a real query (a lane or a search by `1.0.0`), and a label's
    // rename or removal across the board is one statement.
    `CREATE TABLE card_labels (
      card  INTEGER NOT NULL REFERENCES cards (number) ON DELETE CASCADE,
      ord   INTEGER NOT NULL,
      label TEXT    NOT NULL,
      PRIMARY KEY (card, ord)
    ) STRICT, WITHOUT ROWID`,
    'CREATE INDEX card_labels_label ON card_labels (label, card)',
    // blockedBy and links. `target` has no foreign key: a reference to a card deleted meanwhile stays until its card is
    // saved (readers leave it out, as today), and numbers are never reused.
    `CREATE TABLE card_links (
      card   INTEGER NOT NULL REFERENCES cards (number) ON DELETE CASCADE,
      kind   TEXT    NOT NULL CHECK (kind IN ('blockedBy', 'link')),
      ord    INTEGER NOT NULL,
      target INTEGER NOT NULL,
      PRIMARY KEY (card, kind, ord)
    ) STRICT, WITHOUT ROWID`,
    'CREATE INDEX card_links_target ON card_links (target, kind)',
    `CREATE TABLE card_context (
      card INTEGER NOT NULL REFERENCES cards (number) ON DELETE CASCADE,
      ord  INTEGER NOT NULL,
      ref  TEXT    NOT NULL,
      PRIMARY KEY (card, ord)
    ) STRICT, WITHOUT ROWID`,
    // Entries: typed columns, and `raw` (the entry's exact JSON) for one not of Hive's form (cardRows.ts).
    `CREATE TABLE card_comments (
      card      INTEGER NOT NULL REFERENCES cards (number) ON DELETE CASCADE,
      ord       INTEGER NOT NULL,
      at        TEXT,
      by        TEXT,
      text      TEXT,
      hive_text TEXT,
      id        TEXT,
      raw       TEXT,
      PRIMARY KEY (card, ord)
    ) STRICT, WITHOUT ROWID`,
    `CREATE TABLE card_history (
      card      INTEGER NOT NULL REFERENCES cards (number) ON DELETE CASCADE,
      ord       INTEGER NOT NULL,
      at        TEXT,
      by        TEXT,
      what      TEXT,
      what_text TEXT,
      id        TEXT,
      raw       TEXT,
      PRIMARY KEY (card, ord)
    ) STRICT, WITHOUT ROWID`,
    'CREATE INDEX card_history_at ON card_history (at)',
    `CREATE TABLE card_decisions (
      card        INTEGER NOT NULL REFERENCES cards (number) ON DELETE CASCADE,
      ord         INTEGER NOT NULL,
      id          TEXT,
      text        TEXT,
      decided_by  TEXT,
      recorded_by TEXT,
      at          TEXT,
      edited_at   TEXT,
      raw         TEXT,
      PRIMARY KEY (card, ord)
    ) STRICT, WITHOUT ROWID`,
    // Holds in their own table (#1107's measurement): costs read every card's holds without parsing a document.
    `CREATE TABLE card_holds (
      card    INTEGER NOT NULL REFERENCES cards (number) ON DELETE CASCADE,
      ord     INTEGER NOT NULL,
      agent   TEXT,
      name    TEXT,
      role    TEXT,
      from_at TEXT,
      to_at   TEXT,
      raw     TEXT,
      PRIMARY KEY (card, ord)
    ) STRICT, WITHOUT ROWID`
  ]
}

/** Sessions and deliveries out of `store_rows` (#1025's extended scope): a host is a project's stable id or `assistant` (deliveries also `folder:<name>`). */
const SESSIONS_DELIVERIES: SchemaStep = {
  name: 'sessions and deliveries in tables',
  ddl: [
    // SessionRecord. `provider` is its `agent` field (a ProviderId); `kept_usage` and `screen_stops` stay JSON: a usage
    // snapshot read whole with its session and never queried (usage.db keeps the queryable history), and a short list
    // of stops the safeguards read whole.
    `CREATE TABLE sessions (
      host             TEXT    NOT NULL,
      id               TEXT    NOT NULL,
      ord              INTEGER NOT NULL,
      provider         TEXT    NOT NULL,
      name             TEXT    NOT NULL,
      agent_id         TEXT,
      agent_name       TEXT,
      mode             TEXT,
      cwd              TEXT,
      branch           TEXT,
      transcript_path  TEXT,
      handed_over_from TEXT,
      parent_id        TEXT,
      sub_kind         TEXT,
      archived         INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
      created_at       TEXT    NOT NULL,
      last_active_at   TEXT    NOT NULL,
      kept_usage       TEXT,
      screen_stops     TEXT,
      extra            TEXT,
      PRIMARY KEY (host, id)
    ) STRICT, WITHOUT ROWID`,
    'CREATE INDEX sessions_agent ON sessions (host, agent_id, last_active_at)',
    // The cards a session worked on (SessionRecord.cards): sessions by card.
    `CREATE TABLE session_cards (
      host    TEXT    NOT NULL,
      session TEXT    NOT NULL,
      ord     INTEGER NOT NULL,
      card    INTEGER NOT NULL,
      title   TEXT    NOT NULL,
      review  INTEGER NOT NULL DEFAULT 0 CHECK (review IN (0, 1)),
      PRIMARY KEY (host, session, ord),
      FOREIGN KEY (host, session) REFERENCES sessions (host, id) ON DELETE CASCADE
    ) STRICT, WITHOUT ROWID`,
    'CREATE INDEX session_cards_card ON session_cards (card)',
    // Deleted sessions' ids (SessionsFile.deleted) and the usage kept of deleted ones (deletedUsage, KeptUsage).
    `CREATE TABLE sessions_deleted (
      host TEXT    NOT NULL,
      id   TEXT    NOT NULL,
      ord  INTEGER NOT NULL,
      PRIMARY KEY (host, id)
    ) STRICT, WITHOUT ROWID`,
    `CREATE TABLE sessions_deleted_usage (
      host       TEXT    NOT NULL,
      id         TEXT    NOT NULL,
      ord        INTEGER NOT NULL,
      provider   TEXT    NOT NULL,
      name       TEXT    NOT NULL,
      agent_id   TEXT,
      agent_name TEXT,
      cwd        TEXT,
      usage      TEXT    NOT NULL,
      extra      TEXT,
      PRIMARY KEY (host, id)
    ) STRICT, WITHOUT ROWID`,
    // DeliveryRecord. `sender` (DeliverySender, a small tagged object) and `meta` (its source's few facts) stay JSON:
    // read whole with the delivery, never queried. `action`: the card_actions row that made it (SPEC §16.4.5: a wake is a
    // delivery with its action's id, deduplicated by it).
    `CREATE TABLE deliveries (
      host         TEXT    NOT NULL,
      id           TEXT    NOT NULL,
      seq          INTEGER NOT NULL,
      agent_id     TEXT    NOT NULL,
      agent_name   TEXT,
      conversation TEXT,
      kind         TEXT    NOT NULL,
      sender       TEXT    NOT NULL,
      card         INTEGER,
      round        INTEGER,
      body         TEXT    NOT NULL,
      state        TEXT    NOT NULL,
      created      TEXT    NOT NULL,
      expires      TEXT    NOT NULL,
      offered      TEXT,
      offers       INTEGER,
      received     TEXT,
      received_via TEXT,
      offer_run    TEXT,
      acked        TEXT,
      ended        TEXT,
      detail       TEXT,
      again        TEXT,
      source       TEXT,
      ref          TEXT,
      meta         TEXT,
      need         TEXT,
      for_run      TEXT,
      action       INTEGER,
      extra        TEXT,
      PRIMARY KEY (host, id)
    ) STRICT, WITHOUT ROWID`,
    'CREATE INDEX deliveries_agent ON deliveries (host, agent_id, seq)',
    'CREATE INDEX deliveries_state ON deliveries (host, state, seq)',
    'CREATE INDEX deliveries_source ON deliveries (host, source, ref) WHERE source IS NOT NULL',
    'CREATE INDEX deliveries_card ON deliveries (card, round) WHERE card IS NOT NULL',
    // The 7-day expiry: received and unacked by `received`, ended ones by `ended` (deliveries.ts prune).
    'CREATE INDEX deliveries_received ON deliveries (received) WHERE received IS NOT NULL AND acked IS NULL',
    'CREATE INDEX deliveries_ended ON deliveries (host, agent_id, ended) WHERE ended IS NOT NULL',
    'CREATE UNIQUE INDEX deliveries_action ON deliveries (action) WHERE action IS NOT NULL'
  ]
}

/** Lanes, watches and metrics out of `store_rows`. */
const LANES_WATCHES_METRICS: SchemaStep = {
  name: 'lanes, watches and metrics in tables',
  ddl: [
    `CREATE TABLE lanes (
      id            TEXT    PRIMARY KEY,
      ord           INTEGER NOT NULL,
      project       TEXT    NOT NULL,
      project_id    TEXT,
      name          TEXT,
      builder_id    TEXT    NOT NULL,
      builder_name  TEXT    NOT NULL,
      reviewer_id   TEXT,
      reviewer_name TEXT,
      rounds        INTEGER NOT NULL,
      wait_minutes  INTEGER NOT NULL,
      state         TEXT    NOT NULL CHECK (state IN ('active', 'ended', 'abandoned')),
      started_by    TEXT    NOT NULL,
      started_at    TEXT    NOT NULL,
      updated_at    TEXT    NOT NULL,
      ended_at      TEXT,
      merge_commit  TEXT,
      extra         TEXT
    ) STRICT, WITHOUT ROWID`,
    'CREATE INDEX lanes_builder ON lanes (project_id, builder_id, state)',
    'CREATE INDEX lanes_reviewer ON lanes (project_id, reviewer_id, state) WHERE reviewer_id IS NOT NULL',
    'CREATE INDEX lanes_state ON lanes (state, ended_at)',
    // A lane's cards in order (Hive owns the list, SPEC §16.11.1), and the snapshot an ended lane keeps (`frozen`).
    `CREATE TABLE lane_cards (
      lane TEXT    NOT NULL REFERENCES lanes (id) ON DELETE CASCADE,
      ord  INTEGER NOT NULL,
      card INTEGER NOT NULL,
      PRIMARY KEY (lane, ord)
    ) STRICT, WITHOUT ROWID`,
    'CREATE INDEX lane_cards_card ON lane_cards (card)',
    `CREATE TABLE lane_frozen (
      lane      TEXT    NOT NULL REFERENCES lanes (id) ON DELETE CASCADE,
      ord       INTEGER NOT NULL,
      card      INTEGER NOT NULL,
      title     TEXT    NOT NULL,
      col       TEXT    NOT NULL,
      blocked   TEXT,
      round     INTEGER NOT NULL,
      reviewing INTEGER NOT NULL CHECK (reviewing IN (0, 1)),
      PRIMARY KEY (lane, ord)
    ) STRICT, WITHOUT ROWID`,
    // WatchRecord: one per (project folder, agent). Its condition and marks stay JSON (`cond`, `marks`, `agents`,
    // `agent_marks`, `lanes`, `lane_marks`, `seen`, `on_cards`, `released`, `fired`): each watch's own view of what it
    // watches, written and read whole with it and capped small (20 cards), never queried across watches. What is queried
    // has a column or a table: the cards watched (watch_cards), the limit, and whether it fired and was delivered.
    `CREATE TABLE watches (
      id             TEXT    PRIMARY KEY,
      ord            INTEGER NOT NULL,
      project_path   TEXT    NOT NULL COLLATE NOCASE,
      project_id     TEXT,
      agent_id       TEXT    NOT NULL,
      watcher_name   TEXT,
      since          TEXT    NOT NULL,
      limit_minutes  INTEGER NOT NULL,
      limit_at       TEXT    NOT NULL,
      wait_seq       INTEGER,
      lane_since     TEXT,
      self           TEXT,
      reply_seq      INTEGER,
      cond           TEXT    NOT NULL,
      marks          TEXT    NOT NULL,
      agents         TEXT,
      agent_marks    TEXT,
      lanes          TEXT,
      lane_marks     TEXT,
      seen           TEXT,
      on_cards       TEXT,
      released       TEXT,
      fired          TEXT,
      fired_delivery TEXT,
      extra          TEXT
    ) STRICT, WITHOUT ROWID`,
    'CREATE UNIQUE INDEX watches_agent ON watches (project_path, agent_id)',
    'CREATE INDEX watches_limit ON watches (limit_at) WHERE fired IS NULL',
    'CREATE INDEX watches_delivery ON watches (fired_delivery) WHERE fired_delivery IS NOT NULL',
    `CREATE TABLE watch_cards (
      watch TEXT    NOT NULL REFERENCES watches (id) ON DELETE CASCADE,
      card  INTEGER NOT NULL,
      PRIMARY KEY (watch, card)
    ) STRICT, WITHOUT ROWID`,
    'CREATE INDEX watch_cards_card ON watch_cards (card)',
    // Metrics: a bucket per span and start, a row per series in it. A series' identity is typed (part: '' for the
    // workspace's own, else a project's name, as metrics.ts keys them and droppedBy does; family: api, mcp, guidance,
    // catalog; key: the series' key in its family) and its counters stay JSON (`data`, with the histogram): aggregated
    // in memory, saved as a unit, never summed by SQL.
    `CREATE TABLE metrics_buckets (
      span       TEXT    NOT NULL CHECK (span IN ('hour', 'day')),
      start      INTEGER NOT NULL,
      dropped    INTEGER NOT NULL DEFAULT 0,
      dropped_by TEXT    NOT NULL DEFAULT '{}',
      series     INTEGER NOT NULL DEFAULT 0,
      skills     TEXT    NOT NULL,
      extra      TEXT,
      PRIMARY KEY (span, start)
    ) STRICT, WITHOUT ROWID`,
    'CREATE INDEX metrics_buckets_start ON metrics_buckets (start)',
    `CREATE TABLE metrics_series (
      span   TEXT    NOT NULL,
      start  INTEGER NOT NULL,
      part   TEXT    NOT NULL,
      family TEXT    NOT NULL CHECK (family IN ('api', 'mcp', 'guidance', 'catalog')),
      key    TEXT    NOT NULL,
      data   TEXT    NOT NULL,
      PRIMARY KEY (span, start, part, family, key),
      FOREIGN KEY (span, start) REFERENCES metrics_buckets (span, start) ON DELETE CASCADE
    ) STRICT, WITHOUT ROWID`
  ]
}

/** The fact log, durable actions and rulesets (SPEC §16.4), from the P2 spike's factStore.ts, in hive.db. */
export const FACTS_STEP: SchemaStep = {
  name: 'facts',
  ddl: [
    // A fact: `seq` per card from 1; `dedupe` only on observed facts (`prev:<seq>`, `cycle:<seq>`, `commit:<id>`, a mark's
    // own), unique per card and kind (SPEC §16.17). `data` stays JSON: each kind has its own fields, with the platform's
    // opaque `data.platform`, and facts are read whole, per card, into the fold. The rowid is the order written (the
    // merge queue rebuilds from IntegrationRequested facts in that order).
    `CREATE TABLE card_facts (
      card    INTEGER NOT NULL REFERENCES cards (number) ON DELETE CASCADE,
      seq     INTEGER NOT NULL,
      kind    TEXT    NOT NULL,
      at      TEXT    NOT NULL,
      actor   TEXT    NOT NULL,
      source  TEXT    NOT NULL CHECK (source IN ('recorded', 'observed')),
      ruleset TEXT    REFERENCES rulesets (id),
      dedupe  TEXT,
      data    TEXT    NOT NULL,
      UNIQUE (card, seq)
    ) STRICT`,
    'CREATE UNIQUE INDEX card_facts_dedupe ON card_facts (card, kind, dedupe) WHERE dedupe IS NOT NULL',
    'CREATE INDEX card_facts_kind ON card_facts (kind)',
    // Durable actions (SPEC §16.4.5), written with the facts that cause them; the worker runs pending ones in id order.
    // AUTOINCREMENT: an id is never given again, even after its card (and the action) is deleted, since the delivery
    // it made outlives it and deliveries are deduplicated by action id (HR4's round 1 finding 1).
    `CREATE TABLE card_actions (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      card     INTEGER NOT NULL REFERENCES cards (number) ON DELETE CASCADE,
      kind     TEXT    NOT NULL,
      payload  TEXT    NOT NULL,
      state    TEXT    NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done', 'failed', 'cancelled')),
      attempts INTEGER NOT NULL DEFAULT 0,
      fact     INTEGER
    ) STRICT`,
    "CREATE INDEX card_actions_pending ON card_actions (id) WHERE state = 'pending'",
    'CREATE INDEX card_actions_card ON card_actions (card)',
    // A compiled ruleset, stored once by its hash: a document whose pieces are looked up by id, read whole (SPEC §16.5.4).
    'CREATE TABLE rulesets (id TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT, WITHOUT ROWID',
    // Commits seen on a shared folder's line and whose they are (CommitAttributed, SPEC §16.3.2): each recorded once,
    // in the order seen (`id`, never reused): the Git adapter reads a folder's commits in that order to find the work
    // after the last submitted one (gitPlatform.ts), which no order of the SHAs gives (HR4's round 1 finding 2).
    `CREATE TABLE folder_commits (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      folder TEXT    NOT NULL COLLATE NOCASE,
      sha    TEXT    NOT NULL,
      card   INTEGER,
      how    TEXT    NOT NULL,
      UNIQUE (folder, sha)
    ) STRICT`,
    'CREATE INDEX folder_commits_seen ON folder_commits (folder, id)',
    // What the runtime keeps of a card besides its document (#1215; the Assistant for Darren, 20 Oct: typed, never JSON).
    // Columns of the card's row outside its JSON document, as `stage`: the Agent API's card is unchanged, and tasks.ts'
    // saves of the document keep them. `kind` code or no-code (§16.4.2); `target` a per-card target (OP-12); `lane` the
    // runtime's lane whose ruleset the card uses and `lane_reviewer` its reviewer to wake (§16.11.1), until P4 wires the
    // runtime to lanes.ts; `paths_declared` whether None's declared paths were ever set (an empty list is a declaration).
    "ALTER TABLE cards ADD COLUMN kind TEXT NOT NULL DEFAULT 'code' CHECK (kind IN ('code', 'no-code'))",
    'ALTER TABLE cards ADD COLUMN target TEXT',
    'ALTER TABLE cards ADD COLUMN lane TEXT',
    'ALTER TABLE cards ADD COLUMN lane_reviewer TEXT',
    'ALTER TABLE cards ADD COLUMN paths_declared INTEGER NOT NULL DEFAULT 0 CHECK (paths_declared IN (0, 1))',
    // None's paths of a card (§16.3.3): those it declared, and the pre-fill Hive saw it edit; the watcher and None's
    // checks ask which cards hold a path.
    `CREATE TABLE card_paths (
      card INTEGER NOT NULL REFERENCES cards (number) ON DELETE CASCADE,
      kind TEXT    NOT NULL CHECK (kind IN ('declared', 'prefill')),
      ord  INTEGER NOT NULL,
      path TEXT    NOT NULL,
      PRIMARY KEY (card, kind, path)
    ) STRICT, WITHOUT ROWID`,
    'CREATE INDEX card_paths_path ON card_paths (path)',
    // The runtime's lanes (§16.11.1: their cards in order, the ruleset they started with, the card in flight, a list
    // change queued for the next boundary), per project, until P4 makes lanes.ts' lanes the runtime's.
    `CREATE TABLE workflow_lanes (
      project     TEXT    NOT NULL COLLATE NOCASE,
      id          TEXT    NOT NULL,
      ruleset     TEXT    NOT NULL,
      current     INTEGER,
      ended       INTEGER NOT NULL DEFAULT 0 CHECK (ended IN (0, 1)),
      has_pending INTEGER NOT NULL DEFAULT 0 CHECK (has_pending IN (0, 1)),
      PRIMARY KEY (project, id)
    ) STRICT, WITHOUT ROWID`,
    `CREATE TABLE workflow_lane_cards (
      project TEXT    NOT NULL COLLATE NOCASE,
      lane    TEXT    NOT NULL,
      list    TEXT    NOT NULL CHECK (list IN ('cards', 'pending')),
      ord     INTEGER NOT NULL,
      card    INTEGER NOT NULL,
      PRIMARY KEY (project, lane, list, ord),
      FOREIGN KEY (project, lane) REFERENCES workflow_lanes (project, id) ON DELETE CASCADE
    ) STRICT, WITHOUT ROWID`,
    // A target's merge queue paused (P7's queue, §16.9): why, by which card, the files a conflict named.
    `CREATE TABLE workflow_queue_pauses (
      project TEXT NOT NULL COLLATE NOCASE,
      target  TEXT NOT NULL,
      reason  TEXT NOT NULL,
      card    TEXT NOT NULL,
      PRIMARY KEY (project, target)
    ) STRICT, WITHOUT ROWID`,
    `CREATE TABLE workflow_queue_pause_files (
      project TEXT    NOT NULL COLLATE NOCASE,
      target  TEXT    NOT NULL,
      ord     INTEGER NOT NULL,
      path    TEXT    NOT NULL,
      PRIMARY KEY (project, target, ord),
      FOREIGN KEY (project, target) REFERENCES workflow_queue_pauses (project, target) ON DELETE CASCADE
    ) STRICT, WITHOUT ROWID`,
    // Each action's delivery, recorded once before its effect runs, so a run twice delivers once (§16.4.5). Transitional:
    // #1211's typed deliveries (unique `action`) replace it when P4 wires wakes.
    'ALTER TABLE card_actions ADD COLUMN delivered TEXT',
    'CREATE INDEX card_actions_delivered ON card_actions (id) WHERE delivered IS NOT NULL'
  ]
}

/** Project keys, per-project numbers and aliases (#704, SPEC §16.12; Darren, 20 Oct: existing cards keep their number in their own project). */
const KEYS: SchemaStep = {
  name: 'project keys',
  ddl: [
    // A project's keys: its current one and the old ones, which stay aliases. A key belongs to one project for good.
    `CREATE TABLE project_keys (
      key        TEXT    PRIMARY KEY COLLATE NOCASE,
      project_id TEXT    NOT NULL,
      current    INTEGER NOT NULL CHECK (current IN (0, 1)),
      since      TEXT    NOT NULL
    ) STRICT, WITHOUT ROWID`,
    'CREATE UNIQUE INDEX project_keys_current ON project_keys (project_id) WHERE current = 1',
    // Each project's next card number: past its highest (an existing card keeps its number, HI-1061).
    'CREATE TABLE project_counters (project_id TEXT PRIMARY KEY, next INTEGER NOT NULL) STRICT, WITHOUT ROWID',
    // The card's number in its project: AM-12 is (AM's project, 12). Null until the keys step gives it one.
    'ALTER TABLE cards ADD COLUMN project_number INTEGER',
    'CREATE UNIQUE INDEX cards_project_number ON cards (project_id, project_number) WHERE project_number IS NOT NULL',
    // The keys a card had in another project (moved since): (that project, its number there) → the card. Old `#N`
    // need no row: the global number stays the card's `number`, and an old key of a renamed project resolves through
    // project_keys.
    `CREATE TABLE card_aliases (
      project_id TEXT    NOT NULL,
      number     INTEGER NOT NULL,
      card       INTEGER NOT NULL REFERENCES cards (number) ON DELETE CASCADE,
      PRIMARY KEY (project_id, number)
    ) STRICT, WITHOUT ROWID`,
    'CREATE INDEX card_aliases_card ON card_aliases (card)'
  ]
}

/**
 * #1266 (P4): an action's delivery is recorded by the delivery itself, its row in `deliveries` with the action's id
 * (unique), so the transitional `card_actions.delivered` (#1215) goes. A notice, which makes no delivery, is claimed
 * instead: marked done before it runs (actionWorker.ts).
 */
export const ACTIONS_DELIVERED_STEP: SchemaStep = {
  name: 'actions delivered by deliveries',
  ddl: ['DROP INDEX card_actions_delivered', 'ALTER TABLE card_actions DROP COLUMN delivered']
}

/** The 1.0 group's steps (P3's, then P4's), in the order they are registered. */
export const V1_0_STEPS: SchemaStep[] = [CARDS_STEP, SESSIONS_DELIVERIES, LANES_WATCHES_METRICS, FACTS_STEP, KEYS, ACTIONS_DELIVERED_STEP]

/** A module's query against the 1.0 tables, the index it must use, and sample arguments for EXPLAIN. */
export interface SchemaQuery {
  sql: string
  args: (string | number)[]
  /** The index the plan must use (`PRIMARY KEY`, `INTEGER PRIMARY KEY`, or an index's name), or the ones it may choose between. */
  index: string | string[]
}

/** The modules' real queries (named by module and use). */
export const QUERIES: Record<string, SchemaQuery> = {
  // boardStore.ts: cards and their children.
  'board.card': { sql: 'SELECT * FROM cards WHERE number = ?', args: [1], index: 'INTEGER PRIMARY KEY' },
  'board.live': { sql: 'SELECT number FROM cards WHERE archived = ? ORDER BY number', args: [0], index: ['cards_place', 'cards_archived_project'] },
  'board.byAgent': { sql: 'SELECT number FROM cards WHERE agent IN (SELECT value FROM json_each(?))', args: ['["a1"]'], index: 'cards_agent' },
  'board.byReviewer': { sql: 'SELECT number FROM cards WHERE review_agent IN (SELECT value FROM json_each(?))', args: ['["a1"]'], index: 'cards_reviewer' },
  'board.byProject': { sql: 'SELECT number FROM cards WHERE project_id = ? AND archived = 0', args: ['p1'], index: 'cards_project' },
  'board.column': { sql: 'SELECT number FROM cards WHERE archived = 0 AND col = ? ORDER BY ord', args: ['todo'], index: 'cards_place' },
  'board.archivedCounts': { sql: 'SELECT project, count(*) FROM cards WHERE archived = 1 GROUP BY project', args: [], index: 'cards_archived_project' },
  'board.updatedSince': { sql: 'SELECT number FROM cards WHERE updated_at > ?', args: ['2026-10-01'], index: 'cards_updated' },
  'board.byLabel': { sql: 'SELECT card FROM card_labels WHERE label = ?', args: ['1.0.0'], index: 'card_labels_label' },
  'board.labels': { sql: 'SELECT label FROM card_labels WHERE card = ? ORDER BY ord', args: [1], index: 'PRIMARY KEY' },
  'board.referrers': { sql: 'SELECT card FROM card_links WHERE target = ?', args: [1], index: 'card_links_target' },
  'board.links': { sql: 'SELECT kind, target FROM card_links WHERE card = ? ORDER BY kind, ord', args: [1], index: 'PRIMARY KEY' },
  'board.comments': { sql: 'SELECT * FROM card_comments WHERE card = ? ORDER BY ord', args: [1], index: 'PRIMARY KEY' },
  'board.history': { sql: 'SELECT * FROM card_history WHERE card = ? ORDER BY ord', args: [1], index: 'PRIMARY KEY' },
  'board.historySince': { sql: 'SELECT card, what FROM card_history WHERE at > ?', args: ['2026-10-01'], index: 'card_history_at' },
  'board.decisions': { sql: 'SELECT * FROM card_decisions WHERE card = ? ORDER BY ord', args: [1], index: 'PRIMARY KEY' },
  'board.holds': { sql: 'SELECT * FROM card_holds WHERE card = ? ORDER BY ord', args: [1], index: 'PRIMARY KEY' },
  'board.context': { sql: 'SELECT ref FROM card_context WHERE card = ? ORDER BY ord', args: [1], index: 'PRIMARY KEY' },
  // sessionStore.ts: a host's sessions, one by id, an agent's, a card's.
  'sessions.host': { sql: 'SELECT * FROM sessions WHERE host = ? ORDER BY ord', args: ['p1'], index: 'PRIMARY KEY' },
  'sessions.byId': { sql: 'SELECT * FROM sessions WHERE host = ? AND id = ?', args: ['p1', 's1'], index: 'PRIMARY KEY' },
  'sessions.byAgent': { sql: 'SELECT id FROM sessions WHERE host = ? AND agent_id = ? ORDER BY last_active_at DESC', args: ['p1', 'a1'], index: 'sessions_agent' },
  'sessions.byCard': { sql: 'SELECT host, session FROM session_cards WHERE card = ?', args: [1], index: 'session_cards_card' },
  'sessions.deletedUsage': { sql: 'SELECT * FROM sessions_deleted_usage WHERE host = ? AND id = ?', args: ['p1', 's1'], index: 'PRIMARY KEY' },
  // deliveries.ts: an agent's inbox, a state's, a source's, a card round's, the 7-day expiry, an action's wake.
  'deliveries.byAgent': { sql: 'SELECT * FROM deliveries WHERE host = ? AND agent_id = ? ORDER BY seq', args: ['p1', 'a1'], index: 'deliveries_agent' },
  'deliveries.byState': { sql: 'SELECT id FROM deliveries WHERE host = ? AND state = ?', args: ['p1', 'offered'], index: 'deliveries_state' },
  'deliveries.bySource': { sql: 'SELECT id FROM deliveries WHERE host = ? AND source = ? AND ref = ?', args: ['p1', 'watch', 'w1'], index: 'deliveries_source' },
  'deliveries.byCard': { sql: 'SELECT id FROM deliveries WHERE card = ? AND round = ?', args: [1, 1], index: 'deliveries_card' },
  'deliveries.overdueReceived': { sql: 'SELECT host, id FROM deliveries WHERE received < ? AND received IS NOT NULL AND acked IS NULL', args: ['2026-10-13'], index: 'deliveries_received' },
  'deliveries.endedOf': { sql: 'SELECT id FROM deliveries WHERE host = ? AND agent_id = ? AND ended IS NOT NULL ORDER BY ended DESC', args: ['p1', 'a1'], index: 'deliveries_ended' },
  'deliveries.byAction': { sql: 'SELECT id FROM deliveries WHERE action = ?', args: [1], index: 'deliveries_action' },
  // lanes.ts: a builder's running lane, a reviewer's, the ended ones to prune, a card's lanes.
  'lanes.ofBuilder': { sql: "SELECT id FROM lanes WHERE project_id = ? AND builder_id = ? AND state = 'active'", args: ['p1', 'a1'], index: 'lanes_builder' },
  'lanes.ofReviewer': { sql: "SELECT id FROM lanes WHERE project_id = ? AND reviewer_id = ? AND state = 'active'", args: ['p1', 'a1'], index: 'lanes_reviewer' },
  'lanes.ended': { sql: "SELECT id FROM lanes WHERE state = 'ended' AND ended_at < ?", args: ['2026-10-19'], index: 'lanes_state' },
  'lanes.ofCard': { sql: 'SELECT lane FROM lane_cards WHERE card = ?', args: [1], index: 'lane_cards_card' },
  'lanes.cards': { sql: 'SELECT card FROM lane_cards WHERE lane = ? ORDER BY ord', args: ['l1'], index: 'PRIMARY KEY' },
  // watches.ts: an agent's watch, the watches on a card, the ones past their limit, the one a delivery fired.
  'watches.ofAgent': { sql: 'SELECT * FROM watches WHERE project_path = ? AND agent_id = ?', args: ['D:\\ws\\p', 'a1'], index: 'watches_agent' },
  'watches.onCard': { sql: 'SELECT watch FROM watch_cards WHERE card = ?', args: [1], index: 'watch_cards_card' },
  'watches.due': { sql: 'SELECT id FROM watches WHERE fired IS NULL AND limit_at <= ?', args: ['2026-10-20'], index: 'watches_limit' },
  'watches.byDelivery': { sql: 'SELECT id FROM watches WHERE fired_delivery = ?', args: ['m1'], index: 'watches_delivery' },
  // metrics.ts: buckets in a range (roll, eviction), a bucket's series.
  'metrics.range': { sql: 'SELECT span, start FROM metrics_buckets WHERE start < ?', args: [0], index: 'metrics_buckets_start' },
  'metrics.series': { sql: 'SELECT part, family, key, data FROM metrics_series WHERE span = ? AND start = ?', args: ['hour', 0], index: 'PRIMARY KEY' },
  // factStore.ts: a card's facts, an observed fact's dedupe, a kind across cards (the queue), pending actions.
  'facts.ofCard': { sql: 'SELECT * FROM card_facts WHERE card = ? ORDER BY seq', args: [1], index: 'sqlite_autoindex_card_facts_1' },
  'facts.nextSeq': { sql: 'SELECT max(seq) FROM card_facts WHERE card = ?', args: [1], index: 'sqlite_autoindex_card_facts_1' },
  'facts.dedupe': { sql: 'SELECT 1 FROM card_facts WHERE card = ? AND kind = ? AND dedupe = ?', args: [1, 'HeadMoved', 'prev:1'], index: 'card_facts_dedupe' },
  'facts.ofKind': { sql: 'SELECT card, seq FROM card_facts WHERE kind = ? ORDER BY rowid', args: ['IntegrationRequested'], index: 'card_facts_kind' },
  // cardWork.ts: the live cards' facts for the board's badges (#1223), an archived card's never read.
  'facts.live': { sql: 'SELECT f.* FROM cards c JOIN card_facts f ON f.card = c.number WHERE c.archived = 0 ORDER BY f.card, f.seq', args: [], index: 'sqlite_autoindex_card_facts_1' },
  'actions.pending': { sql: "SELECT * FROM card_actions WHERE state = 'pending' ORDER BY id", args: [], index: 'card_actions_pending' },
  'actions.ofCard': { sql: 'SELECT * FROM card_actions WHERE card = ?', args: [1], index: 'card_actions_card' },
  'rulesets.byId': { sql: 'SELECT data FROM rulesets WHERE id = ?', args: ['r1'], index: 'PRIMARY KEY' },
  'folderCommits.of': { sql: 'SELECT sha, card, how FROM folder_commits WHERE folder = ? ORDER BY id', args: ['D:\\ws\\p'], index: 'folder_commits_seen' },
  'paths.ofCard': { sql: 'SELECT path FROM card_paths WHERE card = ? AND kind = ? ORDER BY ord', args: [1, 'declared'], index: 'PRIMARY KEY' },
  'paths.cardsOf': { sql: 'SELECT card FROM card_paths WHERE path = ?', args: ['src/a.txt'], index: 'card_paths_path' },
  'workflowLanes.of': { sql: 'SELECT * FROM workflow_lanes WHERE project = ? AND id = ?', args: ['p', 'L'], index: 'PRIMARY KEY' },
  'workflowLanes.cards': { sql: 'SELECT list, card FROM workflow_lane_cards WHERE project = ? AND lane = ? ORDER BY list, ord', args: ['p', 'L'], index: 'PRIMARY KEY' },
  'queuePauses.of': { sql: 'SELECT reason, card FROM workflow_queue_pauses WHERE project = ? AND target = ?', args: ['p', 'main'], index: 'PRIMARY KEY' },
  // cardRefs.ts: a key to its card (current key, an old key of the project, a moved card's alias), a project's key.
  'keys.resolve': { sql: 'SELECT c.number FROM project_keys k JOIN cards c ON c.project_id = k.project_id AND c.project_number = ? WHERE k.key = ?', args: [12, 'am'], index: 'cards_project_number' },
  'keys.alias': { sql: 'SELECT a.card FROM project_keys k JOIN card_aliases a ON a.project_id = k.project_id AND a.number = ? WHERE k.key = ?', args: [12, 'am'], index: 'PRIMARY KEY' },
  'keys.current': { sql: 'SELECT key FROM project_keys WHERE project_id = ? AND current = 1', args: ['p1'], index: 'project_keys_current' },
  'keys.counter': { sql: 'SELECT next FROM project_counters WHERE project_id = ?', args: ['p1'], index: 'PRIMARY KEY' },
  'keys.aliasesOf': { sql: 'SELECT project_id, number FROM card_aliases WHERE card = ?', args: [1], index: 'card_aliases_card' }
}
