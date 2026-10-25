// The merge queue after the 1.0 upgrade, in one session (#1621): a workspace whose board 0.9 left opens in the dev build,
// read-only and asked first. Opening it, the steps that need a board taking writes (the merge queues, the cards' and
// projects' ids and keys, ending reviews, archiving) skip it quietly: the log has no "no such table" nor "This board is
// from Hive 0.9" from them. The user says Upgrade; then, with no restart, a card approved under "Hive merges" is merged
// by the queue (Done, Integrated by Hive, the target at it).
// The 0.9 board is written here as 0.9.3's schema steps made it (v1 `cards`, v2 `store_rows`: 0.9 is released, so they
// are fixed), so no packaged 0.9 is needed. Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')
const q = require('./queueFixture.cjs')

const PORT = Number(lib.port(47900))
const fx = q.queueProject('queueupgrade')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000
const ASK = "Upgrade this workspace's board to 1.0?"
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms) => lib.until(fn, ms, 200)
const dbFile = path.join(fx.ws, '.hive', 'hive.db')

/** The workspace's board as Hive 0.9.3 left it: its two schema steps, no cards. */
function board09() {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true })
  const db = new DatabaseSync(dbFile)
  try {
    db.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL, hive_version TEXT NOT NULL) STRICT;
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
      CREATE TABLE store_rows (store TEXT NOT NULL, scope TEXT NOT NULL, key TEXT NOT NULL, ord INTEGER NOT NULL, doc TEXT NOT NULL, PRIMARY KEY (store, scope, key)) STRICT, WITHOUT ROWID;
      CREATE TABLE store_meta (store TEXT NOT NULL, scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (store, scope, key)) STRICT, WITHOUT ROWID;
    `)
    const at = new Date().toISOString()
    const put = db.prepare('INSERT INTO schema_version (version, name, applied_at, hive_version) VALUES (?, ?, ?, ?)')
    put.run(1, 'cards', at, '0.9.3')
    put.run(2, 'store_rows', at, '0.9.3')
  } finally {
    db.close()
  }
}

/** The board's rows for a query, read on a connection of the suite's own. */
function rows(sql, ...args) {
  const db = new DatabaseSync(dbFile, { readOnly: true, timeout: 5000 })
  try {
    return db.prepare(sql).all(...args)
  } finally {
    db.close()
  }
}

/** The test profile's log as it is now. */
const log = () => {
  try {
    return fs.readFileSync(path.join(fx.userData, 'logs', 'hive.log'), 'utf8')
  } catch {
    return ''
  }
}

;(async () => {
  q.prepare(fx)
  board09()
  // Opened as the user opens it: the ask shows, nothing is pre-answered (no HIVE_TEST_BOARD_UPGRADE), options kept for after.
  const h = await q.startHive(fx, { port: PORT, keepOptions: true })
  try {
    h.page.on('pageerror', (e) => check('no page errors', false, e.message))
    const ask = h.page.locator('.dialog', { hasText: ASK })
    check('the 0.9 board opens read-only, asked first', !!(await until(async () => (await ask.count()) === 1, HUNG_MS)) && (await h.inv('board:state')).readOnly === 'upgrade')
    // The opening's steps have begun by the time its line is logged (they start before it, in the background).
    check('…the workspace opened', !!(await until(() => log().includes('[workspace] Opened workspace'), HUNG_MS)))

    await ask.getByRole('button', { name: 'Upgrade', exact: true }).click()
    check('Upgrade upgrades it', !!(await until(async () => (await h.inv('board:state')).readOnly === null, HUNG_MS)))
    // The adoption runs once after the upgrade, in the background: the project's options are set after it.
    check('…then the adoption, once', !!(await until(() => rows("SELECT value FROM board_meta WHERE key = 'adoption'").length === 1, HUNG_MS)))
    const skipped = log().split(/\r?\n/).filter((l) => /\[WARN\]/.test(l) && /no such table|This board is from Hive 0\.9/.test(l))
    check('while it waited, nothing failed on the read-only board (no "no such table", no "This board is from Hive 0.9")', skipped.length === 0, skipped.join(' | '))

    // No restart: "Hive merges" into integration, and a card approved now is merged by the queue.
    await h.inv('workflow:setOptions', fx.alpha, { preset: null, options: q.queueOptions(fx) })
    const reviewer = await q.agent(fx, h, 'R1')
    check('the reviewer has its token', !!reviewer.token)
    q.steer(fx, 'pass')
    const one = await q.approve(fx, h, reviewer, 'After the upgrade', { 'one.txt': 'one\n' })
    check('a card is approved after the upgrade (start, submit, review, pass)', Object.values(one.steps).every((s) => s.status === 200), JSON.stringify(one.steps))
    const done = await until(async () => (await h.card(one.n))?.column === 'done', HUNG_MS)
    check('the queue merges it with no restart: Done', !!done, JSON.stringify(await h.kinds(one.n)))
    const integrated = (await h.facts(one.n)).find((f) => f.kind === 'Integrated')
    const inTarget = () => {
      try {
        lib.git(fx.alpha, ['merge-base', '--is-ancestor', one.revision, 'integration'])
        return true
      } catch {
        return false
      }
    }
    check("…Integrated by Hive, the target at its result, the builder's revision in it", integrated?.data?.by === 'hive' && integrated.data.result === q.head(fx) && inTarget(), JSON.stringify(integrated))
    const queueWarnings = log().split(/\r?\n/).filter((l) => /\[WARN\] \[queue\]/.test(l))
    check('…and the queue warned of nothing', queueWarnings.length === 0, queueWarnings.join(' | '))
  } catch (e) {
    check('no exception', false, e.stack)
  } finally {
    await h.app.close().catch(() => {})
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
