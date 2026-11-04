// A store's save under the board's lock holds a lease on the exact database connection it uses (#1383): a window opening
// the workspace while the save waits keeps the board the save opened (it used to close the window's live board), a window
// closing it leaves the save's writer open until the save ends (it used to close it under the save), and either way the
// save leaves nothing open that isn't a window's.
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-store-lease-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
;(electron.shell as unknown as { trashItem: (f: string) => Promise<void> }).trashItem = async (f) => rmSync(f, { force: true })
// A store's move in, its file read: `whileReading`, when set, runs once the file is read, before the move goes on.
const moveHooks = vi.hoisted(() => ({ whileReading: null as (() => Promise<void>) | null }))
vi.mock('../src/main/storeRows', async (orig) => {
  const m = await orig<typeof import('../src/main/storeRows')>()
  return {
    ...m,
    openTable: ((...a: Parameters<typeof m.openTable>) => {
      const read = a[4]
      a[4] = async () => {
        const got = await read()
        await moveHooks.whileReading?.()
        return got
      }
      return m.openTable(...a)
    }) as typeof m.openTable
  }
})

const { createWorkspaceService, disposeWorkspaceService } = await import('../src/main/workspace')
const board = await import('../src/main/boardStore')
const { withStoreLock, storeValue } = await import('../src/main/storeRows')
const { saveTable } = await import('../src/main/storeTables')
const { readMeta } = await import('../src/main/schema/storeCodec')
const { admit, admittedCount, dismiss } = await import('../src/main/openingFence')
const { placeKey } = await import('../src/main/fsutil')

const at = '2026-10-22T00:00:00.000Z'
let n = 0
/** A new workspace folder with a project. */
function workspace(): string {
  const ws = join(base, `ws-${++n}`)
  mkdirSync(join(ws, 'proj', '.combwork'), { recursive: true })
  return ws
}
/** Another window's workspace, to switch to (closing the one open). */
const elsewhere = join(base, 'elsewhere')

/** Holds a promise until `release()`. */
function gate(): { held: Promise<void>; release: () => void } {
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  return { held, release }
}

/** Whether nothing holds the workspace's files open: Windows won't rename a folder with an open SQLite file in it. */
function nothingOpen(ws: string): boolean {
  try {
    renameSync(ws, `${ws}-moved`)
  } catch {
    return false
  }
  renameSync(`${ws}-moved`, ws)
  return true
}

const put = (db: ReturnType<typeof board.workspaceDb>['writer'], key: string, value: string): void => {
  db.prepare("INSERT INTO store_meta (store, scope, key, value) VALUES ('sessions', '', ?, ?) ON CONFLICT(store, scope, key) DO UPDATE SET value = excluded.value").run(key, value)
}

let w: ReturnType<typeof createWorkspaceService>

describe("a store's save holds its own connection (#1383)", () => {
  beforeAll(() => {
    mkdirSync(join(elsewhere, 'proj', '.combwork'), { recursive: true })
    mkdirSync(join(base, 'profile'), { recursive: true })
    w = createWorkspaceService()
  })
  afterAll(async () => {
    await disposeWorkspaceService(w)
    board.closeAllBoards()
  })

  it("doesn't close the board of a window that opened the workspace while it waited", async () => {
    const ws = workspace()
    await w.open(elsewhere)
    const g = gate()
    const started = gate()
    // A closed workspace's save: it opens the database for itself.
    const saving = withStoreLock(ws, 'sessions', '', async (db) => {
      started.release()
      await g.held
      put(db, 'during', '1')
    })
    await started.held
    expect(board.boardOpen(ws)).toBe(true)
    await w.open(ws)
    g.release()
    await saving
    // The window's board, still open: readable, with the save's row.
    expect(board.boardOpen(ws)).toBe(true)
    expect(storeValue(board.workspaceDb(ws).reader, 'sessions', '', 'during')).toBe('1')
    await w.open(elsewhere)
    expect(board.boardOpen(ws)).toBe(false)
    expect(nothingOpen(ws)).toBe(true)
  })

  it("doesn't close the board it opened for a window that had the workspace open already, its board not opened yet", async () => {
    const ws = workspace()
    await w.open(ws)
    // The window's board not opened yet (as before its first read): the save opens it.
    board.closeBoard(ws)
    const g = gate()
    const started = gate()
    const saving = withStoreLock(ws, 'sessions', '', async (db) => {
      started.release()
      await g.held
      put(db, 'opened-by-save', '1')
    })
    await started.held
    // The window reads its board meanwhile: the connection the save opened.
    const live = board.workspaceDb(ws)
    g.release()
    await saving
    expect(board.boardOpen(ws)).toBe(true)
    expect(board.workspaceDb(ws)).toBe(live)
    expect(storeValue(live.reader, 'sessions', '', 'opened-by-save')).toBe('1')
    // Its saves from now on keep it open too.
    await withStoreLock(ws, 'sessions', '', async (db) => put(db, 'later', '1'))
    expect(board.workspaceDb(ws)).toBe(live)
    await w.open(elsewhere)
    expect(board.boardOpen(ws)).toBe(false)
    expect(nothingOpen(ws)).toBe(true)
  })

  it("goes on with its writer when the window closes the workspace meanwhile, then leaves nothing open", async () => {
    const ws = workspace()
    await w.open(ws)
    board.workspaceDb(ws)
    const g = gate()
    const started = gate()
    const saving = withStoreLock(ws, 'sessions', '', async (db) => {
      started.release()
      await g.held
      // A write and a read after the close, on the connection the save began with.
      put(db, 'after-close', '1')
      return storeValue(db, 'sessions', '', 'after-close')
    })
    await started.held
    await w.open(elsewhere)
    expect(board.boardOpen(ws)).toBe(false)
    // Its connection is the save's until it ends.
    expect(nothingOpen(ws)).toBe(false)
    g.release()
    await expect(saving).resolves.toBe('1')
    expect(board.boardOpen(ws)).toBe(false)
    expect(nothingOpen(ws)).toBe(true)
    await w.open(ws)
    expect(storeValue(board.workspaceDb(ws).reader, 'sessions', '', 'after-close')).toBe('1')
    await w.open(elsewhere)
  })

  it('closed and opened again while it waits: its own connection to the end, the new board kept open', async () => {
    const ws = workspace()
    await w.open(ws)
    const first = board.workspaceDb(ws)
    const g = gate()
    const started = gate()
    const saving = withStoreLock(ws, 'sessions', '', async (db) => {
      started.release()
      await g.held
      put(db, 'reopened', '1')
      return db
    })
    await started.held
    await w.open(elsewhere)
    await w.open(ws)
    const second = board.workspaceDb(ws)
    expect(second).not.toBe(first)
    g.release()
    expect(await saving).toBe(first.writer)
    // The window's board is the new connection, untouched by the save's end.
    expect(board.boardOpen(ws)).toBe(true)
    expect(board.workspaceDb(ws)).toBe(second)
    expect(storeValue(second.reader, 'sessions', '', 'reopened')).toBe('1')
    await w.open(elsewhere)
    expect(nothingOpen(ws)).toBe(true)
  })

  it("a closed workspace's last save lands and leaves nothing open; a failed one too", async () => {
    const ws = workspace()
    await w.open(ws)
    await w.open(elsewhere)
    expect(board.boardOpen(ws)).toBe(false)
    await saveTable(ws, 'lanes', [], { last: '"1"' })
    expect(board.boardOpen(ws)).toBe(false)
    expect(nothingOpen(ws)).toBe(true)
    await expect(
      withStoreLock(ws, 'sessions', '', async () => {
        throw new Error('the save failed')
      })
    ).rejects.toThrow('the save failed')
    expect(board.boardOpen(ws)).toBe(false)
    expect(nothingOpen(ws)).toBe(true)
    // What it saved, read on a lease of a test's own (its connection: a persistent read is refused, #1395).
    const lease = board.leaseDb(ws)
    try {
      expect(readMeta(lease.db.reader, 'lanes').get('last')).toBe('"1"')
    } finally {
      lease.release()
      lease.release()
    }
    expect(board.boardOpen(ws)).toBe(false)
  })

  it("a session's last change after its window closed the workspace lands, its host not read this run, and leaves nothing open (#1381)", async () => {
    const ws = workspace()
    const proj = join(ws, 'proj')
    writeFileSync(join(proj, '.combwork', 'project.json'), JSON.stringify({ version: 2, id: 'p-lease', agents: [] }))
    await w.open(ws)
    await w.open(elsewhere)
    expect(board.boardOpen(ws)).toBe(false)
    // As a session ending as its agents stop (sessions.ts: lastActiveAt), its host's records never read this run.
    await w.mutateSessions(proj, (f) => {
      f.sessions.push({ id: 's-last', agent: 'claude-code', name: 'Last', createdAt: at, lastActiveAt: at, archived: false })
    })
    expect(board.boardOpen(ws)).toBe(false)
    expect(nothingOpen(ws)).toBe(true)
    await w.open(ws)
    expect((await w.sessionsFile(proj)).sessions.map((s) => s.id)).toEqual(['s-last'])
    await w.open(elsewhere)
  })

  it("a session's change whose host's file moves in as the window closes the workspace lands, and leaves nothing open (#1381)", async () => {
    const ws = workspace()
    const proj = join(ws, 'proj')
    writeFileSync(join(proj, '.combwork', 'project.json'), JSON.stringify({ version: 2, id: 'p-move', agents: [] }))
    // Its old file, moved in by the first change of this run.
    writeFileSync(join(proj, '.combwork', 'sessions.json'), JSON.stringify({ version: 1, sessions: [{ id: 's-old', agent: 'claude-code', name: 'Old', createdAt: at, lastActiveAt: at, archived: false }] }))
    await w.open(ws)
    const g = gate()
    const reading = gate()
    moveHooks.whileReading = async () => {
      moveHooks.whileReading = null
      reading.release()
      await g.held
    }
    const saving = w.mutateSessions(proj, (f) => {
      f.sessions.push({ id: 's-new', agent: 'claude-code', name: 'New', createdAt: at, lastActiveAt: at, archived: false })
    })
    await reading.held
    await w.open(elsewhere)
    expect(board.boardOpen(ws)).toBe(false)
    g.release()
    await saving
    expect(board.boardOpen(ws)).toBe(false)
    expect(nothingOpen(ws)).toBe(true)
    await w.open(ws)
    expect((await w.sessionsFile(proj)).sessions.map((s) => s.id).sort()).toEqual(['s-new', 's-old'])
    await w.open(elsewhere)
  })

  it("a session deleted while its workspace is closed stays deleted when its host's old file moves in at the next open (HI-1736)", async () => {
    const ws = workspace()
    const proj = join(ws, 'proj')
    writeFileSync(join(proj, '.combwork', 'project.json'), JSON.stringify({ version: 2, id: 'p-deleted', agents: [] }))
    // Its old file, not moved in yet: s-old (deleted below) and s-keep.
    const rec = (id: string) => ({ id, agent: 'claude-code', name: id, createdAt: at, lastActiveAt: at, archived: false })
    writeFileSync(join(proj, '.combwork', 'sessions.json'), JSON.stringify({ version: 1, sessions: [rec('s-old'), rec('s-keep')] }))
    await w.open(ws)
    await w.open(elsewhere)
    expect(board.boardOpen(ws)).toBe(false)
    // Deleted while its workspace is closed (#1381's save, written without the move in): its id in the host's deleted list.
    await w.mutateSessions(proj, (f) => {
      f.sessions = f.sessions.filter((s) => s.id !== 's-old')
      f.deleted = [...(f.deleted ?? []), 's-old']
    })
    await w.open(ws)
    const f = await w.sessionsFile(proj)
    expect(f.sessions.map((s) => s.id)).toEqual(['s-keep'])
    expect(f.deleted).toEqual(['s-old'])
    await w.open(elsewhere)
  })

  it("a background read held across its workspace's close is refused however many workspaces open and close after it, with nothing of them kept (#1381, #1395)", async () => {
    const ws = workspace()
    await w.open(ws)
    const g = gate()
    const reader = (async () => {
      await g.held
      return board.workspaceDb(ws)
    })()
    await w.open(elsewhere)
    const count = admittedCount()
    const others = Array.from({ length: 100 }, (_, i) => placeKey(join(base, 'closed-after', `ws-${i}`)))
    for (const o of others) admit(o)
    for (const o of others) dismiss(o)
    expect(admittedCount()).toBe(count)
    g.release()
    await expect(reader).rejects.toThrow('The workspace was closed')
    expect(board.boardOpen(ws)).toBe(false)
    expect(nothingOpen(ws)).toBe(true)
  })

  it("a lease on a window's board leaves it open, and ends once however often it is released", () => {
    const ws = workspace()
    // The window's: admitted as a window opening it would.
    admit(placeKey(ws))
    const a = board.leaseDb(ws)
    const b = board.leaseDb(ws)
    expect(a.db).toBe(b.db)
    expect(a.kept).toBe(true)
    a.release()
    a.release()
    expect(board.boardOpen(ws)).toBe(true)
    b.release()
    // Admitted: the board the leases opened is the window's, kept as they end.
    expect(board.boardOpen(ws)).toBe(true)
    const live = board.workspaceDb(ws)
    const c = board.leaseDb(ws)
    expect(c.kept).toBe(true)
    c.release()
    expect(board.workspaceDb(ws)).toBe(live)
    dismiss(placeKey(ws))
    board.closeBoard(ws)
  })

  it('a lease on a workspace no window holds leaves no handle as it ends, however often it is released (#1395)', () => {
    const ws = workspace()
    const a = board.leaseDb(ws)
    const b = board.leaseDb(ws)
    expect(a.db).toBe(b.db)
    expect(a.kept).toBe(false)
    a.release()
    a.release()
    // b's lease still holds it.
    expect(board.boardOpen(ws)).toBe(true)
    b.release()
    expect(board.boardOpen(ws)).toBe(false)
    expect(nothingOpen(ws)).toBe(true)
    // Not kept open for anyone: a persistent open is refused.
    expect(() => board.workspaceDb(ws)).toThrow('The workspace was closed')
    expect(board.boardOpen(ws)).toBe(false)
  })

  it("a persistent read while a closed workspace's last save holds its lease is refused: it neither borrows the lease's connection nor comes to own it (HR6)", async () => {
    const ws = workspace()
    await w.open(ws)
    board.workspaceDb(ws)
    const lease = board.leaseDb(ws)
    try {
      await w.open(elsewhere)
      // The close left the lease its connection, open.
      expect(lease.kept).toBe(false)
      expect(() => board.workspaceDb(ws)).toThrow('The workspace was closed')
    } finally {
      lease.release()
    }
    expect(board.boardOpen(ws)).toBe(false)
    expect(nothingOpen(ws)).toBe(true)
  })

  it('a workspace never opened by a window: a persistent read is refused and leaves nothing open (#1395)', () => {
    const ws = workspace()
    expect(() => board.workspaceDb(ws)).toThrow('The workspace was closed')
    expect(() => board.upgradeWaiting(ws)).toThrow('The workspace was closed')
    expect(board.boardOpen(ws)).toBe(false)
    expect(nothingOpen(ws)).toBe(true)
  })
})
