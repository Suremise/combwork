// The 1.0 upgrade's run (#1207, SPEC §16.17): a group of schema steps run as one (asked first, the file locked to one
// connection, a copy kept for good, one transaction), and the board's side of it: read-only until the user says yes,
// refused while another Hive has the workspace open (SQLite's lock, or a fresh presence marker), and Restore the 0.9
// Board Backup putting the copy back.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { tempDir } from './tempDir'

const base = tempDir('hive-board-upgrade-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const { BACKUPS_KEPT, DbInUseError, openDb, schemaVersion } = await import('../src/main/db')
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
  store.boardTestHooks.upgradeAnswer = null
  store.boardTestHooks.whileUpgrading = null
})

const fileIn = (): { file: string; backups: string } => {
  const dir = join(base, `db-${++n}`)
  return { file: join(dir, 'x.db'), backups: join(dir, 'backups') }
}
const tables = (file: string): string[] => {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name)
  } finally {
    db.close()
  }
}
const plain: Step[] = [
  { version: 1, name: 'one', up: (d) => d.exec('CREATE TABLE a (x); INSERT INTO a VALUES (1)') },
  { version: 2, name: 'two', up: (d) => d.exec('CREATE TABLE b (y)') }
]
const group = (third: (d: DatabaseSync) => void = (d) => d.exec('CREATE TABLE d (w)')): Step[] => [
  { version: 3, name: 'three', group: '1.0', up: (d) => d.exec('CREATE TABLE c (z)') },
  { version: 4, name: 'four', group: '1.0', up: third }
]
/** A file at v2 with data, as 0.9 left it. */
function at09(): { file: string; backups: string } {
  const f = fileIn()
  openDb(f.file, { migrations: plain, hiveVersion: '0.9.3' }).close()
  return f
}

describe('a group of steps (db.ts)', () => {
  it('runs every pending step of the group in one transaction: a throwing step leaves the file before the group', () => {
    const f = at09()
    expect(() => openDb(f.file, { migrations: [...plain, ...group(() => { throw new Error('step four broke') })], hiveVersion: '1.0.0', backupDir: f.backups, approve: () => true })).toThrow('step four broke')
    // Neither of the group's steps: not c, not a recorded version 3.
    expect(tables(f.file)).toEqual(['a', 'b', 'schema_version'])
    const raw = new DatabaseSync(f.file)
    expect(schemaVersion(raw)).toBe(2)
    raw.close()
    // And the lock went back: the file opens again, and the group runs once it works.
    const db = openDb(f.file, { migrations: [...plain, ...group()], hiveVersion: '1.0.0', backupDir: f.backups, approve: () => true })
    try {
      expect(schemaVersion(db.writer)).toBe(4)
      expect(db.pending).toBeNull()
      expect((db.writer.prepare('PRAGMA locking_mode').get() as { locking_mode: string }).locking_mode).toBe('normal')
    } finally {
      db.close()
    }
  })

  it('asks once for the whole group; refused, the steps before it run and the file opens read-only, waiting', () => {
    const f = fileIn()
    openDb(f.file, { migrations: plain.slice(0, 1), hiveVersion: '0.9.0' }).close()
    const asked: unknown[] = []
    const db = openDb(f.file, { migrations: [...plain, ...group()], hiveVersion: '1.0.0', backupDir: f.backups, approve: (p) => (asked.push(p), false) })
    try {
      expect(asked).toEqual([{ group: '1.0', from: 2, to: 4 }])
      expect(db.pending).toEqual({ group: '1.0', from: 2, to: 4 })
      expect(schemaVersion(db.writer)).toBe(2)
      expect(() => db.writer.exec('INSERT INTO a VALUES (2)')).toThrow()
      expect(db.reader.prepare('SELECT count(*) AS n FROM a').get()).toEqual({ n: 1 })
    } finally {
      db.close()
    }
    // Only the plain step's copy: no group copy for a group that didn't run.
    expect(readdirSync(f.backups).filter((x) => x.includes('before-1.0'))).toEqual([])
  })

  it('a new file takes every step, the group too, unasked', () => {
    const f = fileIn()
    const db = openDb(f.file, { migrations: [...plain, ...group()], hiveVersion: '1.0.0', backupDir: f.backups, approve: () => { throw new Error('asked') } })
    try {
      expect(schemaVersion(db.writer)).toBe(4)
    } finally {
      db.close()
    }
    expect(existsSync(f.backups)).toBe(false)
  })

  it('keeps its copy of the file before the group for good: later copies never prune it', () => {
    const f = at09()
    openDb(f.file, { migrations: [...plain, ...group()], hiveVersion: '1.0.0', backupDir: f.backups, approve: () => true }).close()
    const kept = readdirSync(f.backups).filter((x) => x.startsWith('x-before-1.0-v2-'))
    expect(kept).toHaveLength(1)
    // It is the file at v2, whole.
    expect(tables(join(f.backups, kept[0]))).toEqual(['a', 'b', 'schema_version'])
    // More steps than the folder keeps copies of, each after a copy of its own.
    let steps: Step[] = [...plain, ...group()]
    for (let v = 5; v < 5 + BACKUPS_KEPT + 2; v++) {
      steps = [...steps, { version: v, name: `v${v}`, up: (d) => d.exec(`CREATE TABLE t${v} (q)`) }]
      openDb(f.file, { migrations: steps, hiveVersion: '1.0.0', backupDir: f.backups }).close()
    }
    const after = readdirSync(f.backups)
    expect(after.filter((x) => x.startsWith('x-v'))).toHaveLength(BACKUPS_KEPT)
    expect(after.filter((x) => x.startsWith('x-before-1.0-'))).toEqual(kept)
  })

  it('is refused while another connection has the file open, changing nothing; runs once it has closed', () => {
    const f = at09()
    const other = new DatabaseSync(f.file)
    other.prepare('SELECT count(*) FROM a').get()
    try {
      expect(() => openDb(f.file, { migrations: [...plain, ...group()], hiveVersion: '1.0.0', backupDir: f.backups, approve: () => true })).toThrow(DbInUseError)
      expect(schemaVersion(other)).toBe(2)
      expect(existsSync(f.backups)).toBe(false)
      // The other connection still writes: nothing was left locked.
      other.exec('INSERT INTO a VALUES (2)')
    } finally {
      other.close()
    }
    const db = openDb(f.file, { migrations: [...plain, ...group()], hiveVersion: '1.0.0', backupDir: f.backups, approve: () => true })
    try {
      expect(schemaVersion(db.writer)).toBe(4)
      expect(db.reader.prepare('SELECT count(*) AS n FROM a').get()).toEqual({ n: 2 })
    } finally {
      db.close()
    }
  })

  it('holds the file for the whole run: another connection opening it meanwhile is refused', () => {
    const f = at09()
    let during: string | null = null
    const db = openDb(f.file, {
      migrations: [...plain, ...group()],
      hiveVersion: '1.0.0',
      backupDir: f.backups,
      approve: () => true,
      whileGroupLocked: () => {
        const other = new DatabaseSync(f.file, { timeout: 100 })
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

  it("a refusal before the copy (another Hive's marker) changes nothing and lets go of the file", () => {
    const f = at09()
    expect(() => openDb(f.file, { migrations: [...plain, ...group()], hiveVersion: '1.0.0', backupDir: f.backups, approve: () => true, beforeGroup: () => { throw new Error('another Hive') } })).toThrow('another Hive')
    expect(existsSync(f.backups)).toBe(false)
    const other = new DatabaseSync(f.file, { timeout: 100 })
    try {
      expect(schemaVersion(other)).toBe(2)
      other.exec('INSERT INTO a VALUES (3)')
    } finally {
      other.close()
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
const hiveOf = (ws: string): string => join(ws, '.hive')
const upgradeSteps = store.BOARD_MIGRATIONS.filter((m) => m.group === '1.0')

/** A workspace whose board 0.9 left (its file before the 1.0 group), with card #1 on it. */
async function board09(): Promise<string> {
  const ws = join(base, `ws-${++n}`)
  mkdirSync(join(ws, 'p', '.hive'), { recursive: true })
  writeFileSync(join(ws, 'p', '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Agent 1' }] }))
  const w = await open(ws)
  await inWorkspace(w, () => tasks.createTask({ title: 'From 0.9', project: 'p' }, user))
  await close(w)
  // As 0.9 left it: none of the 1.0 group's steps.
  const raw = new DatabaseSync(store.boardFile(ws))
  raw.prepare(`DELETE FROM schema_version WHERE version >= ?`).run(Math.min(...upgradeSteps.map((m) => m.version)))
  raw.exec("DELETE FROM board_meta WHERE key = 'format'")
  raw.close()
  return ws
}
const titles = async (w: WS): Promise<string[]> => (await inWorkspace(w, () => tasks.allTasks(w))).map((c) => c.title).sort()

describe("the board's upgrade to 1.0 (#1207)", () => {
  it('has the 1.0 group, after every 0.9 step', () => {
    expect(upgradeSteps.length).toBeGreaterThan(0)
    const last09 = Math.max(...store.BOARD_MIGRATIONS.filter((m) => !m.group).map((m) => m.version))
    expect(Math.min(...upgradeSteps.map((m) => m.version))).toBeGreaterThan(last09)
  })

  it('opens a 0.9 board read-only until the user says yes; then upgraded, its cards kept and the 0.9 copy kept', async () => {
    const ws = await board09()
    const w = await open(ws)
    expect(inWorkspace(w, () => store.boardState(w))).toEqual({ readOnly: 'upgrade', backup09: null })
    expect(await titles(w)).toEqual(['From 0.9'])
    await expect(inWorkspace(w, () => tasks.createTask({ title: 'Too soon', project: 'p' }, user))).rejects.toThrow(/read-only until it is upgraded/)
    const { backup } = await inWorkspace(w, () => store.upgradeBoard(w))
    expect(backup).toMatch(/hive-before-1\.0-v2-.*\.db$/)
    expect(tables(backup!)).toContain('cards')
    const state = inWorkspace(w, () => store.boardState(w))
    expect(state.readOnly).toBeNull()
    expect(Date.parse(state.backup09!.at)).toBeGreaterThan(0)
    await inWorkspace(w, () => tasks.createTask({ title: 'After', project: 'p' }, user))
    expect(await titles(w)).toEqual(['After', 'From 0.9'])
    // Upgrading again does nothing.
    expect(await inWorkspace(w, () => store.upgradeBoard(w))).toEqual({ backup: null })
    await close(w)
  })

  it('is refused while another Hive has the file open, the board still read-only; goes ahead once it has closed', async () => {
    const ws = await board09()
    const w = await open(ws)
    // A 0.9 Hive: a connection to the file, as every open workspace holds one.
    const other = new DatabaseSync(store.boardFile(ws))
    other.prepare('SELECT count(*) FROM cards').get()
    try {
      await expect(inWorkspace(w, () => store.upgradeBoard(w))).rejects.toThrow('Another Hive has this workspace open: close it first.')
      expect(inWorkspace(w, () => store.boardState(w)).readOnly).toBe('upgrade')
      expect(await titles(w)).toEqual(['From 0.9'])
      expect(existsSync(join(hiveOf(ws), 'backups')) ? readdirSync(join(hiveOf(ws), 'backups')).filter((x) => x.includes('before-1.0')) : []).toEqual([])
    } finally {
      other.close()
    }
    await inWorkspace(w, () => store.upgradeBoard(w))
    expect(inWorkspace(w, () => store.boardState(w)).readOnly).toBeNull()
    await close(w)
  })

  it("keeps a presence marker while open; another profile's fresh one refuses the upgrade, a stale one doesn't", async () => {
    const ws = await board09()
    const w = await open(ws)
    const dir = join(hiveOf(ws), PRESENCE_DIR)
    inWorkspace(w, () => store.boardState(w))
    const own = readdirSync(dir)
    expect(own).toHaveLength(1)
    const other = join(dir, 'Hive-Dev-12345678.json')
    // Running (this process's pid) and recent: another Hive.
    writeFileSync(other, JSON.stringify({ pid: process.pid, profile: 'Hive-Dev', hiveVersion: '1.0.0', startedAt: new Date().toISOString(), heartbeat: new Date().toISOString() }))
    await expect(inWorkspace(w, () => store.upgradeBoard(w))).rejects.toThrow('close it first')
    expect(inWorkspace(w, () => store.boardState(w)).readOnly).toBe('upgrade')
    // Its heartbeat missed: a Hive that stopped without removing it.
    writeFileSync(other, JSON.stringify({ pid: process.pid, profile: 'Hive-Dev', hiveVersion: '1.0.0', startedAt: new Date().toISOString(), heartbeat: new Date(Date.now() - STALE_MS - 1000).toISOString() }))
    await inWorkspace(w, () => store.upgradeBoard(w))
    expect(inWorkspace(w, () => store.boardState(w)).readOnly).toBeNull()
    await close(w)
    // Removed as the workspace closed; the other's left alone.
    expect(readdirSync(dir)).toEqual(['Hive-Dev-12345678.json'])
  })

  it('a test copy can answer before it is asked', async () => {
    const ws = await board09()
    store.boardTestHooks.upgradeAnswer = 'yes'
    const w = await open(ws)
    expect(inWorkspace(w, () => store.boardState(w)).readOnly).toBeNull()
    expect(await titles(w)).toEqual(['From 0.9'])
    await close(w)
  })

  it('Restore the 0.9 Board Backup puts the copy back after keeping the 1.0 board; upgrading again works', async () => {
    const ws = await board09()
    const w = await open(ws)
    await expect(inWorkspace(w, () => store.restoreBoardBackup(w))).rejects.toThrow('There is no 0.9 board backup')
    await inWorkspace(w, () => store.upgradeBoard(w))
    await inWorkspace(w, () => tasks.createTask({ title: 'Made in 1.0', project: 'p' }, user))
    const { saved, restored } = await inWorkspace(w, () => store.restoreBoardBackup(w))
    // Back to what 0.9 had, read-only here until upgraded again.
    expect(inWorkspace(w, () => store.boardState(w)).readOnly).toBe('upgrade')
    expect(await titles(w)).toEqual(['From 0.9'])
    // Nothing deleted: the 1.0 board and the 0.9 copy both kept.
    expect(existsSync(restored)).toBe(true)
    const copy = new DatabaseSync(saved, { readOnly: true })
    expect((copy.prepare('SELECT count(*) AS n FROM cards').get() as { n: number }).n).toBe(2)
    copy.close()
    const raw = new DatabaseSync(store.boardFile(ws), { readOnly: true })
    expect(schemaVersion(raw)).toBe(2)
    raw.close()
    await inWorkspace(w, () => store.upgradeBoard(w))
    expect(await titles(w)).toEqual(['From 0.9'])
    await close(w)
  })

  it('Restore is refused while another Hive has the file open, the 1.0 board left as it was', async () => {
    const ws = await board09()
    store.boardTestHooks.upgradeAnswer = 'yes'
    const w = await open(ws)
    await inWorkspace(w, () => tasks.createTask({ title: 'Made in 1.0', project: 'p' }, user))
    const other = new DatabaseSync(store.boardFile(ws))
    other.prepare('SELECT count(*) FROM cards').get()
    try {
      await expect(inWorkspace(w, () => store.restoreBoardBackup(w))).rejects.toThrow('close it first')
    } finally {
      other.close()
    }
    expect(inWorkspace(w, () => store.boardState(w)).readOnly).toBeNull()
    expect(await titles(w)).toEqual(['From 0.9', 'Made in 1.0'])
    await close(w)
  })
})
