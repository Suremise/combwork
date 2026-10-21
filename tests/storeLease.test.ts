// A store's save under the board's lock holds a lease on the exact database connection it uses (#1383): a window opening
// the workspace while the save waits keeps the board the save opened (it used to close the window's live board), a window
// closing it leaves the save's writer open until the save ends (it used to close it under the save), and either way the
// save leaves nothing open that isn't a window's.
import { mkdirSync, renameSync, rmSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-store-lease-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
;(electron.shell as unknown as { trashItem: (f: string) => Promise<void> }).trashItem = async (f) => rmSync(f, { force: true })

const { createWorkspaceService, disposeWorkspaceService } = await import('../src/main/workspace')
const board = await import('../src/main/boardStore')
const { withStoreLock, storeValue } = await import('../src/main/storeRows')
const { readTable, saveTable } = await import('../src/main/storeTables')

let n = 0
/** A new workspace folder with a project. */
function workspace(): string {
  const ws = join(base, `ws-${++n}`)
  mkdirSync(join(ws, 'proj', '.hive'), { recursive: true })
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
    mkdirSync(join(elsewhere, 'proj', '.hive'), { recursive: true })
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
    // What it saved, read with a lease of a test's own.
    const lease = board.leaseDb(ws)
    try {
      expect(readTable(ws, 'lanes').meta.get('last')).toBe('"1"')
    } finally {
      lease.release()
      lease.release()
    }
    expect(board.boardOpen(ws)).toBe(false)
  })

  it("a lease on a window's board leaves it open, and ends once however often it is released", () => {
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
    const live = board.workspaceDb(ws)
    const c = board.leaseDb(ws)
    expect(c.kept).toBe(true)
    c.release()
    expect(board.workspaceDb(ws)).toBe(live)
    board.closeBoard(ws)
  })
})
