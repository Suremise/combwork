// The 1.0 upgrade's run (#1207, SPEC §16.17): a group of schema steps run as one (asked first, the file locked to one
// connection, a copy kept for good, one transaction), and the board's side of it: read-only until the user says yes,
// refused while another Hive has the workspace open (SQLite's lock, or a fresh presence marker), and Restore the 0.9
// Board Backup putting the copy back.
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { tempDir } from './tempDir'
import { junction } from './pathAliases'
import { as09 } from './boardDb'

// The checkpoints' worker letting go of a file (HI-1691), held by a test: `gate` set, checkpointsReleased waits for it,
// telling `reached` as it starts to.
const held = vi.hoisted(() => ({ gate: null as Promise<void> | null, reached: null as (() => void) | null }))
vi.mock('../src/main/walCheckpoint', async (original) => {
  const real = await original<typeof import('../src/main/walCheckpoint')>()
  return {
    ...real,
    checkpointsReleased: (file: string) => {
      held.reached?.()
      return held.gate ?? real.checkpointsReleased(file)
    }
  }
})

const base = tempDir('hive-board-upgrade-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace, workspace } = await import('../src/main/workspace')
const { sessions } = await import('../src/main/sessions')
const storeRows = await import('../src/main/storeRows')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const { keyProjects } = await import('../src/main/projectKeys')
const { changeGroups } = await import('../src/main/assistantChanges')
const { BACKUPS_KEPT, DbInUseError, fileSchemaVersion, openDb, schemaVersion } = await import('../src/main/db')
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
  held.gate = null
  held.reached = null
})

/** Holds checkpointsReleased (HI-1691): resolves once the code under test waits there; `release` lets it go on. */
function holdRelease(): { waiting: Promise<void>; release: () => void } {
  let release = (): void => undefined
  held.gate = new Promise<void>((r) => (release = r))
  const waiting = new Promise<void>((r) => (held.reached = r))
  return { waiting, release }
}

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

  it("a later step of the group on a file in it already: an ordinary copy, never another 'before the group' one (#1207 round 1)", () => {
    const f = at09()
    openDb(f.file, { migrations: [...plain, ...group()], hiveVersion: '1.0.0', backupDir: f.backups, approve: () => true }).close()
    const five: Step = { version: 5, name: 'five', group: '1.0', up: (d) => d.exec('CREATE TABLE e (v)') }
    const asked: unknown[] = []
    const db = openDb(f.file, { migrations: [...plain, ...group(), five], hiveVersion: '1.0.1', backupDir: f.backups, approve: (p) => (asked.push(p), true) })
    try {
      // Not asked again (HI-1718): it was when the file joined the group.
      expect(asked).toEqual([])
      expect(schemaVersion(db.writer)).toBe(5)
    } finally {
      db.close()
    }
    const after = readdirSync(f.backups)
    expect(after.filter((x) => x.startsWith('x-before-1.0-'))).toEqual([expect.stringMatching(/^x-before-1\.0-v2-/)])
    expect(after.filter((x) => x.startsWith('x-v4-'))).toHaveLength(1)
  })

  it('a later step of the group on a file in it already runs even where the group would be refused: the file opens writable, waiting for nothing (HI-1718)', () => {
    const f = at09()
    openDb(f.file, { migrations: [...plain, ...group()], hiveVersion: '1.0.0', backupDir: f.backups, approve: () => true }).close()
    const five: Step = { version: 5, name: 'five', group: '1.0', up: (d) => d.exec('CREATE TABLE e (v)') }
    const db = openDb(f.file, { migrations: [...plain, ...group(), five], hiveVersion: '1.0.1', backupDir: f.backups, approve: () => false })
    try {
      expect(db.pending).toBeNull()
      expect(schemaVersion(db.writer)).toBe(5)
      db.writer.exec('INSERT INTO e VALUES (1)')
    } finally {
      db.close()
    }
    // A file before the group is still asked, and refused waits.
    const g = at09()
    const before = openDb(g.file, { migrations: [...plain, ...group(), five], hiveVersion: '1.0.1', backupDir: g.backups, approve: () => false })
    try {
      expect(before.pending).toEqual({ group: '1.0', from: 2, to: 5 })
    } finally {
      before.close()
    }
  })

  it('a file made in 1.0 (every step unasked) gets no copy kept for good when a later step of the group comes', () => {
    const f = fileIn()
    openDb(f.file, { migrations: [...plain, ...group()], hiveVersion: '1.0.0', backupDir: f.backups }).close()
    const raw = new DatabaseSync(f.file)
    raw.exec('INSERT INTO a VALUES (2)')
    raw.close()
    const five: Step = { version: 5, name: 'five', group: '1.0', up: (d) => d.exec('CREATE TABLE e (v)') }
    openDb(f.file, { migrations: [...plain, ...group(), five], hiveVersion: '1.0.1', backupDir: f.backups, approve: () => true }).close()
    expect(readdirSync(f.backups).filter((x) => x.includes('before-1.0'))).toEqual([])
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
  // As 0.9 left it: its cards as documents, none of the 1.0 group's steps.
  as09(store.boardFile(ws))
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

  it('a board an earlier 1.0 upgraded takes the group\'s later steps unasked: writable, its cards kept (HI-1718: rc.1–rc.4 boards at v22)', async () => {
    const ws = await board09()
    store.boardTestHooks.upgradeAnswer = 'yes'
    const first = await open(ws)
    expect(await titles(first)).toEqual(['From 0.9'])
    await close(first)
    store.boardTestHooks.upgradeAnswer = null
    // As rc.1–rc.4 left it: upgraded, without the steps that came after (card attachments, HI-1700; card revisions, HI-1715).
    const last = Math.max(...upgradeSteps.map((m) => m.version))
    const later = store.BOARD_MIGRATIONS.find((m) => m.name === 'card attachments')!
    const raw = new DatabaseSync(store.boardFile(ws))
    const revTriggers = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%rev_a%'").all() as { name: string }[]).map((r) => `DROP TRIGGER ${r.name};`).join(' ')
    raw.exec(`DROP TABLE card_attachments; ${revTriggers} DROP INDEX cards_rev; DROP TABLE board_rev; ALTER TABLE cards DROP COLUMN rev; DELETE FROM schema_version WHERE version >= ${later.version}`)
    raw.close()
    expect(fileSchemaVersion(store.boardFile(ws))).toBe(later.version - 1)
    // No answer given: had it been asked, the board would wait read-only for the user.
    const w = await open(ws)
    expect(inWorkspace(w, () => store.boardState(w)).readOnly).toBeNull()
    expect(fileSchemaVersion(store.boardFile(ws))).toBe(last)
    expect(tables(store.boardFile(ws))).toContain('card_attachments')
    expect(tables(store.boardFile(ws))).toContain('board_rev')
    await inWorkspace(w, () => tasks.createTask({ title: 'After', project: 'p' }, user))
    expect(await titles(w)).toEqual(['After', 'From 0.9'])
    await close(w)
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
    await expect(inWorkspace(w, () => store.restoreBoardBackup(w, () => 0))).rejects.toThrow('There is no 0.9 board backup')
    await inWorkspace(w, () => store.upgradeBoard(w))
    await inWorkspace(w, () => tasks.createTask({ title: 'Made in 1.0', project: 'p' }, user))
    const { saved, restored } = await inWorkspace(w, () => store.restoreBoardBackup(w, () => 0))
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

  it("the workspace closing while Restore or the upgrade waits for the checkpoints' worker: refused, the file and its copies as they were (HI-1691, HR6's round 3)", async () => {
    // Restore: the 1.0 board, upgraded from 0.9, kept as it is.
    const ws = await board09()
    const w = await open(ws)
    await inWorkspace(w, () => store.upgradeBoard(w))
    const backups = join(hiveOf(ws), 'backups')
    const copies = readdirSync(backups).sort()
    const version = fileSchemaVersion(store.boardFile(ws))
    let hold = holdRelease()
    const restoring = inWorkspace(w, () => store.restoreBoardBackup(w, () => 0))
    restoring.catch(() => undefined)
    await hold.waiting
    await close(w)
    hold.release()
    await expect(restoring).rejects.toThrow()
    expect(fileSchemaVersion(store.boardFile(ws))).toBe(version)
    expect(readdirSync(backups).sort()).toEqual(copies)
    // The upgrade: a 0.9 board, left waiting for it.
    const ws2 = await board09()
    const w2 = await open(ws2)
    hold = holdRelease()
    const upgrading = inWorkspace(w2, () => store.upgradeBoard(w2))
    upgrading.catch(() => undefined)
    await hold.waiting
    await close(w2)
    hold.release()
    await expect(upgrading).rejects.toThrow()
    expect(fileSchemaVersion(store.boardFile(ws2))).toBe(2)
  })

  it('Restore is refused while another Hive has the file open, the 1.0 board left as it was', async () => {
    const ws = await board09()
    store.boardTestHooks.upgradeAnswer = 'yes'
    const w = await open(ws)
    await inWorkspace(w, () => tasks.createTask({ title: 'Made in 1.0', project: 'p' }, user))
    const other = new DatabaseSync(store.boardFile(ws))
    other.prepare('SELECT count(*) FROM cards').get()
    try {
      await expect(inWorkspace(w, () => store.restoreBoardBackup(w, () => 0))).rejects.toThrow('close it first')
    } finally {
      other.close()
    }
    expect(inWorkspace(w, () => store.boardState(w)).readOnly).toBeNull()
    expect(await titles(w)).toEqual(['From 0.9', 'Made in 1.0'])
    await close(w)
  })
})

describe('while the upgrade waits, nothing needing hive.db starts or writes (#1207 round 1)', () => {
  it('an agent is refused before anything starts, saying why; it starts once upgraded', async () => {
    const ws = await board09()
    const w = await open(ws)
    expect(inWorkspace(w, () => store.upgradeWaiting(ws))).toBe(true)
    await expect(inWorkspace(w, () => sessions.start(join(ws, 'p'), { agentId: 'a1' }))).rejects.toThrow('This workspace is from Hive 0.9: upgrade it to 1.0 before starting agents')
    expect(sessions.agentsIn(ws)).toBe(0)
    // The Assistant's home is in the workspace: refused the same way.
    await expect(inWorkspace(w, () => sessions.start(join(ws, '.hive', 'assistant'), { agentId: 'assistant' }))).rejects.toThrow('upgrade it to 1.0 before starting agents')
    await inWorkspace(w, () => store.upgradeBoard(w))
    expect(store.upgradeWaiting(ws)).toBe(false)
    expect(() => store.assertUpgraded(ws)).not.toThrow()
    await close(w)
  })

  it("the Assistant's changes, which the window lists as it opens, read as none while it waits (no \"no such table\"); kept once upgraded (HI-1820)", async () => {
    const ws = await board09()
    const w = await open(ws)
    expect(store.boardReadOnly(w)).toBe(true)
    expect(inWorkspace(w, () => changeGroups(w))).toEqual([])
    await inWorkspace(w, () => store.upgradeBoard(w))
    expect(store.boardReadOnly(w)).toBe(false)
    expect(inWorkspace(w, () => changeGroups(w))).toEqual([])
    await close(w)
  })

  it("lanes' card owners, which the Lanes view reads as it opens, read as none while it waits (no \"no such table: lane_pending\"); read once upgraded (HI-1846)", async () => {
    const ws = await board09()
    const w = await open(ws)
    expect(store.boardReadOnly(w)).toBe(true)
    const numbers = (inWorkspace(w, () => store.boardRead(w, (db) => db.prepare('SELECT number FROM cards').all())) as { number: number }[]).map((r) => r.number)
    expect(numbers.length).toBeGreaterThan(0)
    const owners = inWorkspace(w, () => store.cardOwnersNow(w, numbers))
    expect([...owners.values()].every((o) => o.lane === null)).toBe(true)
    expect(owners.size).toBe(numbers.length)
    await inWorkspace(w, () => store.upgradeBoard(w))
    expect(store.boardReadOnly(w)).toBe(false)
    expect(inWorkspace(w, () => store.cardOwnersNow(w, numbers)).size).toBe(numbers.length)
    await close(w)
  })

  it("a store's file isn't moved in meanwhile (no write): read from the database, left in place, moved in once upgraded", async () => {
    const ws = await board09()
    const p = join(ws, 'p')
    const old = { version: 1, sessions: [{ id: 's1', agent: 'claude-code', name: 'From 0.9', createdAt: '2026-10-19T10:00:00.000Z', lastActiveAt: '2026-10-19T10:00:00.000Z', archived: false }] }
    writeFileSync(join(p, '.hive', 'sessions.json'), JSON.stringify(old))
    const w = await open(ws)
    const read = await inWorkspace(w, () => workspace.sessionsFile(p))
    expect(read.sessions).toEqual([])
    expect(existsSync(join(p, '.hive', 'sessions.json'))).toBe(true)
    // A store's open the same way: nothing moved, nothing marked.
    const probe = join(ws, '.hive', 'never-a-store.json')
    writeFileSync(probe, '[]')
    let put = 0
    await storeRows.openTable(ws, 'sessions', 'probe', probe, async () => ({ rows: 1 }), { count: () => 0, put: () => ++put })
    expect(put).toBe(0)
    expect(existsSync(probe)).toBe(true)
    await inWorkspace(w, () => store.upgradeBoard(w))
    expect((await inWorkspace(w, () => workspace.sessionsFile(p))).sessions.map((x) => x.id)).toEqual(['s1'])
    expect(existsSync(join(p, '.hive', 'sessions.json'))).toBe(false)
    await close(w)
  })

  it("the opening's steps that write skip the waiting board quietly; the upgrade tells its listeners once, so they run then (#1621)", async () => {
    const ws = await board09()
    const w = await open(ws)
    const told: string[] = []
    const off = store.onBoardUpgraded((x) => told.push(x.path!))
    try {
      // Nothing written, nothing thrown ("This board is from Hive 0.9…" was logged for each).
      expect(await inWorkspace(w, () => tasks.stampCardProjects(w))).toBe(0)
      expect(await inWorkspace(w, () => keyProjects(w))).toEqual([])
      expect(await inWorkspace(w, () => tasks.archiveOldDone(w))).toEqual([])
      expect(await inWorkspace(w, () => tasks.endReviewsWithoutSession(w, () => false))).toEqual([])
      // Refused (another Hive has the file open): not upgraded, nobody told.
      const other = new DatabaseSync(store.boardFile(ws))
      other.prepare('SELECT count(*) FROM cards').get()
      await expect(inWorkspace(w, () => store.upgradeBoard(w))).rejects.toThrow('close it first')
      other.close()
      expect(told).toEqual([])
      await inWorkspace(w, () => store.upgradeBoard(w))
      expect(told).toEqual([ws])
      // Upgrading again changes nothing, and tells nobody again.
      await inWorkspace(w, () => store.upgradeBoard(w))
      expect(told).toEqual([ws])
      // The board takes writes now: the same steps run through it (the upgrade gave the project its key already).
      expect(await inWorkspace(w, () => tasks.stampCardProjects(w))).toBe(0)
      expect(await inWorkspace(w, () => keyProjects(w))).toEqual([])
      expect(store.projectKeys(w).filter((k) => k.current)).toHaveLength(1)
      expect(await inWorkspace(w, () => tasks.endReviewsWithoutSession(w, () => false))).toEqual([])
    } finally {
      off()
    }
    await close(w)
  })

  it('background work waits while the board waits for its upgrade: no "no such table" or "readonly" errors; it runs once upgraded (HI-1694)', async () => {
    const { updateLines } = await import('../src/main/workflow/lineUpdates')
    const { repairStages } = await import('../src/main/workflow/stageRepair')
    const metrics = await import('../src/main/metrics')
    const { readTable } = await import('../src/main/storeTables')
    const ws = await board09()
    const w = await open(ws)
    // What Hive logs meanwhile (to the console in an unpackaged build, as the tests are).
    const lines: string[] = []
    const keep = (...a: unknown[]): void => void lines.push(a.map(String).join(' '))
    const spies = [vi.spyOn(console, 'log').mockImplementation(keep), vi.spyOn(console, 'error').mockImplementation(keep)]
    try {
      expect(store.boardWaits(w)).toBe(true)
      // The line updater (a pass came with every agent's change in another window) and a metrics save, on the 0.9 board.
      await inWorkspace(w, () => updateLines(w))
      // The stage repair (HI-1674), which warned "This board is from Hive 0.9" at each open (HI-1714): it leaves the board alone.
      expect(await inWorkspace(w, () => repairStages(w))).toEqual({ unmarked: 0, repaired: [], failed: 0 })
      metrics.recordApi(metrics.metricsHandle(w), null, { route: '/v1/tasks', method: 'GET', role: 'agent', outcome: 'ok', requestBytes: 1, responseBytes: 1, ms: 1 })
      await metrics.metricsHandle(w)!.store.save()
      expect(lines.filter((l) => /no such table|readonly database|Could not save the performance metrics|bringing builders|from Hive 0\.9|repairing the stages/i.test(l))).toEqual([])
      expect(readTable(ws, 'metrics').docs).toEqual([])
      await inWorkspace(w, () => store.upgradeBoard(w))
      expect(store.boardWaits(w)).toBe(false)
      // Upgraded: they run, and metrics observed since are saved.
      await inWorkspace(w, () => updateLines(w))
      await inWorkspace(w, () => repairStages(w))
      metrics.recordApi(metrics.metricsHandle(w), null, { route: '/v1/tasks', method: 'GET', role: 'agent', outcome: 'ok', requestBytes: 1, responseBytes: 1, ms: 1 })
      await metrics.metricsHandle(w)!.store.save()
      expect(lines.filter((l) => /\[(WARN|ERROR)\]/.test(l))).toEqual([])
      expect(readTable(ws, 'metrics').docs.length).toBeGreaterThan(0)
    } finally {
      for (const s of spies) s.mockRestore()
    }
    await close(w)
  })

  it('Restore is refused while agents of the workspace run or start, nothing changed', async () => {
    const ws = await board09()
    store.boardTestHooks.upgradeAnswer = 'yes'
    const w = await open(ws)
    await expect(inWorkspace(w, () => store.restoreBoardBackup(w, () => 1))).rejects.toThrow("Stop this workspace's agents and its Assistant first")
    expect(inWorkspace(w, () => store.boardState(w)).readOnly).toBeNull()
    expect(fileSchemaVersion(store.boardFile(ws))).toBeGreaterThan(2)
    await close(w)
  })

  it("Restore puts back the 0.9 board's copy, never a later 1.0 copy of the group's family (#1207 round 1)", async () => {
    const ws = await board09()
    const w = await open(ws)
    await inWorkspace(w, () => store.upgradeBoard(w))
    const dir = join(hiveOf(ws), 'backups')
    const [v2] = readdirSync(dir).filter((x) => x.startsWith('hive-before-1.0-v2-'))
    // A later copy of the family, of a 1.0 board (as round 1 made one before a later step of the group), named newer.
    const raw = new DatabaseSync(store.boardFile(ws))
    raw.prepare('VACUUM INTO ?').run(join(dir, 'hive-before-1.0-v3-2099-01-01T00-00-00-000Z.db'))
    raw.close()
    const at = v2.replace(/^hive-before-1\.0-v2-(.*)\.db$/, '$1').replace(/T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z$/, 'T$1:$2:$3.$4Z')
    expect(inWorkspace(w, () => store.boardState(w)).backup09?.at).toBe(at)
    const { restored } = await inWorkspace(w, () => store.restoreBoardBackup(w, () => 0))
    expect(restored.endsWith(v2)).toBe(true)
    expect(fileSchemaVersion(store.boardFile(ws))).toBe(2)
    await close(w)
  })

  it("Restore refuses a copy named as 0.9's whose file isn't a 0.9 board", async () => {
    const ws = await board09()
    const w = await open(ws)
    await inWorkspace(w, () => store.upgradeBoard(w))
    const dir = join(hiveOf(ws), 'backups')
    const raw = new DatabaseSync(store.boardFile(ws))
    raw.prepare('VACUUM INTO ?').run(join(dir, 'hive-before-1.0-v2-2099-01-01T00-00-00-000Z.db'))
    raw.close()
    await expect(inWorkspace(w, () => store.restoreBoardBackup(w, () => 0))).rejects.toThrow('There is no 0.9 board backup')
    expect(fileSchemaVersion(store.boardFile(ws))).toBeGreaterThan(2)
    await close(w)
  })
})

describe("what services read before the database was replaced is read again (#1207 round 2)", () => {
  /** A delivery as a 0.9 Hive saves it, straight into the database (another process), with the host's next id. */
  function writtenBy09(ws: string, scope: string, id: string, next: number, body: string): void {
    const raw = new DatabaseSync(store.boardFile(ws), { timeout: 5000 })
    try {
      const rec = { id, seq: Number(id.slice(1)), agentId: 'a1', conversation: null, kind: 'task', from: { kind: 'hive', name: 'Hive' }, body, state: 'queued', created: new Date().toISOString(), expires: new Date(Date.now() + 86_400_000).toISOString() }
      raw.prepare('INSERT INTO store_rows (store, scope, key, ord, doc) VALUES (?, ?, ?, ?, ?) ON CONFLICT(store, scope, key) DO UPDATE SET doc = excluded.doc').run('deliveries', scope, id, 0, JSON.stringify(rec))
      raw.prepare('INSERT INTO store_meta (store, scope, key, value) VALUES (?, ?, ?, ?) ON CONFLICT(store, scope, key) DO UPDATE SET value = excluded.value').run('deliveries', scope, 'next', String(next))
      raw.prepare('INSERT INTO store_meta (store, scope, key, value) VALUES (?, ?, ?, ?) ON CONFLICT(store, scope, key) DO NOTHING').run('deliveries', scope, 'imported', JSON.stringify({ at: new Date().toISOString(), rows: 1, file: null }))
    } finally {
      raw.close()
    }
  }
  const bodies = (rs: { id: string; body: string }[]): string[] => rs.map((r) => `${r.id} ${r.body}`).sort()

  it("deliveries loaded while the upgrade waited, and 0.9's saved meanwhile: kept, with its next id, through the first 1.0 save and a restart", async () => {
    const delivery = await import('../src/main/deliveries')
    delivery.setReadsInboxForTests(() => true)
    const ws = await board09()
    const host = join(ws, 'p')
    const w = await open(ws)
    try {
      // Loaded (cached) while the upgrade waits.
      expect(await inWorkspace(w, () => delivery.deliveriesOf(host, 'a1'))).toEqual([])
      const { scope } = await inWorkspace(w, () => w.sessionScope(host))
      writtenBy09(ws, scope, 'm1', 2, 'Written by 0.9 while the upgrade waited')
      await inWorkspace(w, () => store.upgradeBoard(w))
      expect(bodies(await inWorkspace(w, () => delivery.deliveriesOf(host, 'a1')))).toEqual(['m1 Written by 0.9 while the upgrade waited'])
      const made = await inWorkspace(w, () => delivery.createDelivery(host, { agentId: 'a1', kind: 'task', from: { kind: 'hive', name: 'Hive' }, body: 'The first in 1.0' }))
      expect(made.id).toBe('m2')
      const saved = await inWorkspace(w, () => delivery.savedForTests(host))
      expect(bodies(saved.deliveries)).toEqual(['m1 Written by 0.9 while the upgrade waited', 'm2 The first in 1.0'])
      expect(saved.next).toBe(3)
      // A restart reads the same.
      await delivery.forgetDeliveriesForTests()
      expect(bodies(await inWorkspace(w, () => delivery.deliveriesOf(host, 'a1')))).toEqual(['m1 Written by 0.9 while the upgrade waited', 'm2 The first in 1.0'])
    } finally {
      await delivery.forgetDeliveriesForTests()
      delivery.setReadsInboxForTests(null)
      await close(w)
    }
  })

  it('deliveries loaded through a junction to the workspace are read again too: by the place recorded, not the spelling (#1395)', async () => {
    const delivery = await import('../src/main/deliveries')
    delivery.setReadsInboxForTests(() => true)
    const ws = await board09()
    const via = junction(ws, `${ws}-via`)
    const host = join(via, 'p')
    const w = await open(ws)
    try {
      // Loaded (cached) under the junction's spelling while the upgrade waits; the window has the real one.
      expect(await inWorkspace(w, () => delivery.deliveriesOf(host, 'a1'))).toEqual([])
      const { scope } = await inWorkspace(w, () => w.sessionScope(join(ws, 'p')))
      writtenBy09(ws, scope, 'm1', 2, 'Written by 0.9 while the upgrade waited')
      await inWorkspace(w, () => store.upgradeBoard(w))
      expect(bodies(await inWorkspace(w, () => delivery.deliveriesOf(host, 'a1')))).toEqual(['m1 Written by 0.9 while the upgrade waited'])
    } finally {
      await delivery.forgetDeliveriesForTests()
      delivery.setReadsInboxForTests(null)
      await close(w)
      unlinkSync(via)
    }
  })

  it("what services keep of the database under another spelling than the window's goes when it is replaced: by the place recorded (#1456)", async () => {
    const { committedFor, saveTable } = await import('../src/main/storeTables')
    const { sessionsOpenedFor } = await import('../src/main/sessionStore')
    const ws = await board09()
    const via = junction(ws, `${ws}-via`)
    const w = await open(via)
    try {
      await inWorkspace(w, () => store.upgradeBoard(w))
      // Kept under the real spelling (as deliveries save, from where a host really is); the window has the junction's.
      await inWorkspace(w, () => workspace.sessionsFile(join(ws, 'p')))
      await saveTable(ws, 'lanes', [])
      expect(sessionsOpenedFor()).toContain(ws.toLowerCase())
      expect(committedFor().map((p) => p.toLowerCase())).toContain(ws.toLowerCase())
      await inWorkspace(w, () => store.restoreBoardBackup(w, () => 0))
      expect(sessionsOpenedFor()).not.toContain(ws.toLowerCase())
      expect(committedFor().map((p) => p.toLowerCase())).not.toContain(ws.toLowerCase())
    } finally {
      await close(w)
      unlinkSync(via)
    }
  })

  it('Restore and a second upgrade: deliveries read again each time, from the board put back and then upgraded', async () => {
    const delivery = await import('../src/main/deliveries')
    delivery.setReadsInboxForTests(() => true)
    const ws = await board09()
    const host = join(ws, 'p')
    const w = await open(ws)
    try {
      const { scope } = await inWorkspace(w, () => w.sessionScope(host))
      writtenBy09(ws, scope, 'm1', 2, 'From 0.9')
      await inWorkspace(w, () => store.upgradeBoard(w))
      await inWorkspace(w, () => delivery.createDelivery(host, { agentId: 'a1', kind: 'task', from: { kind: 'hive', name: 'Hive' }, body: 'Only in 1.0' }))
      expect(bodies(await inWorkspace(w, () => delivery.deliveriesOf(host, 'a1')))).toEqual(['m1 From 0.9', 'm2 Only in 1.0'])
      // Back to the 0.9 board: what it has, not the 1.0 board's cache.
      await inWorkspace(w, () => store.restoreBoardBackup(w, () => 0))
      expect(bodies(await inWorkspace(w, () => delivery.deliveriesOf(host, 'a1')))).toEqual(['m1 From 0.9'])
      // 0.9 adds one, then it is upgraded again: that one is kept, and the next id follows it.
      writtenBy09(ws, scope, 'm2', 3, 'From 0.9 after the restore')
      await inWorkspace(w, () => store.upgradeBoard(w))
      const made = await inWorkspace(w, () => delivery.createDelivery(host, { agentId: 'a1', kind: 'task', from: { kind: 'hive', name: 'Hive' }, body: 'In 1.0 again' }))
      expect(made.id).toBe('m3')
      expect(bodies((await inWorkspace(w, () => delivery.savedForTests(host))).deliveries)).toEqual(['m1 From 0.9', 'm2 From 0.9 after the restore', 'm3 In 1.0 again'])
    } finally {
      await delivery.forgetDeliveriesForTests()
      delivery.setReadsInboxForTests(null)
      await close(w)
    }
  })

  it('each replacement moves the generation on, and a save read in an older one is refused', async () => {
    const ws = await board09()
    const w = await open(ws)
    try {
      const before = store.dbGeneration(ws)
      const told: string[] = []
      store.onDbReplaced((p) => told.push(p))
      await inWorkspace(w, () => store.upgradeBoard(w))
      expect(store.dbGeneration(ws)).toBe(before + 1)
      expect(told).toEqual([ws])
      // A save planned in the generation before: its guard refuses it, nothing written.
      const gen = before
      let wrote = false
      await expect(storeRows.saveTable(ws, 'sessions', 'probe', () => (wrote = true), { probe: '1' }, () => {
        if (gen !== store.dbGeneration(ws)) throw new Error('stale')
      })).rejects.toThrow('stale')
      expect(wrote).toBe(false)
      expect(storeRows.storeValue(store.workspaceDb(ws).reader, 'sessions', 'probe', 'probe')).toBeNull()
      await inWorkspace(w, () => store.restoreBoardBackup(w, () => 0))
      expect(store.dbGeneration(ws)).toBe(before + 2)
    } finally {
      await close(w)
    }
  })
})

describe('a workspace closed right after its database was replaced stays closed (#1207 round 3)', () => {
  const markers = (ws: string): string[] => (existsSync(join(hiveOf(ws), PRESENCE_DIR)) ? readdirSync(join(hiveOf(ws), PRESENCE_DIR)) : [])

  /**
   * Replaces the database and closes the workspace with setImmediate held (only it: Node's I/O runs as usual), so what
   * they leave queued runs when the test says, not while the close goes on; then runs it, with every deliveries read
   * held at a gate until then, as a slow disk would hold it; then waits for every load that started, however long its
   * reads take. What a replacement left queued for a closed workspace (round 3: a reload) has then run to its end.
   */
  async function replaceThenClose(w: WS, replace: () => Promise<unknown>): Promise<void> {
    const delivery = await import('../src/main/deliveries')
    const watches = await import('../src/main/watches')
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    delivery.setBeforeReadForTests(() => gate)
    vi.useFakeTimers({ toFake: ['setImmediate'] })
    try {
      await replace()
      await close(w)
      vi.runAllTimers()
    } finally {
      vi.useRealTimers()
      release()
    }
    try {
      await delivery.loadsForTests()
      await watches.loadsForTests()
      await delivery.settledForTests()
    } finally {
      delivery.setBeforeReadForTests(null)
    }
  }

  for (const how of ['upgrade', 'restore'] as const) {
    it(`after ${how === 'upgrade' ? 'the upgrade' : 'Restore'}, closing the workspace at once: its deliveries and watches aren't read again, its database not opened`, async () => {
      const delivery = await import('../src/main/deliveries')
      const watches = await import('../src/main/watches')
      delivery.setReadsInboxForTests(() => true)
      const ws = await board09()
      const host = join(ws, 'p')
      const w = await open(ws)
      try {
        if (how === 'restore') await inWorkspace(w, () => store.upgradeBoard(w))
        // Loaded, so the replacement has something to drop.
        await inWorkspace(w, () => delivery.deliveriesOf(host, 'a1'))
        await inWorkspace(w, () => watches.evaluateAgentWatches(w))
        await replaceThenClose(w, () => (how === 'upgrade' ? inWorkspace(w, () => store.upgradeBoard(w)) : inWorkspace(w, () => store.restoreBoardBackup(w, () => 0))))
        expect(store.boardOpen(ws)).toBe(false)
        expect(markers(ws)).toEqual([])
      } finally {
        await delivery.forgetDeliveriesForTests()
        delivery.setReadsInboxForTests(null)
        store.closeBoard(ws)
      }
    })
  }

  it('after the upgrade, a workspace still open reads its deliveries again on their next use', async () => {
    const delivery = await import('../src/main/deliveries')
    delivery.setReadsInboxForTests(() => true)
    const ws = await board09()
    const host = join(ws, 'p')
    const w = await open(ws)
    try {
      await inWorkspace(w, () => delivery.deliveriesOf(host, 'a1'))
      await inWorkspace(w, () => store.upgradeBoard(w))
      const made = await inWorkspace(w, () => delivery.createDelivery(host, { agentId: 'a1', kind: 'task', from: { kind: 'hive', name: 'Hive' }, body: 'After the upgrade' }))
      expect((await inWorkspace(w, () => delivery.savedForTests(host))).deliveries.map((r) => r.id)).toEqual([made.id])
    } finally {
      await delivery.forgetDeliveriesForTests()
      delivery.setReadsInboxForTests(null)
      await close(w)
    }
  })
})
