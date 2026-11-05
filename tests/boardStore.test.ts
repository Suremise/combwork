// The board in SQLite (#1017): the database layer (settings, migrations, a file from a newer Combwork), the move of the cards'
// files into it (once, checked, the folder kept as a backup and a stub left for older versions), cards an older Hive saved
// meanwhile, Export Board to JSON (an export read back is the same board), and the window's board with archived cards in short.
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join, resolve, sep } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { junction, shortPath } from './pathAliases'
import { tempDir } from './tempDir'
import { leftByAKill, refusedNow, whileMapped } from './mappedShm'
import { journalSettings } from '../src/shared/journal'
import type { BoardNotice } from '../src/main/boardStore'

const base = tempDir('hive-board-store-')
// The longest a wait here waits for what it waits on: a bound for a hung run (tests/README.md).
const HUNG_MS = 10_000
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace, WorkspaceService } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const journal = await import('../src/main/journal')
const store = await import('../src/main/boardStore')
const { backupTo, OPEN_IO_RETRY_MS, openDb, schemaVersion, untilOpenable } = await import('../src/main/db')
const { renameRetrying } = await import('../src/main/fsutil')
const { refusal } = await import('../src/main/openingFence')

const user = { kind: 'user' } as const
let n = 0
type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterAll(async () => {
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})
afterEach(() => {
  store.boardTestHooks.refuseRename = null
})

/** A workspace with a project `p`, and the cards' files from before 0.9 given (`files`: name → text). */
function workspaceWith(files: Record<string, string> = {}): string {
  const ws = join(base, `ws-${++n}`)
  mkdirSync(join(ws, 'p', '.combwork'), { recursive: true })
  writeFileSync(join(ws, 'p', '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Agent 1' }] }))
  const tasksDir = join(ws, '.combwork', 'tasks')
  mkdirSync(tasksDir, { recursive: true })
  for (const [name, text] of Object.entries(files)) writeFileSync(join(tasksDir, name), text)
  return ws
}
async function open(ws: string): Promise<WS> {
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return w
}
const card = (num: number, fields: Record<string, unknown> = {}): Record<string, unknown> => ({ number: num, title: `Card ${num}`, description: `About ${num}`, project: 'p', agent: null, column: 'todo', order: num, labels: [], blocked: null, blockedBy: [], links: [], comments: [{ at: '2026-10-01T00:00:00.000Z', by: 'You', text: `Note ${num}`, id: `c${num}` }], history: [], archived: false, createdAt: '2026-10-01T00:00:00.000Z', createdBy: 'You', updatedAt: '2026-10-01T00:00:00.000Z', ...fields })
const fileOf = (c: Record<string, unknown>): string => JSON.stringify(c, null, 2) + '\n'
const hiveFolders = (ws: string): string[] => readdirSync(join(ws, '.combwork')).sort()

describe('the database layer (db.ts)', () => {
  it('opens with WAL and its settings, runs each step once, recorded with the version that ran it', () => {
    const file = join(base, `layer-${++n}`, 'x.db')
    const steps = [{ version: 1, name: 'one', up: (d: DatabaseSync) => d.exec('CREATE TABLE a (x)') }]
    const db = openDb(file, { migrations: steps, hiveVersion: '9.9.9' })
    try {
      expect((db.writer.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal')
      expect((db.writer.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous).toBe(1)
      expect((db.writer.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout).toBe(5000)
      expect(db.writer.prepare('SELECT version, name, hive_version FROM schema_version').all()).toEqual([{ version: 1, name: 'one', hive_version: '9.9.9' }])
      // The reader only reads.
      expect(() => db.reader.exec('INSERT INTO a VALUES (1)')).toThrow()
    } finally {
      db.close()
    }
    // A second step later: only it runs, after a copy of the file kept in the backup folder.
    const backups = join(base, `layer-${n}`, 'backups')
    const two = openDb(file, { migrations: [...steps, { version: 2, name: 'two', up: (d) => d.exec('CREATE TABLE b (y)') }], hiveVersion: '9.9.10', backupDir: backups })
    try {
      expect(schemaVersion(two.writer)).toBe(2)
      expect(readdirSync(backups).filter((f) => f.startsWith('x-v1-'))).toHaveLength(1)
    } finally {
      two.close()
    }
  })

  it("keeps the newest three copies of a database across times and versions, never another database's or other files (#1039)", () => {
    const dir = join(base, `layer-${++n}`, 'backups')
    mkdirSync(dir, { recursive: true })
    // Another database sharing the folder, one whose name starts the same, and files not of the form: all kept.
    const others = ['journal-v1-2026-01-01T00-00-00-000Z.db', 'hive-journal-v1-2026-01-01T00-00-00-000Z.db', 'hive-v1-notes.db', 'hive-v1-2026-01-01T00-00-00-000Z.db.txt']
    for (const f of others) writeFileSync(join(dir, f), '')
    const db = new DatabaseSync(':memory:')
    try {
      db.exec('CREATE TABLE a (x)')
      // Five copies at different seconds, minutes, days and versions, made out of order: the newest three by time remain.
      const times = ['2026-10-17T22-08-09-123Z', '2026-10-15T10-00-00-000Z', '2026-10-17T22-08-10-000Z', '2026-10-17T23-59-59-999Z', '2026-10-16T08-30-00-500Z']
      const versions = [1, 3, 2, 1, 2]
      times.forEach((t, i) => backupTo(db, dir, 'hive', versions[i], new Date(t.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z/, 'T$1:$2:$3.$4Z'))))
      const kept = readdirSync(dir).filter((f) => !others.includes(f)).sort()
      expect(kept).toEqual(['hive-v1-2026-10-17T22-08-09-123Z.db', 'hive-v1-2026-10-17T23-59-59-999Z.db', 'hive-v2-2026-10-17T22-08-10-000Z.db'])
      // Each is a whole copy.
      for (const f of kept) {
        const copy = new DatabaseSync(join(dir, f), { readOnly: true })
        expect(copy.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([{ name: 'a' }])
        copy.close()
      }
      for (const f of others) expect(existsSync(join(dir, f))).toBe(true)
    } finally {
      db.close()
    }
  })

  it('a file from a newer Combwork opens read-only, migrated not at all', () => {
    const file = join(base, `layer-${++n}`, 'x.db')
    const steps = [{ version: 1, name: 'one', up: (d: DatabaseSync) => d.exec('CREATE TABLE a (x)') }]
    openDb(file, { migrations: steps, hiveVersion: '1' }).close()
    const raw = new DatabaseSync(file)
    raw.exec("INSERT INTO schema_version VALUES (7, 'from the future', '', '2.0.0')")
    raw.close()
    const db = openDb(file, { migrations: steps, hiveVersion: '1' })
    try {
      expect(db.newer).toBe(7)
      expect(() => db.writer.exec('INSERT INTO a VALUES (1)')).toThrow()
    } finally {
      db.close()
    }
  })

  // SQLite's own error, as node:sqlite throws it: an I/O error has errcode 10 (or an extended code of it).
  const sqliteError = (errcode: number, message: string): Error => Object.assign(new Error(message), { code: 'ERR_SQLITE_ERROR', errcode })

  it('an open that fails with an I/O error is tried again, and opens once the error has gone (HI-2179)', () => {
    const file = join(base, `layer-${++n}`, 'x.db')
    const steps = [{ version: 1, name: 'one', up: (d: DatabaseSync) => d.exec('CREATE TABLE a (x)') }]
    // As just after a Combwork ended without quitting: the first two opens fail (4618: SQLITE_IOERR_SHMOPEN).
    let failing = 2
    const retries: number[] = []
    const db = openDb(file, {
      migrations: steps,
      hiveVersion: '1',
      setup: () => {
        if (failing-- > 0) throw sqliteError(4618, 'disk I/O error')
      },
      onIoRetry: (e, ms) => {
        expect(e.message).toBe('disk I/O error')
        retries.push(ms)
      }
    })
    try {
      expect(retries).toEqual(OPEN_IO_RETRY_MS.slice(0, 2))
      expect(schemaVersion(db.writer)).toBe(1)
    } finally {
      db.close()
    }
  })

  it('an I/O error that stays fails the open after its retries, and any other error at once', () => {
    const file = join(base, `layer-${++n}`, 'x.db')
    const steps = [{ version: 1, name: 'one', up: (d: DatabaseSync) => d.exec('CREATE TABLE a (x)') }]
    const retries: number[] = []
    expect(() => openDb(file, { migrations: steps, hiveVersion: '1', setup: () => { throw sqliteError(10, 'disk I/O error') }, onIoRetry: (_e, ms) => retries.push(ms) })).toThrow('disk I/O error')
    expect(retries).toEqual(OPEN_IO_RETRY_MS)
    retries.length = 0
    expect(() => openDb(file, { migrations: steps, hiveVersion: '1', setup: () => { throw sqliteError(11, 'database disk image is malformed') }, onIoRetry: (_e, ms) => retries.push(ms) })).toThrow('malformed')
    expect(retries).toEqual([])
    // Closed each time it failed: the file opens now.
    openDb(file, { migrations: steps, hiveVersion: '1' }).close()
  })

  it('a file closed cleanly is openable at once, its files unchanged (HI-2199)', async () => {
    const file = join(base, `layer-${++n}`, 'x.db')
    openDb(file, { migrations: [{ version: 1, name: 'one', up: (d: DatabaseSync) => d.exec('CREATE TABLE a (x)') }], hiveVersion: '1' }).close()
    const before = readdirSync(join(file, '..')).sort()
    const told: Error[] = []
    expect(await untilOpenable(file, { onWait: (e) => told.push(e) })).toBe(0)
    expect(told).toEqual([])
    expect(readdirSync(join(file, '..')).sort()).toEqual(before)
  })
})

// --- HI-2199: a Combwork that ended without quitting leaves the board's -shm, which another process can still have mapped.

/** A workspace whose board has a card ("Kept"), left as a Combwork ended from outside leaves it. */
async function killedWorkspace(): Promise<{ ws: string; file: string }> {
  const ws = workspaceWith()
  const first = await open(ws)
  await inWorkspace(first, () => tasks.createTask({ title: 'Kept', project: 'p' }, user))
  await disposeWorkspaceService(first)
  store.closeBoard(ws)
  const file = join(ws, '.combwork', 'hive.db')
  await leftByAKill(file)
  return { ws, file }
}

describe.runIf(process.platform === 'win32')('a board whose -shm another process still maps (HI-2199)', () => {
  afterEach(() => {
    store.boardTestHooks.openableWait = null
    journal.journalTestHooks.openableWait = null
  })

  it("the workspace's open waits for it to be let go, then opens the board, instead of opening without it", async () => {
    const { ws, file } = await killedWorkspace()
    const waits: string[] = []
    store.boardTestHooks.openableWait = (p) => waits.push(p)
    await whileMapped(base, `${file}-shm`, async (release) => {
      // The first connection's truncation of the -shm is refused.
      expect(refusedNow(file)).toBe(1546)
      const opening = open(ws)
      await vi.waitFor(() => expect(waits).toEqual([resolve(ws)]), { timeout: HUNG_MS, interval: 20 })
      release()
      const w = await opening
      expect((await inWorkspace(w, () => tasks.allTasks(w))).map((c) => c.title)).toContain('Kept')
    })
  })

  it("the Assistant's journal too (HI-2200): the open waits for it to be let go, then the journal opens with its entries", async () => {
    const ws = workspaceWith()
    const first = await open(ws)
    const home = first.assistantHome
    const settings = journalSettings({ enabled: true })
    journal.writeEntry(home, settings, { kind: 'event', summary: 'Kept in the journal' }, 'hive')
    await disposeWorkspaceService(first)
    const file = journal.journalFile(home)
    await leftByAKill(file)
    const waits: string[] = []
    journal.journalTestHooks.openableWait = (h) => waits.push(h)
    await whileMapped(base, `${file}-shm`, async (release) => {
      expect(refusedNow(file)).toBe(1546)
      const opening = open(ws)
      await vi.waitFor(() => expect(waits).toEqual([home]), { timeout: HUNG_MS, interval: 20 })
      release()
      const w = await opening
      expect(journal.recall(w.assistantHome, {}).map((e) => e.summary)).toContain('Kept in the journal')
    })
  })

  it('a close while the open waits ends the wait at once, and the open goes no further', async () => {
    const { ws, file } = await killedWorkspace()
    const waits: string[] = []
    store.boardTestHooks.openableWait = (p) => waits.push(p)
    const w = createWorkspaceService()
    opened.push(w)
    await whileMapped(base, `${file}-shm`, async () => {
      const opening = w.open(ws).then(() => 'opened', (e: Error) => e.message)
      await vi.waitFor(() => expect(waits).toEqual([resolve(ws)]), { timeout: HUNG_MS, interval: 20 })
      await w.close()
      // Still mapped: the wait ended for the close, not for the file.
      expect(await opening).toMatch(/closed/)
      expect(refusedNow(file)).toBe(1546)
      expect(w.path).toBeNull()
    })
  })

  it("another workspace opened in the same window while the open waits: the old open is refused, and the new one is the window's", async () => {
    const { ws, file } = await killedWorkspace()
    const other = workspaceWith()
    const waits: string[] = []
    store.boardTestHooks.openableWait = (p) => waits.push(p)
    const w = createWorkspaceService()
    opened.push(w)
    const events: (string | null)[] = []
    const listener = (s: WS): void => {
      if (s === w) events.push(s.path)
    }
    WorkspaceService.openedListeners.add(listener)
    try {
      await whileMapped(base, `${file}-shm`, async () => {
        const opening = w.open(ws).then((info) => `opened ${info.path}`, (e: Error) => e.message)
        await vi.waitFor(() => expect(waits).toEqual([resolve(ws)]), { timeout: HUNG_MS, interval: 20 })
        const info = await w.open(other)
        expect(info.path).toBe(resolve(other))
        expect(await opening).toMatch(/closed/)
        expect(w.path).toBe(resolve(other))
        expect(events).toEqual([resolve(other)])
      })
    } finally {
      WorkspaceService.openedListeners.delete(listener)
    }
  })

  it('waits only for an I/O error, and as long as its bound', async () => {
    const file = join(base, `layer-${++n}`, 'x.db')
    mkdirSync(join(file, '..'), { recursive: true })
    await leftByAKill(file)
    await whileMapped(base, `${file}-shm`, async () => {
      const told: number[] = []
      const waited = await untilOpenable(file, { onWait: (e) => told.push((e as { errcode?: number }).errcode ?? 0), boundMs: 300 })
      expect(told).toEqual([1546])
      expect(waited).toBeGreaterThanOrEqual(300)
      // An aborted wait tries nothing more.
      const gone = new AbortController()
      gone.abort()
      expect(await untilOpenable(file, { signal: gone.signal, onWait: () => told.push(0) })).toBeLessThan(HUNG_MS)
      expect(told).toEqual([1546])
    })
    // Let go: at once, and the file opens.
    expect(await untilOpenable(file)).toBeLessThan(HUNG_MS)
    openDb(file, { migrations: [], hiveVersion: '1' }).close()
  })
})

describe("moving the cards' files in (#1017)", () => {
  it('imports every card file once, as its text was, skipping backups, temp files and damaged files; keeps the folder as a backup and leaves a stub', async () => {
    const files = {
      '1.json': fileOf(card(1, { custom: { kept: true } })),
      '2.json': fileOf(card(2, { column: 'done', archived: true, archivedFor: 'user' })),
      '3.json': '{ not json',
      '1.json.before-ids.bak': fileOf(card(1, { title: 'old copy' })),
      '1.json.123-4.tmp': '{ "half": ',
      'board.json': JSON.stringify({ version: 1, next: 40 }),
      'archive-batches.json': JSON.stringify({ version: 1, batches: [{ id: 'b1', at: '2026-10-02T00:00:00.000Z', by: 'You', label: 'All in Done', cards: [2], columns: { done: [2] } }] })
    }
    const ws = workspaceWith(files)
    const notices: BoardNotice[] = []
    store.onBoardNotice((_p, x) => notices.push(x))
    const w = await open(ws)
    const all = await inWorkspace(w, () => tasks.allTasks(w))
    expect(all.map((c) => c.number)).toEqual([1, 2])
    // Every field kept, the ones this Combwork doesn't know too.
    expect(store.cardDoc(w, 1)).toEqual(card(1, { custom: { kept: true } }))
    expect(await inWorkspace(w, () => tasks.archiveBatches(w))).toEqual([expect.objectContaining({ id: 'b1', cards: [2] })])
    // The next number is board.json's: a new card never takes one used before.
    expect((await inWorkspace(w, () => tasks.createTask({ title: 'New', project: 'p' }, user))).number).toBe(40)
    // The folder kept as it was, under its backup name; the stub has the next number and a README.
    const kept = hiveFolders(ws).find((f) => f.startsWith('tasks.imported-'))!
    expect(readdirSync(join(ws, '.combwork', kept)).sort()).toEqual(Object.keys(files).sort())
    expect(readFileSync(join(ws, '.combwork', kept, '1.json'), 'utf8')).toBe(files['1.json'])
    expect(readdirSync(join(ws, '.combwork', 'tasks')).sort()).toEqual(['README.txt', 'board.json'])
    expect(notices).toEqual([{ kind: 'imported', cards: 2, damaged: ['3.json'], folder: kept }])
    // The import is recorded; opening again imports nothing (the stub has no cards).
    await disposeWorkspaceService(w)
    const again = await open(ws)
    expect((await inWorkspace(again, () => tasks.allTasks(again))).map((c) => c.number).sort((a, b) => a - b)).toEqual([1, 2, 40])
    expect(hiveFolders(ws).filter((f) => f.startsWith('tasks.'))).toEqual([kept])
    // Closed, the stub's next number is the board's (an older Hive opening it never reuses one).
    await disposeWorkspaceService(again)
    expect(JSON.parse(readFileSync(join(ws, '.combwork', 'tasks', 'board.json'), 'utf8')).next).toBe(41)
  })

  it('a folder Windows refuses to rename is renamed at the next open; the cards are in the database meanwhile, imported once', async () => {
    const ws = workspaceWith({ '5.json': fileOf(card(5)) })
    store.boardTestHooks.refuseRename = () => true
    const w = await open(ws)
    expect((await inWorkspace(w, () => tasks.allTasks(w))).map((c) => c.number)).toEqual([5])
    expect(existsSync(join(ws, '.combwork', 'tasks', '5.json'))).toBe(true)
    await inWorkspace(w, () => tasks.updateTask(5, { title: 'Changed since' }, user))
    await disposeWorkspaceService(w)
    store.boardTestHooks.refuseRename = null
    const again = await open(ws)
    // Not imported again (the change made meanwhile is kept), and the folder has its backup name now.
    expect((await inWorkspace(again, () => tasks.getTask(5, again))).title).toBe('Changed since')
    expect(hiveFolders(ws).some((f) => f.startsWith('tasks.imported-'))).toBe(true)
    expect(readdirSync(join(ws, '.combwork', 'tasks')).sort()).toEqual(['README.txt', 'board.json'])
  })

  it("a new workspace's board starts empty, with a stub and no backup folder", async () => {
    const ws = workspaceWith()
    const w = await open(ws)
    expect(await inWorkspace(w, () => tasks.allTasks(w))).toEqual([])
    expect(hiveFolders(ws).filter((f) => f.startsWith('tasks'))).toEqual(['tasks'])
  })
})

describe("cards an older Hive saved meanwhile (#1017 downgrade, Darren's decision of 17 Oct: none taken back on its own)", () => {
  /** A workspace moved to the board (its board opened once and closed), and the stub an older Hive writes in. */
  async function moved(files: Record<string, string>): Promise<{ ws: string; stub: string }> {
    const ws = workspaceWith(files)
    const w = await open(ws)
    await inWorkspace(w, () => tasks.allTasks(w))
    await disposeWorkspaceService(w)
    return { ws, stub: join(ws, '.combwork', 'tasks') }
  }
  const older = (num: number, fields: Record<string, unknown> = {}) => fileOf(card(num, { createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z', ...fields }))
  const titlesOf = async (w: WS): Promise<string[]> => (await inWorkspace(w, () => tasks.allTasks(w))).map((c) => `#${c.number} ${c.title}`).sort()
  const asideIn = (ws: string): string[] => (existsSync(join(ws, '.combwork', store.SET_ASIDE)) ? readdirSync(join(ws, '.combwork', store.SET_ASIDE)).sort() : [])
  const asideText = (ws: string, f: string): string => readFileSync(join(ws, '.combwork', store.SET_ASIDE, f), 'utf8')
  /** Opens the workspace, reads its board and gives the notices it told. */
  async function openTold(ws: string): Promise<{ w: WS; notices: BoardNotice[] }> {
    const notices: BoardNotice[] = []
    store.onBoardNotice((_p, x) => notices.push(x))
    const w = await open(ws)
    await inWorkspace(w, () => tasks.allTasks(w))
    return { w, notices }
  }

  it('a card with a free number is set aside intact, not added; the stub is emptied and its number never given to a new card', async () => {
    const { ws, stub } = await moved({ '1.json': fileOf(card(1)), 'board.json': JSON.stringify({ version: 1, next: 2 }) })
    const free = older(2, { title: 'Made in rc.3', links: [1] })
    writeFileSync(join(stub, '2.json'), free)
    const { w, notices } = await openTold(ws)
    expect(await titlesOf(w)).toEqual(['#1 Card 1'])
    expect(asideIn(ws)).toEqual(['2.json'])
    expect(asideText(ws, '2.json')).toBe(free)
    expect(readdirSync(stub).sort()).toEqual(['README.txt', 'board.json'])
    expect(notices).toEqual([{ kind: 'setAside', cards: 1, folder: store.SET_ASIDE }])
    expect((await inWorkspace(w, () => tasks.createTask({ title: 'After', project: 'p' }, user))).number).toBe(3)
  })

  it('a card whose number the board has is set aside intact: the board and its links unchanged, one notice', async () => {
    const { ws, stub } = await moved({ '1.json': fileOf(card(1, { title: 'On the board' })), '5.json': fileOf(card(5, { links: [1] })) })
    const clash = older(1, { title: 'Made in rc.3 as #1', links: [5] })
    writeFileSync(join(stub, '1.json'), clash)
    writeFileSync(join(stub, '6.json'), older(6, { title: 'Free beside it' }))
    const { w, notices } = await openTold(ws)
    expect(await titlesOf(w)).toEqual(['#1 On the board', '#5 Card 5'])
    expect(store.cardDoc(w, 5)!.links).toEqual([1])
    expect(asideIn(ws)).toEqual(['1.json', '6.json'])
    expect(asideText(ws, '1.json')).toBe(clash)
    expect(notices).toEqual([{ kind: 'setAside', cards: 2, folder: store.SET_ASIDE }])
  })

  it('the same file again (it couldn\'t leave the stub, or came back) is set aside once and told once', async () => {
    const { ws, stub } = await moved({ '1.json': fileOf(card(1)) })
    const same = older(2, { title: 'Made in rc.3' })
    writeFileSync(join(stub, '2.json'), same)
    let { w, notices } = await openTold(ws)
    expect(notices).toEqual([{ kind: 'setAside', cards: 1, folder: store.SET_ASIDE }])
    await disposeWorkspaceService(w)
    // The very same file in the stub again.
    writeFileSync(join(stub, '2.json'), same)
    ;({ w, notices } = await openTold(ws))
    expect(asideIn(ws)).toEqual(['2.json'])
    expect(notices).toEqual([])
    expect(readdirSync(stub).sort()).toEqual(['README.txt', 'board.json'])
    expect(await titlesOf(w)).toEqual(['#1 Card 1'])
  })

  it('different content under a name set aside before is kept beside it under a name of its own, never over it', async () => {
    const { ws, stub } = await moved({ '1.json': fileOf(card(1)) })
    const first = older(2, { title: 'Made in rc.3' })
    writeFileSync(join(stub, '2.json'), first)
    let { w } = await openTold(ws)
    await disposeWorkspaceService(w)
    const second = older(2, { title: 'Made in rc.3, edited', updatedAt: '2026-10-06T00:00:00.000Z' })
    writeFileSync(join(stub, '2.json'), second)
    const told = await openTold(ws)
    w = told.w
    expect(told.notices).toEqual([{ kind: 'setAside', cards: 1, folder: store.SET_ASIDE }])
    const files = asideIn(ws)
    expect(files).toHaveLength(2)
    expect(asideText(ws, '2.json')).toBe(first)
    expect(files.filter((f) => f !== '2.json').map((f) => asideText(ws, f))).toEqual([second])
    expect(await titlesOf(w)).toEqual(['#1 Card 1'])
  })
})

describe('reviewing the set-aside cards (#1044, Darren\'s decision on #1017: the only way they reach the board)', () => {
  // Added and discarded files go to the Recycle Bin: a test trash folder here.
  const trashDir = join(base, 'set-aside-trash')
  beforeAll(() => {
    process.env.CW_TEST_TRASH_DIR = trashDir
  })
  afterAll(() => {
    delete process.env.CW_TEST_TRASH_DIR
  })
  const trashedFrom = (ws: string): string[] => {
    try {
      return readFileSync(join(trashDir, 'trash.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l).from as string).filter((f) => f.startsWith(ws + sep)).map((f) => f.slice(ws.length + 1))
    } catch {
      return []
    }
  }
  async function asideWith(board: Record<string, string>, stubFiles: Record<string, string>): Promise<{ ws: string; w: WS }> {
    const ws = workspaceWith(board)
    const first = await open(ws)
    await inWorkspace(first, () => tasks.allTasks(first))
    await disposeWorkspaceService(first)
    for (const [f, text] of Object.entries(stubFiles)) writeFileSync(join(ws, '.combwork', 'tasks', f), text)
    const w = await open(ws)
    await inWorkspace(w, () => tasks.allTasks(w))
    return { ws, w }
  }
  const older = (num: number, fields: Record<string, unknown> = {}) => fileOf(card(num, { createdBy: 'Assistant', createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z', ...fields }))
  const asideIn = (ws: string): string[] => readdirSync(join(ws, '.combwork', store.SET_ASIDE)).sort()

  it('lists each with its old number, whether it is free, who made it and a preview; a file that is not a card only as unreadable', async () => {
    const { w } = await asideWith({ '1.json': fileOf(card(1)) }, { '1.json': older(1, { title: 'Clashes' }), '7.json': older(7, { title: 'Free', description: 'x'.repeat(2000), column: 'review' }), '8.json': '{ damaged' })
    const list = await inWorkspace(w, () => tasks.setAsideCards(w))
    expect(list.map((c) => [c.file, c.number, c.free, c.readable, c.title])).toEqual([
      ['1.json', 1, false, true, 'Clashes'],
      ['7.json', 7, true, true, 'Free'],
      ['8.json', 8, true, false, '8.json']
    ])
    expect(list[1]).toMatchObject({ createdBy: 'Assistant', createdAt: '2026-10-05T00:00:00.000Z', project: 'p', column: 'review', comments: 1 })
    expect(list[1].preview).toHaveLength(600)
  })

  it('Add keeps a free old number, everything the card had and its links as they were, with a line by Repair; the file goes and it is never listed again', async () => {
    const { ws, w } = await asideWith({ '1.json': fileOf(card(1)), '2.json': fileOf(card(2, { links: [7] })) }, { '7.json': older(7, { title: 'Made in rc.3', links: [1, 40], labels: ['old'], decisions: [{ id: 'd1', text: 'Keep it', decidedBy: 'user', recordedBy: 'You', at: '2026-10-05T00:00:00.000Z' }] }) })
    const added = await inWorkspace(w, () => tasks.addSetAsideCard(w, '7.json'))
    expect(added.number).toBe(7)
    const c = await inWorkspace(w, () => tasks.getTask(7, w))
    expect(c).toMatchObject({ title: 'Made in rc.3', labels: ['old'], createdBy: 'Assistant', createdAt: '2026-10-05T00:00:00.000Z', comments: [expect.objectContaining({ text: 'Note 7' })], decisions: [expect.objectContaining({ text: 'Keep it' })] })
    // Its links as saved (a gone card's left out when read, never rewritten); #2's link to #7 now finds it.
    expect(store.cardDoc(w, 7)!.links).toEqual([1, 40])
    expect((await inWorkspace(w, () => tasks.getTask(2, w))).links).toEqual([7])
    expect(c.history.at(-1)).toMatchObject({ by: 'Repair', what: 'Added from an older Combwork, where it was made as #7' })
    // The older Combwork's file goes to the Recycle Bin, recoverable.
    await vi.waitFor(() => expect(asideIn(ws)).toEqual([]), { timeout: HUNG_MS })
    await vi.waitFor(() => expect(trashedFrom(ws)).toEqual([join('.combwork', store.SET_ASIDE, '7.json')]), { timeout: HUNG_MS })
    expect(await inWorkspace(w, () => tasks.setAsideCards(w))).toEqual([])
    // The same file back (it couldn't leave the stub): set aside again at the next open, but never listed or added twice.
    await disposeWorkspaceService(w)
    writeFileSync(join(ws, '.combwork', 'tasks', '7.json'), older(7, { title: 'Made in rc.3', links: [1, 40], labels: ['old'], decisions: [{ id: 'd1', text: 'Keep it', decidedBy: 'user', recordedBy: 'You', at: '2026-10-05T00:00:00.000Z' }] }))
    const w2 = await open(ws)
    expect(await inWorkspace(w2, () => tasks.setAsideCards(w2))).toEqual([])
    await vi.waitFor(() => expect(asideIn(ws)).toEqual([]), { timeout: HUNG_MS })
  })

  it('Add gives the next free number when the old one is taken, placed last in its column; the card on the board and links to the old number unchanged', async () => {
    const { ws, w } = await asideWith({ '1.json': fileOf(card(1, { title: 'On the board' })), '5.json': fileOf(card(5, { links: [1] })) }, { '1.json': older(1, { title: 'Made as #1', column: 'todo' }) })
    const before = store.cardDoc(w, 1)
    const added = await inWorkspace(w, () => tasks.addSetAsideCard(w, '1.json'))
    expect(added.number).toBe(6)
    expect(store.cardDoc(w, 1)).toEqual(before)
    expect(store.cardDoc(w, 5)!.links).toEqual([1])
    const c = await inWorkspace(w, () => tasks.getTask(6, w))
    expect(c.title).toBe('Made as #1')
    expect(c.order).toBeGreaterThan((await inWorkspace(w, () => tasks.getTask(5, w))).order)
    expect(c.history.at(-1)).toMatchObject({ by: 'Repair', what: 'Added from an older Combwork, where it was made as #1' })
    await vi.waitFor(() => expect(asideIn(ws)).toEqual([]), { timeout: HUNG_MS })
    // A new card after it takes the next number on.
    expect((await inWorkspace(w, () => tasks.createTask({ title: 'After', project: 'p' }, user))).number).toBe(7)
  })

  it('Add keeps every field the older Hive stored: its own fields and past holds for its cost; a review under way there ends (#1044 round 1)', async () => {
    const holds = [
      { agent: 'a-past', name: 'Past Builder', role: 'build', from: '2026-10-05T01:00:00.000Z', to: '2026-10-05T02:00:00.000Z' },
      { agent: 'a-rev', name: 'Past Reviewer', role: 'review', from: '2026-10-05T03:00:00.000Z' }
    ]
    const text = older(7, { custom: { keep: 'must survive recovery' }, column: 'review', review: { agent: 'a-rev', agentName: 'Past Reviewer', since: '2026-10-05T03:00:00.000Z' }, held: holds })
    const { ws, w } = await asideWith({ '1.json': fileOf(card(1)) }, { '7.json': text })
    await inWorkspace(w, () => tasks.addSetAsideCard(w, '7.json'))
    const doc = store.cardDoc(w, 7)!
    const was = JSON.parse(text) as Record<string, unknown>
    expect(doc.custom).toEqual({ keep: 'must survive recovery' })
    expect(doc.review).toBeUndefined()
    // The finished hold as it was; the review under way there ended as it was added.
    const held = doc.held as Record<string, unknown>[]
    expect(held[0]).toEqual(holds[0])
    expect(held[1]).toEqual({ ...holds[1], to: expect.any(String) })
    // Every other field as stored, and its history with the line by Repair after it.
    for (const k of Object.keys(was).filter((f) => !['number', 'order', 'history', 'updatedAt', 'review', 'held'].includes(f))) expect([k, doc[k]]).toEqual([k, was[k]])
    expect((doc.history as unknown[]).slice(0, -1)).toEqual(was.history)
    await vi.waitFor(() => expect(asideIn(ws)).toEqual([]), { timeout: HUNG_MS })
    await vi.waitFor(() => expect(trashedFrom(ws)).toEqual([join('.combwork', store.SET_ASIDE, '7.json')]), { timeout: HUNG_MS })
  })

  it('Add brings back a card whose own fields are of the wrong type, as any read would show it: a broken cost or history field never stops it (#1044 round 2)', async () => {
    const goodHold = { agent: 'a-past', name: 'Past Builder', role: 'build', from: '2026-10-05T01:00:00.000Z', to: '2026-10-05T02:00:00.000Z' }
    const files = {
      // held not a list; held with broken entries beside a good one; history not a list, with no holds to work out from it.
      '7.json': older(7, { title: 'Held not a list', held: 'not an array' }),
      '8.json': older(8, { title: 'Broken holds', held: [null, 'x', { name: 'No role' }, goodHold], custom: 1 }),
      '9.json': older(9, { title: 'History not a list', history: 'nope', column: 'doing', agent: 'a1' }),
      '10.json': older(10, { title: 'Broken history entries', history: [null, { at: '2026-10-05T00:00:00.000Z' }, { at: '2026-10-05T00:00:00.000Z', by: 'You', what: 'Created in Todo', id: 'h1' }] }),
      // A partial card: only a title and a field of its own.
      '11.json': JSON.stringify({ title: 'Only a title', mine: { kept: true } })
    }
    const { ws, w } = await asideWith({ '1.json': fileOf(card(1)) }, files)
    expect((await inWorkspace(w, () => tasks.setAsideCards(w))).map((c) => [c.number, c.readable])).toEqual([7, 8, 9, 10, 11].map((x) => [x, true]))
    for (const f of Object.keys(files)) await inWorkspace(w, () => tasks.addSetAsideCard(w, f))
    const got = async (x: number) => inWorkspace(w, () => tasks.getTask(x, w))
    expect((await got(7)).title).toBe('Held not a list')
    expect(store.cardDoc(w, 7)!.held).toBeUndefined()
    expect(store.cardDoc(w, 8)!.held).toEqual([goodHold])
    expect(store.cardDoc(w, 8)!.custom).toBe(1)
    expect((await got(9)).history.map((h) => h.by)).toEqual(['Repair'])
    expect((await got(10)).history.map((h) => h.what)).toEqual(['Created in Todo', 'Added from an older Combwork, where it was made as #10'])
    const partial = await got(11)
    expect(partial).toMatchObject({ title: 'Only a title', description: '', column: 'todo', comments: [] })
    expect(store.cardDoc(w, 11)!.mine).toEqual({ kept: true })
    // Each original in the Recycle Bin, recoverable as it was.
    await vi.waitFor(() => expect(asideIn(ws)).toEqual([]), { timeout: HUNG_MS })
    await vi.waitFor(() => expect(trashedFrom(ws).sort()).toEqual(Object.keys(files).map((f) => join('.combwork', store.SET_ASIDE, f)).sort()), { timeout: HUNG_MS })
  })

  it('Discard moves the file to the trash, nothing on the board changes; a damaged file is refused by Add; names outside the folder are refused', async () => {
    const { ws, w } = await asideWith({ '1.json': fileOf(card(1)) }, { '3.json': older(3), '4.json': '{ damaged' })
    await expect(inWorkspace(w, () => tasks.addSetAsideCard(w, '4.json'))).rejects.toThrow(/can only be discarded/)
    await expect(inWorkspace(w, () => tasks.addSetAsideCard(w, '..\\..\\p\\.combwork\\project.json'))).rejects.toThrow(/can only be discarded/)
    await inWorkspace(w, () => tasks.discardSetAsideCard(w, '..\\tasks\\board.json'))
    expect(existsSync(join(ws, '.combwork', 'tasks', 'board.json'))).toBe(true)
    await inWorkspace(w, () => tasks.discardSetAsideCard(w, '3.json'))
    await inWorkspace(w, () => tasks.discardSetAsideCard(w, '4.json'))
    expect(asideIn(ws)).toEqual([])
    await vi.waitFor(() => expect(trashedFrom(ws).sort()).toEqual([join('.combwork', store.SET_ASIDE, '3.json'), join('.combwork', store.SET_ASIDE, '4.json')]), { timeout: HUNG_MS })
    expect(await titlesOf(w)).toEqual(['#1 Card 1'])
  })
})

const titlesOf = async (w: WS): Promise<string[]> => (await inWorkspace(w, () => tasks.allTasks(w))).map((c) => `#${c.number} ${c.title}`).sort()

describe('numbers an older Hive could take (#1017 round 1)', () => {
  it("the stub's next number moves on as each number is taken, before Combwork closes (ended without closing, an older Hive never reuses one)", async () => {
    const ws = workspaceWith({ '1.json': fileOf(card(1)) })
    const w = await open(ws)
    const made = await inWorkspace(w, () => tasks.createTask({ title: 'Made in 0.9', project: 'p' }, user))
    // Read while the board is open: nothing has closed it.
    expect(JSON.parse(readFileSync(join(ws, '.combwork', 'tasks', 'board.json'), 'utf8')).next).toBe(made.number + 1)
  })

  it("a damaged card file's number is never given to another card, moving in or back (as before 0.9)", async () => {
    // No board.json: the next number comes from the files, the damaged one's too.
    const ws = workspaceWith({ '1.json': fileOf(card(1)), '2.json': '{ damaged' })
    let w = await open(ws)
    expect((await inWorkspace(w, () => tasks.createTask({ title: 'Next', project: 'p' }, user))).number).toBe(3)
    await disposeWorkspaceService(w)
    // A damaged file an older Hive left in the stub: its number is past the board's, and kept from new cards.
    writeFileSync(join(ws, '.combwork', 'tasks', '9.json'), '{ damaged too')
    w = await open(ws)
    expect((await inWorkspace(w, () => tasks.createTask({ title: 'After', project: 'p' }, user))).number).toBe(10)
  })
})

describe('Export Board to JSON (#1017)', () => {
  it("writes each card as its file was before 0.9; read back into another workspace, it is the same board, the Agent API's JSON byte for byte", async () => {
    const ws = workspaceWith({ '1.json': fileOf(card(1, { custom: 'mine' })), '2.json': fileOf(card(2, { column: 'done', archived: true })), 'board.json': JSON.stringify({ version: 1, next: 9 }) })
    const w = await open(ws)
    await inWorkspace(w, () => tasks.commentTask(1, 'after the move', user))
    const out = join(base, `export-${++n}`)
    expect(await store.exportBoard(w, out)).toBe(2)
    expect(readdirSync(out).sort()).toEqual(['1.json', '2.json', 'board.json'])
    expect(JSON.parse(readFileSync(join(out, '1.json'), 'utf8'))).toEqual(store.cardDoc(w, 1))
    expect(JSON.parse(readFileSync(join(out, 'board.json'), 'utf8')).next).toBe(9)
    // The export as an older Hive's board folder, opened by this one: the same cards.
    const copy = workspaceWith(Object.fromEntries(readdirSync(out).map((f) => [f, readFileSync(join(out, f), 'utf8')])))
    // Its project the same project (its id with it), as a workspace copied whole would have it.
    writeFileSync(join(copy, 'p', '.combwork', 'project.json'), readFileSync(join(ws, 'p', '.combwork', 'project.json')))
    const w2 = await open(copy)
    expect(JSON.stringify(await inWorkspace(w2, () => tasks.allTasks(w2)))).toBe(JSON.stringify(await inWorkspace(w, () => tasks.allTasks(w))))
  })
})

describe("the window's board (#1017)", () => {
  it('has archived cards in short unless asked for them in full; what agents read is unchanged', async () => {
    const ws = workspaceWith({ '1.json': fileOf(card(1)), '2.json': fileOf(card(2, { column: 'done', archived: true, archivedFor: 'user', archivedBatch: 'b9', labels: ['x'] })) })
    const w = await open(ws)
    const short = await inWorkspace(w, () => tasks.windowTasks(w))
    const live = short.find((c) => c.number === 1)!
    const archived = short.find((c) => c.number === 2)!
    expect(live.summary).toBeUndefined()
    expect(live.description).toBe('About 1')
    expect(archived).toMatchObject({ summary: true, archived: true, title: 'Card 2', column: 'done', archivedFor: 'user', archivedBatch: 'b9', labels: ['x'], description: '', comments: [], history: [] })
    const full = await inWorkspace(w, () => tasks.windowTasks(w, true))
    expect(full.find((c) => c.number === 2)).toMatchObject({ description: 'About 2', comments: [expect.objectContaining({ text: 'Note 2' })] })
    expect(full.some((c) => c.summary)).toBe(false)
    // The Agent API's reads (listTasks, getTask) never carry the window's short form.
    expect((await inWorkspace(w, () => tasks.listTasks({ archived: true })))[0].summary).toBeUndefined()
    expect(JSON.stringify(await inWorkspace(w, () => tasks.getTask(2, w)))).toBe(JSON.stringify(full.find((c) => c.number === 2)))
  })
})

describe('a board opened under another name for its folder (#1402)', () => {
  /** Another name for `ws`: a junction (removed by `drop`), or its 8.3 short name (null where the volume makes none). */
  const aliasOf = (kind: 'junction' | '8.3', ws: string): { path: string; drop: () => void } | null => {
    if (kind === '8.3') {
      const s = shortPath(ws)
      return s ? { path: s, drop: () => undefined } : null
    }
    const path = junction(ws, join(base, `alias-${++n}`))
    return { path, drop: () => unlinkSync(path) }
  }
  /** The window's board, opened as it is first used (by its window's spelling). */
  const useBoard = (w: WS) => inWorkspace(w, () => tasks.listTasks({}))
  const fenced = (ws: string): boolean => refusal(join(ws, '.combwork', 'hive.db')) !== null
  /** The next number in the stub older versions read, and the profiles' presence markers there. */
  const stubNext = (ws: string): number => JSON.parse(readFileSync(join(ws, '.combwork', 'tasks', 'board.json'), 'utf8')).next
  const markers = (ws: string): string[] => (existsSync(join(ws, '.combwork', 'open')) ? readdirSync(join(ws, '.combwork', 'open')) : [])
  /** Nothing holds the folder: it can be moved (Windows refuses while a connection has its database open). */
  async function moves(ws: string): Promise<void> {
    await renameRetrying(ws, `${ws}-moved`)
    expect(existsSync(join(`${ws}-moved`, '.combwork', 'hive.db'))).toBe(true)
  }

  for (const kind of ['junction', '8.3'] as const) {
    it(`${kind}: the window opened by the real path, a board opened only by the other name (as deliveries can), closed with the window`, async ({ skip }) => {
      const ws = workspaceWith()
      const alias = aliasOf(kind, ws)
      if (!alias) return skip('this volume makes no 8.3 names')
      try {
        const w = await open(ws)
        store.workspaceDb(alias.path)
        expect(store.boardOpen(alias.path)).toBe(true)
        await w.close()
        expect(store.boardOpen(alias.path)).toBe(false)
      } finally {
        alias.drop()
      }
      await moves(ws)
    })

    it(`${kind}: the window opened by the other name, a board opened by the real path, both closed with the window`, async ({ skip }) => {
      const ws = workspaceWith()
      const alias = aliasOf(kind, ws)
      if (!alias) return skip('this volume makes no 8.3 names')
      try {
        const w = await open(alias.path)
        await useBoard(w)
        store.workspaceDb(ws)
        expect([store.boardOpen(alias.path), store.boardOpen(ws)]).toEqual([true, true])
        await w.close()
        expect([store.boardOpen(alias.path), store.boardOpen(ws)]).toEqual([false, false])
      } finally {
        alias.drop()
      }
      await moves(ws)
    })
  }

  it('the junction the window opened by removed before it closes: its other boards close all the same (HR6 round 1)', async () => {
    const ws = workspaceWith()
    const alias = aliasOf('junction', ws)!
    const w = await open(alias.path)
    await useBoard(w)
    store.workspaceDb(ws)
    alias.drop()
    await w.close()
    expect([store.boardOpen(alias.path), store.boardOpen(ws)]).toEqual([false, false])
    expect(fenced(ws)).toBe(true)
    await moves(ws)
  })

  it("the junction the window opened by pointed at another window's workspace before it closes: that one keeps its board and stays unfenced (HR6 round 1)", async () => {
    const [ws, other] = [workspaceWith(), workspaceWith()]
    const alias = aliasOf('junction', ws)!
    try {
      const w = await open(alias.path)
      await useBoard(w)
      store.workspaceDb(ws)
      const w2 = await open(other)
      await useBoard(w2)
      alias.drop()
      junction(other, alias.path)
      await w.close()
      expect([store.boardOpen(alias.path), store.boardOpen(ws), store.boardOpen(other)]).toEqual([false, false, true])
      expect([fenced(ws), fenced(other)]).toEqual([true, false])
      await w2.close()
    } finally {
      unlinkSync(alias.path)
    }
    await moves(ws)
  })

  it("the junction the window opened by pointed at another window's workspace: the close writes nothing there and leaves its presence marker (HR6 round 2)", async () => {
    const [ws, other] = [workspaceWith(), workspaceWith()]
    const alias = aliasOf('junction', ws)!
    try {
      const w = await open(alias.path)
      for (const t of ['One', 'Two', 'Three']) await inWorkspace(w, () => tasks.createTask({ title: t, project: 'p' }, user))
      const w2 = await open(other)
      await useBoard(w2)
      const before = { stub: stubNext(other), markers: markers(other) }
      expect(before.markers).toHaveLength(1)
      expect(stubNext(ws)).toBe(4)
      alias.drop()
      junction(other, alias.path)
      await w.close()
      expect({ stub: stubNext(other), markers: markers(other) }).toEqual(before)
      expect(markers(ws)).toEqual([])
      expect(store.boardOpen(other)).toBe(true)
      await w2.close()
    } finally {
      unlinkSync(alias.path)
    }
  })

  it("a lease's board under another name of a workspace a window holds is the window's (#1395: by its place), kept as the lease ends with the presence marker, and closed with the window (HR6 round 2)", async () => {
    const ws = workspaceWith()
    const w = await open(ws)
    await useBoard(w)
    expect(markers(ws)).toHaveLength(1)
    const alias = aliasOf('junction', ws)!
    try {
      store.leaseDb(alias.path).release()
      expect([store.boardOpen(ws), store.boardOpen(alias.path)]).toEqual([true, true])
      expect(markers(ws)).toHaveLength(1)
      await w.close()
      expect([store.boardOpen(ws), store.boardOpen(alias.path)]).toEqual([false, false])
      expect(markers(ws)).toEqual([])
    } finally {
      alias.drop()
    }
  })

  it("a lease's board under another name of a workspace no window holds closes as the lease ends, leaving no presence marker (#1395)", () => {
    const ws = workspaceWith()
    const alias = aliasOf('junction', ws)!
    try {
      const lease = store.leaseDb(alias.path)
      expect(markers(ws)).toHaveLength(1)
      lease.release()
      expect([store.boardOpen(ws), store.boardOpen(alias.path)]).toEqual([false, false])
      expect(markers(ws)).toEqual([])
    } finally {
      alias.drop()
    }
  })
})

describe('a board saved by a newer Combwork (#1017)', () => {
  it('reads its cards but refuses every change, saying why', async () => {
    const ws = workspaceWith({ '1.json': fileOf(card(1)) })
    let w = await open(ws)
    await inWorkspace(w, () => tasks.allTasks(w))
    await disposeWorkspaceService(w)
    const raw = new DatabaseSync(store.boardFile(ws))
    raw.exec("INSERT INTO schema_version VALUES (99, 'from the future', '', '9.0.0')")
    raw.close()
    w = await open(ws)
    expect((await inWorkspace(w, () => tasks.allTasks(w))).map((c) => c.number)).toEqual([1])
    await expect(inWorkspace(w, () => tasks.createTask({ title: 'No', project: 'p' }, user))).rejects.toThrow(/saved by a newer version of Combwork/)
  })
})

describe('reads that need only some cards (#1107)', () => {
  // A busy board's archived cards are most of it (945 of 1058, 13 MB, most of that comments): what Combwork reads often
  // asks the query for what it needs, and never parses an archived card's document for nothing.
  const marker = 'ARCHIVED-COMMENTS-1107'
  const from = '2026-10-02T00:00:00.000Z'
  const to = '2026-10-03T00:00:00.000Z'
  const old = { archived: true, column: 'done', description: marker, comments: [{ at: from, by: 'You', text: marker, id: 'm' }] }
  const board = (): string =>
    workspaceWith({
      '1.json': fileOf(card(1, { column: 'doing', agent: 'a1', agentName: 'Agent 1', held: [{ agent: 'a1', name: 'Agent 1', role: 'build', from }] })),
      '2.json': fileOf(card(2, { ...old, held: [{ agent: 'a1', name: 'Agent 1', role: 'build', from, to }] })),
      // From before holds were kept (#602): read from its history.
      '3.json': fileOf(card(3, { ...old, agent: 'a1', agentName: 'Agent 1', history: [{ at: from, by: 'You', what: 'Created in Doing' }, { at: to, by: 'You', what: 'Moved to Done' }] })),
      '4.json': fileOf(card(4, { ...old, column: 'review', review: { agent: 'r9', agentName: 'R9', since: from } }))
    })

  it("asks for an agent's reviews in the query, archived cards included", async () => {
    const w = await open(board())
    expect((await inWorkspace(w, () => tasks.allTasks(w, { reviewers: ['r9'] }))).map((c) => c.number)).toEqual([4])
    expect(await inWorkspace(w, () => tasks.allTasks(w, { reviewers: ['a1'] }))).toEqual([])
    expect(await inWorkspace(w, () => tasks.allTasks(w, { reviewers: [] }))).toEqual([])
  })

  it("reads every card's holds for costs as the cards in full have them, the history only for a card that keeps none", async () => {
    const w = await open(board())
    const holds = new Map((await inWorkspace(w, () => tasks.cardHolds(w))).map((c) => [c.number, c]))
    expect([...holds.keys()]).toEqual([1, 2, 3, 4])
    for (const num of [1, 2, 3]) {
      const full = await inWorkspace(w, () => tasks.getTask(num, w))
      expect(holds.get(num)).toMatchObject({ project: full.project, held: full.held, agent: full.agent })
    }
    expect(holds.get(2)!.history).toEqual([])
    expect(holds.get(3)!.held).toBeUndefined()
    expect(holds.get(3)!.history).toEqual((await inWorkspace(w, () => tasks.getTask(3, w))).history)
  })

  it('decision notices, the hourly archiving, ending reviews and costs never parse an archived card they have no use for', async () => {
    const ws = board()
    const w = await open(ws)
    const { newDecisionsOn } = await import('../src/main/decisionNotices')
    const { cardCosts, laneCosts } = await import('../src/main/cardCosts')
    // The cards' files move into the board at its first read (once, every card parsed): done before looking.
    await inWorkspace(w, () => tasks.allTasks(w, { numbers: [1] }))
    const parse = vi.spyOn(JSON, 'parse')
    try {
      await inWorkspace(w, async () => {
        await newDecisionsOn(w, { projectPath: join(ws, 'p'), agentId: 'a1' }, 'Agent 1 (p)')
        await tasks.archiveOldDone(w)
        await tasks.endReviews('p', 'a1', 'its session ended', w)
        expect((await cardCosts(w, { numbers: [1] })).map((c) => c.number)).toEqual([1])
        await laneCosts(w)
      })
      expect(parse.mock.calls.filter(([text]) => typeof text === 'string' && text.includes(marker))).toEqual([])
    } finally {
      parse.mockRestore()
    }
  })
})
