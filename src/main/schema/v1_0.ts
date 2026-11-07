/**
 * combwork.db's 1.0 schema (#1208, SPEC §16.12, §16.4, §16.17; #1025, #704, #1119): every table P3's migration makes, grouped
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
 * build has no column for in `extra` (a JSON object), so an older version saving a newer one's row loses nothing.
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
    // Entries: typed columns, and `raw` (the entry's exact JSON) for one not of Combwork's form (cardRows.ts).
    `CREATE TABLE card_comments (
      card      INTEGER NOT NULL REFERENCES cards (number) ON DELETE CASCADE,
      ord       INTEGER NOT NULL,
      at        TEXT,
      by        TEXT,
      text      TEXT,
      app_text  TEXT,
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
    // A lane's cards in order (Combwork owns the list, SPEC §16.11.1), and the snapshot an ended lane keeps (`frozen`).
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

/** The fact log, durable actions and rulesets (SPEC §16.4), from the P2 spike's factStore.ts, in combwork.db. */
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
    // runtime's lane whose ruleset the card uses and `lane_reviewer` its reviewer to wake (§16.11.1), until #1291's step
    // reads them from lanes.ts's tables and drops them; `paths_declared` whether None's declared paths were ever set (an empty list is a declaration).
    "ALTER TABLE cards ADD COLUMN kind TEXT NOT NULL DEFAULT 'code' CHECK (kind IN ('code', 'no-code'))",
    'ALTER TABLE cards ADD COLUMN target TEXT',
    'ALTER TABLE cards ADD COLUMN lane TEXT',
    'ALTER TABLE cards ADD COLUMN lane_reviewer TEXT',
    'ALTER TABLE cards ADD COLUMN paths_declared INTEGER NOT NULL DEFAULT 0 CHECK (paths_declared IN (0, 1))',
    // None's paths of a card (§16.3.3): those it declared, and the pre-fill Combwork saw it edit; the watcher and None's
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
    // change queued for the next boundary), per project, until #1291's step moves them into lanes.ts's tables.
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
 * One lane record (#1291): what the runtime keeps of a lane, beside lanes.ts's `lanes` and `lane_cards` (the lane, its
 * agents, state and cards), keyed by the lane's id. Made before laneRecordStep.ts moves the runtime's tables in.
 */
export const LANE_RECORD_ADD = [
  // The ruleset in force when the runtime started the lane (§16.6.5; null: one it didn't start, whose cards use the
  // current options), the card in flight, and whether a list change is queued for the next card boundary (its cards in
  // lane_pending; a queued empty list is still a change). A row only for a lane the runtime has read on. No foreign key: lanes.ts saves a changed lane again whole (its row deleted and inserted,
  // storeTables.ts), and this must outlive that; a lane removed from the table takes it (storeCodec.ts `onRemove`).
  `CREATE TABLE lane_runs (
    lane         TEXT    PRIMARY KEY,
    ruleset      TEXT,
    current_card INTEGER,
    has_pending  INTEGER NOT NULL DEFAULT 0 CHECK (has_pending IN (0, 1))
  ) STRICT, WITHOUT ROWID`,
  `CREATE TABLE lane_pending (
    lane TEXT    NOT NULL,
    ord  INTEGER NOT NULL,
    card INTEGER NOT NULL,
    PRIMARY KEY (lane, ord)
  ) STRICT, WITHOUT ROWID`,
  // A card's lane is read from its lists: a card queued for a lane uses its ruleset already.
  'CREATE INDEX lane_pending_card ON lane_pending (card)'
]

/** The runtime's own lane tables and a card's lane columns, dropped once laneRecordStep.ts moved what they held. */
export const LANE_RECORD_DROP = ['DROP TABLE workflow_lane_cards', 'DROP TABLE workflow_lanes', 'ALTER TABLE cards DROP COLUMN lane', 'ALTER TABLE cards DROP COLUMN lane_reviewer']

const LANE_RECORD: SchemaStep = {
  name: 'one lane record',
  ddl: [...LANE_RECORD_ADD, ...LANE_RECORD_DROP]
}

/**
 * #1266 (P4): an action's delivery is recorded by the delivery itself, its row in `deliveries` with the action's id
 * (unique), so the transitional `card_actions.delivered` (#1215) goes; a notice, which makes no delivery, is leased by
 * one Combwork and counts its uncertain dispatches instead (`lease_owner`, `lease_until`, `attempts`: actionWorker.ts).
 * And what Combwork has told the user of each running lane (its lane notices, workflowNotices.ts, §16.11.4): each lane as
 * last told and its cards, so a restart tells what it hadn't yet, and two Combworks on one workspace tell each event once.
 */
export const ACTIONS_DELIVERED_STEP: SchemaStep = {
  name: 'actions delivered by deliveries, lane notices',
  ddl: [
    'DROP INDEX card_actions_delivered',
    'ALTER TABLE card_actions DROP COLUMN delivered',
    // A repeatable action's lease (actionWorker.ts): the process running it (its id, per Combwork) and until when; one
    // writer at a time takes it by a conditional update, and one whose Combwork ended runs again once it has passed.
    'ALTER TABLE card_actions ADD COLUMN lease_owner TEXT',
    'ALTER TABLE card_actions ADD COLUMN lease_until TEXT',
    // A lane as its notices last told it (laneWatch.ts' LaneMark): its state, whether its merge was due, and stalled.
    `CREATE TABLE lane_notice_lanes (
      lane          TEXT    PRIMARY KEY,
      state         TEXT    NOT NULL,
      merge_due     INTEGER NOT NULL CHECK (merge_due IN (0, 1)),
      merge_stalled INTEGER NOT NULL CHECK (merge_stalled IN (0, 1))
    ) STRICT, WITHOUT ROWID`,
    // Its cards as last told (LaneCardMark): the column, blocked and stalled, its latest failed and passed verdicts' times.
    `CREATE TABLE lane_notice_cards (
      lane    TEXT    NOT NULL REFERENCES lane_notice_lanes (lane) ON DELETE CASCADE,
      card    INTEGER NOT NULL,
      col     TEXT    NOT NULL,
      blocked INTEGER NOT NULL CHECK (blocked IN (0, 1)),
      stalled INTEGER NOT NULL CHECK (stalled IN (0, 1)),
      failed  TEXT    NOT NULL,
      passed  TEXT    NOT NULL,
      PRIMARY KEY (lane, card)
    ) STRICT, WITHOUT ROWID`
  ]
}

/**
 * A card's text as the search reads it (#1237): its row in `card_search`, from its title, description, project, agent's
 * name and labels. `x` is the card's number (an expression).
 */
const searchRow = (x: string): string => `INSERT INTO card_search (rowid, title, description, project, agent, labels)
      SELECT number, title, description, project, coalesce(agent_name, ''),
        coalesce((SELECT group_concat(label, char(10)) FROM card_labels WHERE card = number), '')
      FROM cards WHERE number = ${x}`
/** A trigger's body that writes card `x`'s search row again (or only removes it, for a card gone). */
const reindex = (x: string): string => `DELETE FROM card_search WHERE rowid = ${x}; ${searchRow(x)};`

/**
 * Full-text search over cards (#1237): `card_search`, an FTS5 index of each card's text, kept in step with the card tables
 * by triggers, so every write path (a card saved, a project renamed, a card deleted with its rows) keeps it. Contentless
 * (the text is only in the card tables; rowid is the card's number), and by the trigram tokenizer: the board's search
 * finds what a card's text *contains*, any three characters or more, case-insensitively, as the in-memory search does
 * (shorter queries are too short for it and are matched in memory). Comments aren't in it, as the board's search doesn't
 * read them: on a live board (1,284 cards) they would make it 38 MB rather than 8, and each comment would write its
 * card's row again. Searching comments, if wanted, is a later step (perhaps a word index, which is far smaller).
 */
export const CARD_SEARCH_STEP: SchemaStep = {
  name: 'card search',
  ddl: [
    `CREATE VIRTUAL TABLE card_search USING fts5(title, description, project, agent, labels, tokenize = 'trigram', content = '', contentless_delete = 1)`,
    // The cards there already (the upgrade's), before the triggers keep it.
    searchRow('number').replace(' WHERE number = number', ''),
    `CREATE TRIGGER card_search_ai AFTER INSERT ON cards BEGIN ${reindex('NEW.number')} END`,
    // Only when the searched text changed: a card's save writes its whole row (#1210), whatever changed.
    `CREATE TRIGGER card_search_au AFTER UPDATE OF title, description, project, agent_name ON cards
      WHEN OLD.title IS NOT NEW.title OR OLD.description IS NOT NEW.description OR OLD.project IS NOT NEW.project OR OLD.agent_name IS NOT NEW.agent_name
      BEGIN ${reindex('NEW.number')} END`,
    'CREATE TRIGGER card_search_ad AFTER DELETE ON cards BEGIN DELETE FROM card_search WHERE rowid = OLD.number; END',
    `CREATE TRIGGER card_search_lai AFTER INSERT ON card_labels BEGIN ${reindex('NEW.card')} END`,
    `CREATE TRIGGER card_search_lau AFTER UPDATE ON card_labels BEGIN ${reindex('OLD.card')} ${reindex('NEW.card')} END`,
    `CREATE TRIGGER card_search_lad AFTER DELETE ON card_labels BEGIN ${reindex('OLD.card')} END`,
  ]
}

/**
 * Undo for the Assistant's changes (#1282, SPEC §16.14): each change it made (a card's, a lane's, an agent's settings, a
 * Combwork setting, an agent it started), grouped by the user's message it came from, with what it replaced and what it
 * wrote, field by field, kept 7 days (assistantUndo.ts). `kind` says how it is undone; `final` ones can't be (a message, a
 * prompt) and say why; `act` is the Assistant's action it came from (assistantActivity.ts' kinds), for the window's words. A value is rows, not JSON: a scalar one row at path '' (`type` null, bool, num or text), a list or
 * object a row of its own (`arr`, `obj`) and one per member, its path the member's keys joined by U+001F.
 */
export const ASSISTANT_CHANGES_STEP: SchemaStep = {
  name: 'assistant changes',
  ddl: [
    `CREATE TABLE assistant_changes (
      id       TEXT    PRIMARY KEY,
      grp      TEXT    NOT NULL,
      grp_at   TEXT    NOT NULL,
      at       TEXT    NOT NULL,
      kind     TEXT    NOT NULL CHECK (kind IN ('card', 'lane', 'agent', 'setting', 'started', 'final')),
      act      TEXT    NOT NULL,
      what     TEXT    NOT NULL,
      card     INTEGER,
      project  TEXT,
      target   TEXT,
      final    TEXT,
      undone_at TEXT
    ) STRICT`,
    'CREATE INDEX assistant_changes_grp ON assistant_changes (grp, at)',
    'CREATE INDEX assistant_changes_grp_at ON assistant_changes (grp_at)',
    `CREATE TABLE assistant_change_values (
      change TEXT    NOT NULL REFERENCES assistant_changes (id) ON DELETE CASCADE,
      field  TEXT    NOT NULL,
      side   TEXT    NOT NULL CHECK (side IN ('old', 'new')),
      ord    INTEGER NOT NULL,
      path   TEXT    NOT NULL,
      type   TEXT    NOT NULL CHECK (type IN ('null', 'bool', 'num', 'text', 'arr', 'obj')),
      text   TEXT,
      num    REAL,
      PRIMARY KEY (change, field, side, ord)
    ) STRICT, WITHOUT ROWID`
  ]
}

/**
 * What undo did with each field of a change it processed (#1283, SPEC §16.14): put back (`undone`), or left as it was
 * because someone changed it since, it is gone or its lane ended. Written when the change is marked undone, so the panel
 * says Undone, Partly undone or Kept, with why, whoever undid it and after a restart. A failure isn't one: the change
 * stays to be tried again.
 */
export const UNDO_OUTCOMES_STEP: SchemaStep = {
  name: 'undo outcomes',
  ddl: [
    `CREATE TABLE assistant_change_outcomes (
      change  TEXT NOT NULL REFERENCES assistant_changes (id) ON DELETE CASCADE,
      field   TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('undone', 'changed', 'gone', 'ended')),
      PRIMARY KEY (change, field)
    ) STRICT, WITHOUT ROWID`
  ]
}

/**
 * The merge queue's runner (#1360, SPEC §16.9.3): one per project and target across every Combwork on the workspace, its
 * processes and its own worktree (workflow/queueRunner.ts).
 */
export const QUEUE_RUNNERS_STEP: SchemaStep = {
  name: 'queue runners',
  ddl: [
    // A target's lease: who runs its queue now. `lease` names it (and its folder), `token` is the holder's secret that
    // every fenced write and the release name; `pid` and `started` (Unix ms) are the holder process, taken over only once
    // that process is gone. `renewed_at` is for display ("last seen"), never for a takeover.
    `CREATE TABLE queue_runners (
      project    TEXT    NOT NULL COLLATE NOCASE,
      target     TEXT    NOT NULL,
      lease      TEXT    NOT NULL UNIQUE,
      token      TEXT    NOT NULL,
      profile    TEXT    NOT NULL,
      pid        INTEGER NOT NULL,
      started    INTEGER NOT NULL,
      taken_at   TEXT    NOT NULL,
      renewed_at TEXT    NOT NULL,
      PRIMARY KEY (project, target)
    ) STRICT, WITHOUT ROWID`,
    // What a runner owns: its lease's job (`what = 'job'`, pid 0: settled by the job's name, never by the supervisor
    // holding it, which may serve a living Combwork's other targets and agents) and each command's launcher (git in its
    // folder, an install, a check), recorded before the command exists. What the job follows outside it is in the
    // lease's journal (a file the supervisor writes, queueJobs.ts). A row is a duty, kept until its process and its
    // lease's job are seen gone: by its runner's release, or by whichever runner of the target next takes the lease (a
    // takeover), however many runners crash before that. A launcher's start is known only between two clock readings
    // around it (`start_after`, `start_before`, Unix ms): a process with its pid that started outside them is another's.
    // No foreign key: the duty outlives its lease row.
    `CREATE TABLE queue_runner_procs (
      lease        TEXT    NOT NULL,
      project      TEXT    NOT NULL COLLATE NOCASE,
      target       TEXT    NOT NULL,
      pid          INTEGER NOT NULL,
      start_after  INTEGER NOT NULL,
      start_before INTEGER NOT NULL,
      what         TEXT    NOT NULL CHECK (what IN ('job', 'testMerge', 'install', 'check')),
      PRIMARY KEY (lease, pid)
    ) STRICT, WITHOUT ROWID`,
    'CREATE INDEX queue_runner_procs_target ON queue_runner_procs (project, target)',
    // A queue's worktree: its target and the lease it was made for (null: kept by a runner that released it cleanly, for
    // the next one to use), for clean-up, Unused Worktrees and Repair.
    `CREATE TABLE queue_worktrees (
      folder  TEXT PRIMARY KEY COLLATE NOCASE,
      project TEXT NOT NULL COLLATE NOCASE,
      target  TEXT NOT NULL,
      lease   TEXT
    ) STRICT, WITHOUT ROWID`,
    'CREATE INDEX queue_worktrees_target ON queue_worktrees (project, target)',
    // A pause naming a process Combwork couldn't end (a dead runner's, at a takeover).
    'ALTER TABLE workflow_queue_pauses ADD COLUMN pid INTEGER'
  ]
}

/** What git (or a signer) said for a queue pause it caused (#1350: an index lock, a signing error), in its own words. */
export const QUEUE_PAUSE_MESSAGE_STEP: SchemaStep = {
  name: 'queue pause messages',
  ddl: ['ALTER TABLE workflow_queue_pauses ADD COLUMN message TEXT']
}

/**
 * Who paused a merge queue, and when (#1353, SPEC §16.9.3 User controls): `paused_by` the user or the Assistant (null:
 * Combwork's own pause, with its reason), `paused_at` an ISO time (null: a pause from before this step).
 */
export const QUEUE_PAUSE_BY_STEP: SchemaStep = {
  name: 'queue pause by',
  ddl: ["ALTER TABLE workflow_queue_pauses ADD COLUMN paused_by TEXT CHECK (paused_by IN ('user', 'assistant'))", 'ALTER TABLE workflow_queue_pauses ADD COLUMN paused_at TEXT']
}

/**
 * The state an advance into a checked-out target was left in, for its terminal "needs you" pause (#1351, SPEC §16.9.2):
 * the folder, the branch its HEAD named and where the target's ref was when Combwork looked, the advance's expected revision
 * and result, the journal's last phase (`done`: the ref moved, but the folder was on another branch by then), the side
 * each listed file is at (its index and working copy at the expected revision, at the result, or neither), and the
 * commands that finish or undo it, generated from the journal, each run in the project folder or the checked-out one.
 */
export const QUEUE_PAUSE_STATE_STEP: SchemaStep = {
  name: 'queue pause state',
  ddl: [
    'ALTER TABLE workflow_queue_pauses ADD COLUMN folder TEXT',
    'ALTER TABLE workflow_queue_pauses ADD COLUMN branch TEXT',
    'ALTER TABLE workflow_queue_pauses ADD COLUMN ref TEXT',
    'ALTER TABLE workflow_queue_pauses ADD COLUMN expected TEXT',
    'ALTER TABLE workflow_queue_pauses ADD COLUMN result TEXT',
    "ALTER TABLE workflow_queue_pauses ADD COLUMN phase TEXT CHECK (phase IN ('started', 'files', 'ref', 'rollback', 'done'))",
    "ALTER TABLE workflow_queue_pause_files ADD COLUMN side TEXT CHECK (side IN ('expected', 'result', 'other'))",
    `CREATE TABLE workflow_queue_pause_commands (
      project TEXT    NOT NULL COLLATE NOCASE,
      target  TEXT    NOT NULL,
      ord     INTEGER NOT NULL,
      purpose TEXT    NOT NULL CHECK (purpose IN ('finish', 'undo')),
      place   TEXT    NOT NULL CHECK (place IN ('project', 'folder')),
      PRIMARY KEY (project, target, ord),
      FOREIGN KEY (project, target) REFERENCES workflow_queue_pauses (project, target) ON DELETE CASCADE
    ) STRICT, WITHOUT ROWID`,
    // A command's arguments, each as it is (never a shell string: HR4's #1351 round 1, a ref's `$` expanded by a shell).
    `CREATE TABLE workflow_queue_pause_command_args (
      project TEXT    NOT NULL COLLATE NOCASE,
      target  TEXT    NOT NULL,
      command INTEGER NOT NULL,
      ord     INTEGER NOT NULL,
      arg     TEXT    NOT NULL,
      PRIMARY KEY (project, target, command, ord),
      FOREIGN KEY (project, target, command) REFERENCES workflow_queue_pause_commands (project, target, ord) ON DELETE CASCADE
    ) STRICT, WITHOUT ROWID`
  ]
}

/**
 * When the user saw a merge queue's returned card (#1356, the Progress panel's Merges tab): a return shows on its queue's
 * card until seen, like a failed run, and keeps the queue's card shown (an old ruleset's queue included) until then. One
 * row per returned entry (its id, `<key>/e<n>`, unique in its project), shared by every window and Combwork on the workspace.
 */
export const QUEUE_SEEN_STEP: SchemaStep = {
  name: 'queue seen',
  ddl: [
    `CREATE TABLE workflow_queue_seen (
      project TEXT NOT NULL COLLATE NOCASE,
      entry   TEXT NOT NULL,
      seen_at TEXT NOT NULL,
      PRIMARY KEY (project, entry)
    ) STRICT, WITHOUT ROWID`
  ]
}

/**
 * A project's slots and their leases (#1429, SPEC §16.10.1–16.10.2; slots.ts): the worktrees Combwork lends to a card or a
 * lane, and each loan of one. At most one open lease per slot, one open dispatch lease (`card`, `lane`: where the agent
 * builds now) and one open carried lease (#1441's migrated worktree) per agent: partial unique indexes, so a second one
 * fails in SQLite whichever Combwork or process writes it, not only in code.
 */
export const SLOTS_STEP: SchemaStep = {
  name: 'slots',
  ddl: [
    // A slot: its generic name (`slot-a`…, or a migrated worktree's own), folder, state, its port block (CW_SLOT_PORT_BASE,
    // unique in the project), the branch it was made from, and its last install's revision and lock files' hash. A setup
    // or install that failed leaves `warm_error` (its exit, in English) and `warm_log` (the run's log): lending skips it.
    `CREATE TABLE slots (
      project    TEXT    NOT NULL COLLATE NOCASE,
      name       TEXT    NOT NULL COLLATE NOCASE,
      folder     TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      state      TEXT    NOT NULL CHECK (state IN ('creating', 'ready', 'lent', 'dirty', 'gone', 'removing')),
      port_base  INTEGER NOT NULL,
      target     TEXT,
      install_rev  TEXT,
      install_hash TEXT,
      warm_error TEXT,
      warm_log   TEXT,
      created_at TEXT    NOT NULL,
      used_at    TEXT    NOT NULL,
      -- The operation that owns the slot while it changes outside one write (warming for a lease, removal): its token,
      -- which every write it makes checks, and its holder process (pid and start, Unix ms), taken over only once that
      -- process is gone. 'job' is a command's job on the process supervisor, recorded before it starts and cleared only
      -- once its processes are seen ended: while it is set (an operation's or one left by a crash) the slot isn't lent.
      op         TEXT,
      op_kind    TEXT    CHECK (op_kind IN ('warm', 'remove')),
      op_lease   TEXT,
      op_pid     INTEGER,
      op_started INTEGER,
      job        TEXT,
      PRIMARY KEY (project, name),
      UNIQUE (project, port_base),
      CHECK ((op IS NULL) = (op_kind IS NULL))
    ) STRICT, WITHOUT ROWID`,
    // A lease: one loan of a slot to a card or a lane (a dispatch lease) or an agent's migrated worktree (`carried`), from
    // `from_at` until `ended_at`, and why it ended. `agent` is the builder's id.
    `CREATE TABLE slot_leases (
      id       TEXT    PRIMARY KEY,
      project  TEXT    NOT NULL COLLATE NOCASE,
      slot     TEXT    NOT NULL COLLATE NOCASE,
      kind     TEXT    NOT NULL CHECK (kind IN ('card', 'lane', 'carried')),
      card     INTEGER,
      lane     TEXT,
      agent    TEXT    NOT NULL,
      from_at  TEXT    NOT NULL,
      ended_at TEXT,
      why      TEXT,
      CHECK ((kind = 'card') = (card IS NOT NULL) AND (kind = 'lane') = (lane IS NOT NULL)),
      FOREIGN KEY (project, slot) REFERENCES slots (project, name) ON DELETE CASCADE
    ) STRICT, WITHOUT ROWID`,
    'CREATE UNIQUE INDEX slot_leases_open ON slot_leases (project, slot) WHERE ended_at IS NULL',
    "CREATE UNIQUE INDEX slot_leases_dispatch ON slot_leases (project, agent) WHERE ended_at IS NULL AND kind <> 'carried'",
    "CREATE UNIQUE INDEX slot_leases_carried ON slot_leases (project, agent) WHERE ended_at IS NULL AND kind = 'carried'",
    'CREATE INDEX slot_leases_agent ON slot_leases (project, agent) WHERE ended_at IS NULL',
    'CREATE INDEX slot_leases_card ON slot_leases (card) WHERE card IS NOT NULL',
    'CREATE INDEX slot_leases_lane ON slot_leases (lane) WHERE lane IS NOT NULL',
    'CREATE INDEX slot_leases_slot ON slot_leases (project, slot, from_at)'
  ]
}

/**
 * A project's review and check copies (#1435, SPEC §16.10.5, §16.13; copies.ts): detached worktrees in one fixed folder
 * per project (`<Workspace>.worktrees/<Project>/copies/copy-N`), each leased to one reviewer for one submission or to one
 * isolated check run, at the exact revision. A lease is open until it is freed: returned (its review or run over) it
 * stays `returning` until nothing is left in the copy (the quiescence barrier), so at most one lease per copy that isn't
 * freed, by a partial unique index. Operations own a copy while it changes, as slots' do (#1429).
 */
export const COPIES_STEP: SchemaStep = {
  name: 'copies',
  ddl: [
    // A copy: its name and folder, state, the revision it was last reset to, its last install's lock files' hash, a
    // failed warming's error and log, when it was last used, and the operation that owns it while it changes (its
    // token, kind, holder pid and start) with a command's job, as slots have them.
    `CREATE TABLE copies (
      project    TEXT    NOT NULL COLLATE NOCASE,
      name       TEXT    NOT NULL COLLATE NOCASE,
      folder     TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      state      TEXT    NOT NULL CHECK (state IN ('creating', 'free', 'leased', 'returning', 'dirty', 'gone')),
      revision   TEXT,
      install_hash TEXT,
      warm_error TEXT,
      warm_log   TEXT,
      created_at TEXT    NOT NULL,
      used_at    TEXT    NOT NULL,
      op         TEXT,
      op_kind    TEXT    CHECK (op_kind IN ('lease', 'remove', 'recover')),
      op_pid     INTEGER,
      op_started INTEGER,
      job        TEXT,
      PRIMARY KEY (project, name),
      CHECK ((op IS NULL) = (op_kind IS NULL))
    ) STRICT, WITHOUT ROWID`,
    // A lease: one review (its card and submission) or one isolated run (its card and run, or the link that will start
    // it) by a holder agent, through a Combwork (its profile, pid and start: a lease whose Combwork is gone is returned), from
    // `from_at`; `returned_at` once its review or run is over (why), `freed_at` once the copy was quiet. `job` is the
    // supervisor job its run's processes are put in (an isolated check), settled before the copy is freed.
    `CREATE TABLE copy_leases (
      id          TEXT    PRIMARY KEY,
      project     TEXT    NOT NULL COLLATE NOCASE,
      copy        TEXT    NOT NULL COLLATE NOCASE,
      kind        TEXT    NOT NULL CHECK (kind IN ('review', 'check')),
      card        INTEGER NOT NULL,
      revision    TEXT    NOT NULL,
      ref         TEXT,
      agent       TEXT,
      profile     TEXT    NOT NULL,
      pid         INTEGER NOT NULL,
      started     INTEGER NOT NULL,
      job         TEXT,
      from_at     TEXT    NOT NULL,
      returned_at TEXT,
      why         TEXT,
      freed_at    TEXT,
      FOREIGN KEY (project, copy) REFERENCES copies (project, name) ON DELETE CASCADE
    ) STRICT, WITHOUT ROWID`,
    'CREATE UNIQUE INDEX copy_leases_open ON copy_leases (project, copy) WHERE freed_at IS NULL',
    'CREATE INDEX copy_leases_unfreed ON copy_leases (project) WHERE freed_at IS NULL',
    'CREATE INDEX copy_leases_ref ON copy_leases (ref) WHERE ref IS NOT NULL'
  ]
}

/**
 * Combwork's skill copies in folders' .agents/skills (#1431, SPEC §16.15 C row 15; Codex and Copilot): which copy Combwork made in
 * which folder, at which revision (the copy's contentHash, its marker left out). A clean-up removes a copy only when this
 * record and the copy's marker both say Combwork made it and its content is still that revision (skillCopies.ts). `project`
 * is the project folder the copy's session was in: Slots only compares the folder with it.
 */
export const SKILL_COPIES_STEP: SchemaStep = {
  name: 'skill copies',
  ddl: [
    `CREATE TABLE skill_copies (
      folder   TEXT NOT NULL COLLATE NOCASE,
      skill    TEXT NOT NULL COLLATE NOCASE,
      project  TEXT NOT NULL COLLATE NOCASE,
      revision TEXT NOT NULL,
      made_at  TEXT NOT NULL,
      PRIMARY KEY (folder, skill)
    ) STRICT, WITHOUT ROWID`
  ]
}

/**
 * Sessions on leases (#1434, SPEC §16.10.3): `sessions.lease`, the slot lease a session is bound to (set when it starts in
 * a slot; null in the project folder or a home; changed only by `rebindSession`, agentFolders.ts, in the lease change's
 * own write); `slot_leases.end_rev`, the slot's head once its ended lease's writer has drained (a free slot still there
 * is where its conversations may resume by hand); and a slot's writer, the session run that writes in it (its lease,
 * agent and Combwork), reserved in the write that lets it start and cleared once it has exited: while it is set the slot
 * isn't lent, adopted, taken by hand or removed. `lease` isn't in the sessions' codec: a record's save leaves it as it is.
 */
export const SESSION_LEASES_STEP: SchemaStep = {
  name: 'session leases',
  ddl: [
    'ALTER TABLE sessions ADD COLUMN lease TEXT',
    'ALTER TABLE slot_leases ADD COLUMN end_rev TEXT',
    'ALTER TABLE slots ADD COLUMN writer_run TEXT',
    'ALTER TABLE slots ADD COLUMN writer_lease TEXT',
    'ALTER TABLE slots ADD COLUMN writer_agent TEXT',
    'ALTER TABLE slots ADD COLUMN writer_pid INTEGER',
    'ALTER TABLE slots ADD COLUMN writer_started INTEGER'
  ]
}

/**
 * Card attachments (HI-1700): files kept with a card, in `<host>/.combwork/attachments/cards/<number>` (its project's folder,
 * the workspace's for a card with none), named there `file` (`<time>_<name>`), `name` as given. One copy of a file per card
 * (`sha256`); `comment`, the id of the comment that brought it (none: added to the card itself, or by its description).
 * Gone with the card (its folder to the Recycle Bin, cardAttachments.ts).
 */
export const CARD_ATTACHMENTS_STEP: SchemaStep = {
  name: 'card attachments',
  ddl: [
    `CREATE TABLE card_attachments (
      card    INTEGER NOT NULL REFERENCES cards (number) ON DELETE CASCADE,
      id      TEXT    NOT NULL,
      file    TEXT    NOT NULL,
      name    TEXT    NOT NULL,
      size    INTEGER NOT NULL,
      sha256  TEXT    NOT NULL,
      by      TEXT    NOT NULL,
      at      TEXT    NOT NULL,
      comment TEXT,
      PRIMARY KEY (card, id),
      UNIQUE (card, sha256)
    ) STRICT, WITHOUT ROWID`
  ]
}

/** A card's revision raised to the board's next mark, unless it is at the mark already (CARD_REVS_STEP). */
const bumpRev = (card: string): string =>
  `UPDATE board_rev SET g = g + 1 WHERE EXISTS (SELECT 1 FROM cards WHERE number = ${card} AND rev < board_rev.g);
   UPDATE cards SET rev = (SELECT g FROM board_rev) WHERE number = ${card} AND rev < (SELECT g FROM board_rev);`

/** The child tables a window's card is made of (composeCard), each a card's revision follows. */
const REV_TABLES = ['card_labels', 'card_links', 'card_context', 'card_comments', 'card_history', 'card_decisions', 'card_holds']

/**
 * A card's revision (HI-1715): `cards.rev`, raised by triggers on every write to the card's row or to a child table the
 * window's card is made of, by whatever wrote it (another Combwork's connection too), and `board_rev.g`, the board's mark,
 * the highest revision given. The window keeps the mark it last read and asks for the cards at it or above (`>=`): a card
 * already at the mark keeps it when it changes again (one raise for a card's many rows in a write, not one per row), and
 * is sent again however often; a card below it is raised above every mark a window holds. A rolled-back write undoes its
 * raises with it. Its key and project name come from outside these rows (tasks.windowChanges sends the whole board when
 * they change).
 */
export const CARD_REVS_STEP: SchemaStep = {
  name: 'card revisions',
  ddl: [
    'ALTER TABLE cards ADD COLUMN rev INTEGER NOT NULL DEFAULT 0',
    'CREATE INDEX cards_rev ON cards (rev)',
    'CREATE TABLE board_rev (id INTEGER PRIMARY KEY CHECK (id = 1), g INTEGER NOT NULL) STRICT',
    'INSERT INTO board_rev (id, g) VALUES (1, 1)',
    `CREATE TRIGGER card_rev_ai AFTER INSERT ON cards BEGIN ${bumpRev('NEW.number')} END`,
    // Not for the triggers' own raise of `rev`.
    `CREATE TRIGGER card_rev_au AFTER UPDATE ON cards WHEN NEW.rev = OLD.rev BEGIN ${bumpRev('NEW.number')} END`,
    ...REV_TABLES.flatMap((t) => [
      `CREATE TRIGGER ${t}_rev_ai AFTER INSERT ON ${t} BEGIN ${bumpRev('NEW.card')} END`,
      `CREATE TRIGGER ${t}_rev_au AFTER UPDATE ON ${t} BEGIN ${bumpRev('OLD.card')} ${bumpRev('NEW.card')} END`,
      `CREATE TRIGGER ${t}_rev_ad AFTER DELETE ON ${t} BEGIN ${bumpRev('OLD.card')} END`
    ])
  ]
}

/**
 * HI-2709: a target's queue merges, newest first, a page at a time (reconcile's carried-code walk): an index of the
 * `Integrated` facts by their target alone (its rowid, as every index's last key, orders a page and bounds it), so a page
 * is a range of that target's rows, never a scan of other targets'.
 */
export const INTEGRATED_TARGET_STEP: SchemaStep = {
  name: 'integrations by target',
  ddl: ["CREATE INDEX IF NOT EXISTS card_facts_integrated_target ON card_facts (json_extract(data, '$.target')) WHERE kind = 'Integrated'"]
}

/**
 * HI-2709: a page of a project's merges into a target (`Integrated` facts, any writer's), newest first, below a rowid:
 * arguments target, project, below, limit. The expression and the kind are the index's own, so it is that index's range.
 */
export const INTEGRATED_ON_SQL = "SELECT f.rowid AS row_id, f.* FROM card_facts f JOIN cards c ON c.number = f.card WHERE f.kind = 'Integrated' AND json_extract(f.data, '$.target') = ? AND c.project = ? AND f.rowid < ? ORDER BY f.rowid DESC LIMIT ?"

/** The 1.0 group's steps (P3's, then P4's, then P5's, then P7's), in the order they are registered. */
export const V1_0_STEPS: SchemaStep[] = [CARDS_STEP, SESSIONS_DELIVERIES, LANES_WATCHES_METRICS, FACTS_STEP, KEYS, LANE_RECORD, ACTIONS_DELIVERED_STEP, CARD_SEARCH_STEP, ASSISTANT_CHANGES_STEP, UNDO_OUTCOMES_STEP, QUEUE_RUNNERS_STEP, QUEUE_PAUSE_MESSAGE_STEP, QUEUE_PAUSE_BY_STEP, QUEUE_PAUSE_STATE_STEP, QUEUE_SEEN_STEP, SLOTS_STEP, COPIES_STEP, SKILL_COPIES_STEP, SESSION_LEASES_STEP, CARD_ATTACHMENTS_STEP, CARD_REVS_STEP, INTEGRATED_TARGET_STEP]

/** A module's query against the 1.0 tables, the index it must use, and sample arguments for EXPLAIN. */
export interface SchemaQuery {
  sql: string
  args: (string | number)[]
  /** The index the plan must use (`PRIMARY KEY`, `INTEGER PRIMARY KEY`, or an index's name), or the ones it may choose between. */
  index: string | string[]
}

/** The modules' real queries (named by module and use). */
export const QUERIES: Record<string, SchemaQuery> = {
  // assistantChanges.ts (#1282): a message's changes, those kept (7 days, newest first; the prune), a change's values.
  'undo.group': { sql: 'SELECT * FROM assistant_changes WHERE grp = ? AND grp_at >= ? ORDER BY at DESC', args: ['g1', '2026-10-01'], index: 'assistant_changes_grp' },
  'undo.kept': { sql: 'SELECT * FROM assistant_changes WHERE grp_at >= ? ORDER BY grp_at DESC', args: ['2026-10-01'], index: 'assistant_changes_grp_at' },
  'undo.values': { sql: 'SELECT field, side, ord, path, type, text, num FROM assistant_change_values WHERE change = ? ORDER BY field, side, ord', args: ['c1'], index: 'PRIMARY KEY' },
  'undo.outcomes': { sql: 'SELECT field, outcome FROM assistant_change_outcomes WHERE change = ? ORDER BY field', args: ['c1'], index: 'PRIMARY KEY' },
  // boardStore.ts: cards and their children.
  'board.card': { sql: 'SELECT * FROM cards WHERE number = ?', args: [1], index: 'INTEGER PRIMARY KEY' },
  'board.live': { sql: 'SELECT number FROM cards WHERE archived = ? ORDER BY number', args: [0], index: ['cards_place', 'cards_archived_project'] },
  'board.byAgent': { sql: 'SELECT number FROM cards WHERE agent IN (SELECT value FROM json_each(?))', args: ['["a1"]'], index: 'cards_agent' },
  'board.byReviewer': { sql: 'SELECT number FROM cards WHERE review_agent IN (SELECT value FROM json_each(?))', args: ['["a1"]'], index: 'cards_reviewer' },
  'board.byProject': { sql: 'SELECT number FROM cards WHERE project_id = ? AND archived = 0', args: ['p1'], index: 'cards_project' },
  // The board's search (#1237): cards whose searched text holds the words, through the full-text index (FTS5's MATCH on its
  // table column, the 6th: `0:M5`).
  'board.search': { sql: 'SELECT rowid AS number FROM card_search WHERE card_search MATCH ?', args: ['{title description project agent labels} : "release"'], index: '0:M5' },
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
  // The live cards changed since a mark (HI-1789, decisionChanges), and which of them have decisions.
  'board.liveChanged': { sql: 'SELECT number, archived FROM cards WHERE rev >= ?', args: [1], index: 'cards_rev' },
  'board.decided': { sql: 'SELECT DISTINCT card FROM card_decisions WHERE card IN (SELECT value FROM json_each(?))', args: ['[1]'], index: 'PRIMARY KEY' },
  'board.holds': { sql: 'SELECT * FROM card_holds WHERE card = ? ORDER BY ord', args: [1], index: 'PRIMARY KEY' },
  'board.context': { sql: 'SELECT ref FROM card_context WHERE card = ? ORDER BY ord', args: [1], index: 'PRIMARY KEY' },
  // sessionStore.ts: a host's sessions, one by id, some by their ids and their cards, an agent's, a card's.
  'sessions.host': { sql: 'SELECT * FROM sessions WHERE host = ? ORDER BY ord', args: ['p1'], index: 'PRIMARY KEY' },
  'sessions.byId': { sql: 'SELECT * FROM sessions WHERE host = ? AND id = ?', args: ['p1', 's1'], index: 'PRIMARY KEY' },
  'sessions.byAgent': { sql: 'SELECT id FROM sessions WHERE host = ? AND agent_id = ? ORDER BY last_active_at DESC, ord, id', args: ['p1', 'a1'], index: 'sessions_agent' },
  'sessions.byIds': { sql: 'SELECT * FROM sessions WHERE host = ? AND id IN (SELECT value FROM json_each(?))', args: ['p1', '["s1"]'], index: 'PRIMARY KEY' },
  'sessions.cardsOf': { sql: 'SELECT * FROM session_cards WHERE host = ? AND session IN (SELECT value FROM json_each(?)) ORDER BY session, ord', args: ['p1', '["s1"]'], index: 'PRIMARY KEY' },
  'sessions.byCard': { sql: 'SELECT session FROM session_cards WHERE card = ? AND host = ?', args: [1, 'p1'], index: 'session_cards_card' },
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
  // HI-2709: a page of a target's queue merges, newest first, below a rowid (reconcile's carried-code walk).
  'facts.integratedOn': { sql: INTEGRATED_ON_SQL, args: ['main', 'p', 1e15, 10], index: 'card_facts_integrated_target' },
  'links.dependents': { sql: "SELECT card FROM card_links WHERE target = ? AND kind = 'blockedBy' ORDER BY card", args: [1], index: 'card_links_target' },
  // cardWork.ts: the live cards' facts for the board's badges (#1223), an archived card's never read.
  'facts.live': { sql: 'SELECT f.* FROM cards c JOIN card_facts f ON f.card = c.number WHERE c.archived = 0 ORDER BY f.card, f.seq', args: [], index: 'sqlite_autoindex_card_facts_1' },
  'actions.pending': { sql: "SELECT * FROM card_actions WHERE state = 'pending' ORDER BY id", args: [], index: 'card_actions_pending' },
  'actions.ofCard': { sql: 'SELECT * FROM card_actions WHERE card = ?', args: [1], index: 'card_actions_card' },
  'rulesets.byId': { sql: 'SELECT data FROM rulesets WHERE id = ?', args: ['r1'], index: 'PRIMARY KEY' },
  'folderCommits.of': { sql: 'SELECT sha, card, how FROM folder_commits WHERE folder = ? ORDER BY id', args: ['D:\\ws\\p'], index: 'folder_commits_seen' },
  'paths.ofCard': { sql: 'SELECT path FROM card_paths WHERE card = ? AND kind = ? ORDER BY ord', args: [1, 'declared'], index: 'PRIMARY KEY' },
  'paths.cardsOf': { sql: 'SELECT card FROM card_paths WHERE path = ?', args: ['src/a.txt'], index: 'card_paths_path' },
  // factStore.ts: a lane as the runtime reads it (lanes.ts's row and what the runtime keeps beside it), a card's lanes.
  'lanes.byId': { sql: 'SELECT state, reviewer_id FROM lanes WHERE id = ? AND project = ? COLLATE NOCASE', args: ['L', 'p'], index: 'PRIMARY KEY' },
  'laneRuns.of': { sql: 'SELECT ruleset, current_card, has_pending FROM lane_runs WHERE lane = ?', args: ['L'], index: 'PRIMARY KEY' },
  'lanePending.of': { sql: 'SELECT card FROM lane_pending WHERE lane = ? ORDER BY ord', args: ['L'], index: 'PRIMARY KEY' },
  'lanePending.ofCard': { sql: 'SELECT lane FROM lane_pending WHERE card = ?', args: [1], index: 'lane_pending_card' },
  'lanes.ofCards': {
    sql: "SELECT x.card, l.id, l.reviewer_id FROM (SELECT lane, card FROM lane_cards UNION ALL SELECT lane, card FROM lane_pending) x JOIN lanes l ON l.id = x.lane WHERE x.card IN (SELECT number FROM cards WHERE number = ?) AND l.state = 'active' AND l.project = ? COLLATE NOCASE ORDER BY (l.builder_id IS (SELECT agent FROM cards WHERE number = x.card)), l.started_at, l.id",
    args: [1, 'p'],
    index: ['lane_cards_card', 'lane_pending_card']
  },
  'queuePauses.of': { sql: 'SELECT reason, card, pid, message, paused_by, paused_at, folder, branch, ref, expected, result, phase FROM workflow_queue_pauses WHERE project = ? AND target = ?', args: ['p', 'main'], index: 'PRIMARY KEY' },
  'queuePauses.files': { sql: 'SELECT path, side FROM workflow_queue_pause_files WHERE project = ? AND target = ? ORDER BY ord', args: ['p', 'main'], index: 'PRIMARY KEY' },
  'queuePauses.commands': { sql: 'SELECT ord, purpose, place FROM workflow_queue_pause_commands WHERE project = ? AND target = ? ORDER BY ord', args: ['p', 'main'], index: 'PRIMARY KEY' },
  'queuePauses.commandArgs': { sql: 'SELECT command, arg FROM workflow_queue_pause_command_args WHERE project = ? AND target = ? ORDER BY command, ord', args: ['p', 'main'], index: 'PRIMARY KEY' },
  // queueControls.ts (#1353): a project's paused targets, for its queues' listing.
  'queuePauses.ofProject': { sql: 'SELECT target FROM workflow_queue_pauses WHERE project = ?', args: ['p'], index: 'PRIMARY KEY' },
  // queueControls.ts (#1356): when the user saw a project's returned entries.
  'queueSeen.ofProject': { sql: 'SELECT entry, seen_at FROM workflow_queue_seen WHERE project = ?', args: ['p'], index: 'PRIMARY KEY' },
  // skillCopies.ts (#1431): a folder's copies, one copy's record.
  'skillCopies.of': { sql: 'SELECT skill, project, revision, made_at FROM skill_copies WHERE folder = ?', args: ['D:\\ws\\p'], index: 'PRIMARY KEY' },
  'skillCopies.one': { sql: 'SELECT revision FROM skill_copies WHERE folder = ? AND skill = ?', args: ['D:\\ws\\p', 'handover'], index: 'PRIMARY KEY' },
  // queueRunner.ts (through factStore.ts): a target's lease, a lease by id (holds), its processes, a target's folders.
  'queueRunners.of': { sql: 'SELECT * FROM queue_runners WHERE project = ? AND target = ?', args: ['p', 'main'], index: 'PRIMARY KEY' },
  'queueRunners.holds': { sql: 'SELECT 1 FROM queue_runners WHERE lease = ? AND token = ?', args: ['l1', 't1'], index: 'sqlite_autoindex_queue_runners_1' },
  'queueRunnerProcs.of': { sql: 'SELECT pid, start_after, start_before, what FROM queue_runner_procs WHERE lease = ?', args: ['l1'], index: 'PRIMARY KEY' },
  'queueRunnerProcs.ofTarget': { sql: 'SELECT * FROM queue_runner_procs WHERE project = ? AND target = ?', args: ['p', 'main'], index: 'queue_runner_procs_target' },
  'queueWorktrees.of': { sql: 'SELECT folder, lease FROM queue_worktrees WHERE project = ? AND target = ?', args: ['p', 'main'], index: 'queue_worktrees_target' },
  // slots.ts (#1429): a project's slots, one by name, a slot's open lease, a card's or a lane's, an agent's, a slot's last.
  'slots.ofProject': { sql: 'SELECT * FROM slots WHERE project = ? ORDER BY name', args: ['p'], index: 'PRIMARY KEY' },
  'slots.byName': { sql: 'SELECT * FROM slots WHERE project = ? AND name = ?', args: ['p', 'slot-a'], index: 'PRIMARY KEY' },
  'slotLeases.openOf': { sql: 'SELECT * FROM slot_leases WHERE project = ? AND slot = ? AND ended_at IS NULL', args: ['p', 'slot-a'], index: ['slot_leases_open', 'slot_leases_slot'] },
  'slotLeases.ofCard': { sql: 'SELECT * FROM slot_leases WHERE card = ? AND ended_at IS NULL', args: [1], index: 'slot_leases_card' },
  'slotLeases.ofLane': { sql: 'SELECT * FROM slot_leases WHERE lane = ? AND ended_at IS NULL', args: ['l1'], index: 'slot_leases_lane' },
  'slotLeases.ofAgent': { sql: 'SELECT * FROM slot_leases WHERE project = ? AND agent = ? AND ended_at IS NULL', args: ['p', 'a1'], index: 'slot_leases_agent' },
  // copies.ts (#1435): a project's copies, its leases not freed, a copy's, a lease by its run or link.
  'copies.ofProject': { sql: 'SELECT * FROM copies WHERE project = ? ORDER BY name', args: ['p'], index: 'PRIMARY KEY' },
  'copyLeases.unfreed': { sql: 'SELECT * FROM copy_leases WHERE project = ? AND freed_at IS NULL', args: ['p'], index: ['copy_leases_unfreed', 'copy_leases_open'] },
  'copyLeases.openOf': { sql: 'SELECT * FROM copy_leases WHERE project = ? AND copy = ? AND freed_at IS NULL', args: ['p', 'copy-1'], index: 'copy_leases_open' },
  'copyLeases.byRef': { sql: 'SELECT * FROM copy_leases WHERE ref = ?', args: ['r1'], index: 'copy_leases_ref' },
  'slotLeases.lastOf': { sql: 'SELECT * FROM slot_leases WHERE project = ? AND slot = ? ORDER BY from_at DESC LIMIT 1', args: ['p', 'slot-a'], index: 'slot_leases_slot' },
  // cardRefs.ts: a key to its card (current key, an old key of the project, a moved card's alias), a project's key.
  'keys.resolve': { sql: 'SELECT c.number FROM project_keys k JOIN cards c ON c.project_id = k.project_id AND c.project_number = ? WHERE k.key = ?', args: [12, 'am'], index: 'cards_project_number' },
  'keys.alias': { sql: 'SELECT a.card FROM project_keys k JOIN card_aliases a ON a.project_id = k.project_id AND a.number = ? WHERE k.key = ?', args: [12, 'am'], index: 'PRIMARY KEY' },
  'keys.current': { sql: 'SELECT key FROM project_keys WHERE project_id = ? AND current = 1', args: ['p1'], index: 'project_keys_current' },
  'keys.counter': { sql: 'SELECT next FROM project_counters WHERE project_id = ?', args: ['p1'], index: 'PRIMARY KEY' },
  'keys.aliasesOf': { sql: 'SELECT project_id, number FROM card_aliases WHERE card = ?', args: [1], index: 'card_aliases_card' }
}
