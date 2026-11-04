// The workspace database from before (the board's schema 1, #1017) gets 0.9's stores tables (schema 2) with its cards
// kept. The stores' own tests are where they live now: sessions' and deliveries' typed tables in sessionStore.test.ts,
// deliveries.test.ts and sessionDeliveryTables.test.ts (#1211), lanes', watches' and metrics' in storeTables.test.ts (#1212).
import { mkdirSync, readdirSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { tempDir } from './tempDir'

const base = tempDir('hive-store-rows-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const board = await import('../src/main/boardStore')
const { openDb, schemaVersion } = await import('../src/main/db')

let n = 0
/** A new workspace folder (no board yet). */
const workspace = (): string => {
  const ws = join(base, `ws-${++n}`)
  mkdirSync(join(ws, '.combwork'), { recursive: true })
  return ws
}

afterAll(() => board.closeAllBoards())

describe('the workspace database from before (#1017: schema 1)', () => {
  it('gets the stores tables (schema 2), its cards kept, after a backup', () => {
    const ws = workspace()
    const file = join(ws, '.combwork', 'hive.db')
    const v1 = openDb(file, { migrations: board.BOARD_MIGRATIONS.slice(0, 1), hiveVersion: '0.9.0' })
    v1.writer.prepare('INSERT INTO cards (number, doc) VALUES (1, ?)').run(JSON.stringify({ number: 1, title: 'Kept', column: 'todo' }))
    v1.close()
    // 0.9's steps (the 1.0 group's have their own tests: boardUpgrade.test.ts).
    const db = openDb(file, { migrations: board.BOARD_MIGRATIONS.filter((m) => !m.group), hiveVersion: '0.9.0', backupDir: join(ws, '.combwork', 'backups') })
    try {
      expect(schemaVersion(db.writer)).toBe(2)
      expect((db.reader.prepare('SELECT count(*) AS n FROM cards').get() as { n: number }).n).toBe(1)
      expect(readdirSync(join(ws, '.combwork', 'backups')).some((f) => f.startsWith('hive-v1-'))).toBe(true)
      expect(db.reader.prepare("SELECT name FROM sqlite_master WHERE name IN ('store_rows', 'store_meta') ORDER BY name").all().map((r) => (r as { name: string }).name)).toEqual(['store_meta', 'store_rows'])
    } finally {
      db.close()
    }
    const check = new DatabaseSync(file, { readOnly: true })
    expect({ ...(check.prepare('SELECT max(version) AS v FROM schema_version').get() as object) }).toEqual({ v: 2 })
    check.close()
  })
})
