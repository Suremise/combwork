// The 1.0 group's steps (#1207, SPEC §16.17) as a 1.x board takes them: a group of schema steps run as one (the file
// locked to one connection, an ordinary copy, one transaction), refused while another Combwork has the file open. And
// a board from before the group, 0.9's, refused before anything opens it for writing (HI-3602: the upgrade from 0.9 is
// gone), its version read without making or changing anything beside it (fileFormat), the WAL counted.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { join, relative } from 'path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { tempDir } from './tempDir'
import { timing } from './timing.cjs'

const base = tempDir('cw-board-upgrade-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const { DbInUseError, FormatUnknownError, TooOldError, fileFormat, fileSchemaVersion, formatTestHooks, openDb, schemaVersion, BACKUPS_KEPT } = await import('../src/main/db')
const { PRESENCE_DIR, STALE_MS } = await import('../src/main/presence')

type Step = { version: number; name: string; group?: string; up: (d: DatabaseSync) => void }
const user = { kind: 'user' } as const
let n = 0
type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterAll(async () => {
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})
afterEach(() => {
  store.boardTestHooks.whileUpgrading = null
  formatTestHooks.copy = undefined
})

const fileIn = (): { dir: string; file: string; backups: string } => {
  const dir = join(base, `db-${++n}`)
  mkdirSync(dir, { recursive: true })
  return { dir, file: join(dir, 'x.db'), backups: join(dir, 'backups') }
}
const tables = (file: string): string[] => {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name)
  } finally {
    db.close()
  }
}
/** Every file under `dir`, by its path there, with its size and its bytes' hash: what "nothing changed" compares. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) {
        out[`${relative(dir, p)}/`] = 'dir'
        walk(p)
      } else out[relative(dir, p)] = `${statSync(p).size}:${createHash('sha256').update(readFileSync(p)).digest('hex')}`
    }
  }
  walk(dir)
  return out
}

const plain: Step[] = [
  { version: 1, name: 'one', up: (d) => d.exec('CREATE TABLE a (x); INSERT INTO a VALUES (1)') },
  { version: 2, name: 'two', up: (d) => d.exec('CREATE TABLE b (y)') }
]
const group = (third: (d: DatabaseSync) => void = (d) => d.exec('CREATE TABLE d (w)')): Step[] => [
  { version: 3, name: 'three', group: '1.0', up: (d) => d.exec('CREATE TABLE c (z)') },
  { version: 4, name: 'four', group: '1.0', up: third }
]
const five: Step = { version: 5, name: 'five', group: '1.0', up: (d) => d.exec('CREATE TABLE e (v)') }
/** A file at v4 with data, as a 1.x build made it (every step, as a new file takes them). */
function at10(): { dir: string; file: string; backups: string } {
  const f = fileIn()
  openDb(f.file, { migrations: [...plain, ...group()], appVersion: '1.0.0', backupDir: f.backups, refuseBefore: 3 }).close()
  return f
}
/** A file at v2 with data, as 0.9 left it. */
function at09(): { dir: string; file: string; backups: string } {
  const f = fileIn()
  openDb(f.file, { migrations: plain, appVersion: '0.9.3' }).close()
  return f
}
/**
 * `make` run on a new connection that never checkpoints, the file and its WAL then copied (no `-shm`) into a folder of
 * their own: a board whose commits since `seed` are only in its WAL, as a Combwork that ended without quitting leaves one.
 */
function walOnly(seed: ((file: string) => void) | null, make: (d: DatabaseSync) => void): { dir: string; file: string } {
  const src = fileIn()
  seed?.(src.file)
  const d = new DatabaseSync(src.file)
  d.exec('PRAGMA journal_mode = WAL')
  d.exec('PRAGMA wal_autocheckpoint = 0')
  make(d)
  const out = fileIn()
  copyFileSync(src.file, out.file)
  copyFileSync(`${src.file}-wal`, `${out.file}-wal`)
  d.close()
  return out
}

describe('a group of steps (db.ts)', () => {
  it('runs every pending step of the group in one transaction: a throwing step leaves the file before them', () => {
    const f = at10()
    const six: Step = { version: 6, name: 'six', group: '1.0', up: () => { throw new Error('step six broke') } }
    expect(() => openDb(f.file, { migrations: [...plain, ...group(), five, six], appVersion: '1.1.0', backupDir: f.backups, refuseBefore: 3 })).toThrow('step six broke')
    expect(tables(f.file)).not.toContain('e')
    expect(fileSchemaVersion(f.file)).toBe(4)
    // And the lock went back: the file opens again, and the steps run once they work.
    const db = openDb(f.file, { migrations: [...plain, ...group(), five], appVersion: '1.1.0', backupDir: f.backups, refuseBefore: 3 })
    try {
      expect(schemaVersion(db.writer)).toBe(5)
      expect((db.writer.prepare('PRAGMA locking_mode').get() as { locking_mode: string }).locking_mode).toBe('normal')
    } finally {
      db.close()
    }
  })

  it('a new file takes every step, the group too, and gets no copy', () => {
    const f = fileIn()
    const db = openDb(f.file, { migrations: [...plain, ...group()], appVersion: '1.0.0', backupDir: f.backups, refuseBefore: 3 })
    try {
      expect(schemaVersion(db.writer)).toBe(4)
    } finally {
      db.close()
    }
    expect(existsSync(f.backups)).toBe(false)
  })

  it("a later step of the group on a file in it already: an ordinary copy of the file's three, never a 'before the group' one", () => {
    const f = at10()
    openDb(f.file, { migrations: [...plain, ...group(), five], appVersion: '1.0.1', backupDir: f.backups, refuseBefore: 3 }).close()
    expect(fileSchemaVersion(f.file)).toBe(5)
    const after = readdirSync(f.backups)
    expect(after.filter((x) => x.includes('before-'))).toEqual([])
    expect(after.filter((x) => x.startsWith('x-v4-'))).toHaveLength(1)
  })

  it('a copy 1.0 kept of a 0.9 board (before-1.0) is never pruned by the copies after it (HI-3602: the users\' backups stay)', () => {
    const f = at10()
    mkdirSync(f.backups, { recursive: true })
    const kept = join(f.backups, 'x-before-1.0-v2-2026-01-01T00-00-00-000Z.db')
    writeFileSync(kept, 'the 0.9 board as 1.0 kept it')
    let steps: Step[] = [...plain, ...group()]
    for (let v = 5; v < 5 + BACKUPS_KEPT + 2; v++) {
      steps = [...steps, { version: v, name: `v${v}`, group: '1.0', up: (d) => d.exec(`CREATE TABLE t${v} (q)`) }]
      openDb(f.file, { migrations: steps, appVersion: '1.0.0', backupDir: f.backups, refuseBefore: 3 }).close()
    }
    const after = readdirSync(f.backups)
    expect(after.filter((x) => x.startsWith('x-v'))).toHaveLength(BACKUPS_KEPT)
    expect(readFileSync(kept, 'utf8')).toBe('the 0.9 board as 1.0 kept it')
  })

  it('is refused while another connection has the file open, changing nothing; runs once it has closed', () => {
    const f = at10()
    const other = new DatabaseSync(f.file)
    other.prepare('SELECT count(*) FROM a').get()
    try {
      expect(() => openDb(f.file, { migrations: [...plain, ...group(), five], appVersion: '1.0.1', backupDir: f.backups, refuseBefore: 3 })).toThrow(DbInUseError)
      expect(schemaVersion(other)).toBe(4)
      // The other connection still writes: nothing was left locked.
      other.exec('INSERT INTO a VALUES (2)')
    } finally {
      other.close()
    }
    const db = openDb(f.file, { migrations: [...plain, ...group(), five], appVersion: '1.0.1', backupDir: f.backups, refuseBefore: 3 })
    try {
      expect(schemaVersion(db.writer)).toBe(5)
      expect(db.reader.prepare('SELECT count(*) AS n FROM a').get()).toEqual({ n: 2 })
    } finally {
      db.close()
    }
  })

  it('holds the file for the whole run: another connection opening it meanwhile is refused', () => {
    const f = at10()
    let during: string | null = null
    const db = openDb(f.file, {
      migrations: [...plain, ...group(), five],
      appVersion: '1.0.1',
      backupDir: f.backups,
      whileGroupLocked: () => {
        const other = new DatabaseSync(f.file, { timeout: 100 }) // timing-ok: the refusal under test: a brief busy wait, then refused while the run holds the file
        try {
          other.prepare('SELECT count(*) FROM a').get()
          during = 'read'
        } catch (e) {
          during = (e as Error).message
        } finally {
          other.close()
        }
      }
    })
    db.close()
    expect(during).toMatch(/locked/)
  })

  it("a refusal before the copy (another Combwork's marker) changes nothing and lets go of the file", () => {
    const f = at10()
    const before = readdirSync(f.dir)
    expect(() => openDb(f.file, { migrations: [...plain, ...group(), five], appVersion: '1.0.1', backupDir: f.backups, beforeGroup: () => { throw new Error('another Combwork') } })).toThrow('another Combwork')
    expect(readdirSync(f.dir)).toEqual(before)
    const other = new DatabaseSync(f.file, { timeout: timing('db.busyMs') })
    try {
      expect(schemaVersion(other)).toBe(4)
      other.exec('INSERT INTO a VALUES (3)')
    } finally {
      other.close()
    }
  })
})

describe('a board from before the group, 0.9\'s, is refused untouched (HI-3602)', () => {
  it('openDb refuses it before opening it for writing: every name and byte beside it as it was', () => {
    const f = at09()
    mkdirSync(f.backups, { recursive: true })
    writeFileSync(join(f.backups, 'x-before-1.0-v2-2026-01-01T00-00-00-000Z.db'), 'a backup')
    // 0.9's version column, which a writable open renames (HI-2587).
    const raw = new DatabaseSync(f.file)
    raw.exec('ALTER TABLE schema_version RENAME COLUMN app_version TO hive_version') // old-name: 0.9's column, which the refusal must leave as it is
    raw.close()
    const was = snapshot(f.dir)
    expect(() => openDb(f.file, { migrations: [...plain, ...group()], appVersion: '1.8.0', backupDir: f.backups, refuseBefore: 3 })).toThrow(TooOldError)
    expect(snapshot(f.dir)).toEqual(was)
  })

  it('reads the version from the WAL where the main file may lag: a 0.9 board only in its WAL, with no -shm, is refused, nothing added', () => {
    const f = walOnly(null, (d) => {
      d.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL, app_version TEXT NOT NULL) STRICT')
      d.exec("INSERT INTO schema_version VALUES (1, 'one', 'x', '0.9.3'), (2, 'two', 'x', '0.9.3')")
      d.exec('CREATE TABLE a (x); INSERT INTO a VALUES (1)')
    })
    const dir = join(f.file, '..')
    expect(existsSync(`${f.file}-shm`)).toBe(false)
    const was = snapshot(dir)
    // The main file alone says nothing of it (its commits are in the WAL).
    expect(fileFormat(f.file)).toEqual({ version: 2, tables: true })
    expect(() => openDb(f.file, { migrations: [...plain, ...group()], appVersion: '1.8.0', refuseBefore: 3 })).toThrow(TooOldError)
    expect(snapshot(dir)).toEqual(was)
  })

  it('a 1.0 board whose group steps are only in its WAL is read at its real version: not refused, opened as it is', () => {
    const f = walOnly((file) => openDb(file, { migrations: plain, appVersion: '0.9.3' }).close(), (d) => {
      d.exec('CREATE TABLE c (z); CREATE TABLE d (w)')
      d.exec("INSERT INTO schema_version VALUES (3, 'three', 'x', '1.0.0'), (4, 'four', 'x', '1.0.0')")
      d.exec('INSERT INTO a VALUES (2)')
    })
    expect(fileFormat(f.file)).toEqual({ version: 4, tables: true })
    const db = openDb(f.file, { migrations: [...plain, ...group()], appVersion: '1.8.0', refuseBefore: 3 })
    try {
      expect(schemaVersion(db.writer)).toBe(4)
      expect(db.reader.prepare('SELECT count(*) AS n FROM a').get()).toEqual({ n: 2 })
    } finally {
      db.close()
    }
  })

  it("a WAL that can't be read, or that changes while it is copied, refuses the open: nothing opened for writing, nothing added", () => {
    for (const how of ['fails', 'changes'] as const) {
      const f = walOnly((file) => openDb(file, { migrations: plain, appVersion: '0.9.3' }).close(), (d) => d.exec('INSERT INTO a VALUES (2)'))
      const dir = join(f.file, '..')
      const was = snapshot(dir)
      formatTestHooks.copy = (from, to) => {
        if (how === 'fails') throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
        copyFileSync(from, to)
        // Another process's commit as it was read: the WAL grows.
        if (from.endsWith('-wal')) writeFileSync(from, Buffer.concat([readFileSync(from), Buffer.alloc(8)]))
      }
      expect(() => openDb(f.file, { migrations: [...plain, ...group()], appVersion: '1.8.0', refuseBefore: 3 }), how).toThrow(FormatUnknownError)
      formatTestHooks.copy = undefined
      if (how === 'fails') expect(snapshot(dir), how).toEqual(was)
      // Only the WAL this test grew changed; nothing was added beside it.
      else expect(Object.keys(snapshot(dir)).sort(), how).toEqual(Object.keys(was).sort())
    }
  })
})

// ---------------------------------------------------------------------------
// The board.
// ---------------------------------------------------------------------------

async function open(ws: string): Promise<WS> {
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return w
}
async function close(w: WS): Promise<void> {
  const path = w.path!
  opened.splice(opened.indexOf(w), 1)
  await disposeWorkspaceService(w)
  store.closeBoard(path)
}
const upgradeSteps = store.BOARD_MIGRATIONS.filter((m) => m.group === '1.0')
const titles = async (w: WS): Promise<string[]> => (await inWorkspace(w, () => tasks.allTasks(w))).map((c) => c.title).sort()

/** A workspace with card #1 on its board, made by this build. */
async function board(): Promise<string> {
  const ws = join(base, `ws-${++n}`)
  mkdirSync(join(ws, 'p', '.combwork'), { recursive: true })
  writeFileSync(join(ws, 'p', '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Agent 1' }] }))
  const w = await open(ws)
  await inWorkspace(w, () => tasks.createTask({ title: 'Before', project: 'p' }, user))
  await close(w)
  return ws
}

/** The board as rc.1–rc.4 left it: in the group, without the steps that came after (card attachments on). */
function asRc(ws: string): number {
  const later = store.BOARD_MIGRATIONS.find((m) => m.name === 'card attachments')!
  const raw = new DatabaseSync(store.boardFile(ws))
  const revTriggers = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%rev_a%'").all() as { name: string }[]).map((r) => `DROP TRIGGER ${r.name};`).join(' ')
  raw.exec(`DROP TABLE card_attachments; DROP TABLE card_comments_archive; ${revTriggers} DROP INDEX cards_rev; DROP TABLE board_rev; ALTER TABLE cards DROP COLUMN rev; DELETE FROM schema_version WHERE version >= ${later.version}`)
  raw.close()
  return later.version - 1
}

describe("the board's 1.0 group (#1207)", () => {
  it('has the 1.0 group, after every 0.9 step', () => {
    expect(upgradeSteps.length).toBeGreaterThan(0)
    const last09 = Math.max(...store.BOARD_MIGRATIONS.filter((m) => !m.group).map((m) => m.version))
    expect(Math.min(...upgradeSteps.map((m) => m.version))).toBeGreaterThan(last09)
  })

  it("a board 1.0 made takes the group's later steps unasked: writable, its cards kept (HI-1718: rc.1–rc.4 boards at v22)", async () => {
    const ws = await board()
    const at = asRc(ws)
    expect(fileSchemaVersion(store.boardFile(ws))).toBe(at)
    const w = await open(ws)
    expect(inWorkspace(w, () => store.boardState(w)).readOnly).toBeNull()
    expect(fileSchemaVersion(store.boardFile(ws))).toBe(Math.max(...store.BOARD_MIGRATIONS.map((m) => m.version)))
    expect(tables(store.boardFile(ws))).toContain('card_attachments')
    await inWorkspace(w, () => tasks.createTask({ title: 'After', project: 'p' }, user))
    expect(await titles(w)).toEqual(['After', 'Before'])
    await close(w)
  })

  it("keeps a presence marker while open; another profile's fresh one refuses the later steps, a stale one doesn't", async () => {
    const ws = await board()
    asRc(ws)
    const dir = join(ws, '.combwork', PRESENCE_DIR)
    mkdirSync(dir, { recursive: true })
    const other = join(dir, 'Combwork-Dev-12345678.json')
    // Running (this process's pid) and recent: another Combwork.
    writeFileSync(other, JSON.stringify({ pid: process.pid, profile: 'Combwork-Dev', appVersion: '1.0.0', startedAt: new Date().toISOString(), heartbeat: new Date().toISOString() }))
    const at = fileSchemaVersion(store.boardFile(ws))
    await expect((async () => {
      const w = await open(ws)
      try {
        await titles(w)
      } finally {
        await close(w)
      }
    })()).rejects.toThrow(/another Combwork has the workspace open/)
    expect(fileSchemaVersion(store.boardFile(ws))).toBe(at)
    // Its heartbeat missed: a Combwork that stopped without removing it.
    writeFileSync(other, JSON.stringify({ pid: process.pid, profile: 'Combwork-Dev', appVersion: '1.0.0', startedAt: new Date().toISOString(), heartbeat: new Date(Date.now() - STALE_MS - 1000).toISOString() }))
    const w = await open(ws)
    expect(await titles(w)).toEqual(['Before'])
    expect(readdirSync(dir)).toHaveLength(2)
    await close(w)
    // Removed as the workspace closed; the other's left alone.
    expect(readdirSync(dir)).toEqual(['Combwork-Dev-12345678.json'])
  })
})
