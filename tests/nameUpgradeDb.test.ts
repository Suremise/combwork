// HI-2587: the names upgrade inside the databases. Every database's schema_version column of the version that ran each
// step, `hive_version` before 1.1, is `app_version` once opened, its rows as they were, and a new file has it so from the
// start; the board's step 25 renames the cards' `hive_text` column (a comment's text as data) to `app_text`, its values
// kept, and the 0.9 import's record's `hiveVersion` to `appVersion`.
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'
import { openDb, renameVersionColumn } from '../src/main/db'
import { BOARD_MIGRATIONS } from '../src/main/boardStore'

const base = tempDir('nameupgrade-db-')
let n = 0

const columns = (db: DatabaseSync, table: string): string[] => (db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]).map((c) => c.name)

describe('the version column', () => {
  it("a file from before 1.1 has it renamed, its rows kept; then nothing", () => {
    const file = join(base, `old${++n}.db`)
    const db = new DatabaseSync(file)
    db.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL, hive_version TEXT NOT NULL) STRICT')
    db.prepare('INSERT INTO schema_version VALUES (1, ?, ?, ?)').run('one', 'then', '1.0.0')
    renameVersionColumn(db)
    expect(columns(db, 'schema_version')).toEqual(['version', 'name', 'applied_at', 'app_version'])
    expect(db.prepare('SELECT app_version FROM schema_version').get()).toEqual({ app_version: '1.0.0' })
    renameVersionColumn(db)
    expect(columns(db, 'schema_version')).toEqual(['version', 'name', 'applied_at', 'app_version'])
    db.close()
  })

  it('opened through openDb: renamed before the next step records its version under the new name', () => {
    const file = join(base, `steps${++n}.db`)
    const db0 = new DatabaseSync(file)
    db0.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL, hive_version TEXT NOT NULL) STRICT')
    db0.exec('CREATE TABLE a (x)')
    db0.prepare('INSERT INTO schema_version VALUES (1, ?, ?, ?)').run('one', 'then', '1.0.0')
    db0.close()
    const db = openDb(file, { migrations: [{ version: 1, name: 'one', up: (d) => d.exec('CREATE TABLE a (x)') }, { version: 2, name: 'two', up: (d) => d.exec('CREATE TABLE b (y)') }], appVersion: '1.1.0' })
    expect(db.writer.prepare('SELECT version, app_version FROM schema_version ORDER BY version').all()).toEqual([{ version: 1, app_version: '1.0.0' }, { version: 2, app_version: '1.1.0' }])
    db.close()
  })
})

describe("the board's names step", () => {
  it("renames the comments' hive_text column (a 1.0 or RC board's) and the import record's key", () => {
    const file = join(base, `board${++n}.db`)
    const before = BOARD_MIGRATIONS.filter((m) => m.version < 25)
    const db0 = openDb(file, { migrations: before, appVersion: '1.0.0', approve: () => true })
    // As 1.0 and the 1.1 release candidates made it (this build's cards step makes app_text).
    db0.writer.exec('ALTER TABLE card_comments RENAME COLUMN app_text TO hive_text')
    db0.writer.exec("INSERT INTO board_meta (key, value) VALUES ('imported', '{\"at\":\"then\",\"cards\":3,\"hiveVersion\":\"0.9.3\"}')")
    db0.close()
    const db = openDb(file, { migrations: BOARD_MIGRATIONS, appVersion: '1.1.0', approve: () => true })
    const cols = columns(db.writer, 'card_comments')
    expect(cols).toContain('app_text')
    expect(cols).not.toContain('hive_text')
    expect(JSON.parse((db.writer.prepare("SELECT value FROM board_meta WHERE key = 'imported'").get() as { value: string }).value)).toEqual({ at: 'then', cards: 3, appVersion: '0.9.3' })
    db.close()
  })
})
