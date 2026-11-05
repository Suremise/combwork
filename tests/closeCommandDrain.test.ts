// HI-1368's drain: a closed workspace's close command runs only once Combwork has finished writing it. A store's last save,
// asked for before the close and waiting meanwhile, keeps the drain waiting until it has committed (its row in the file
// when the drain ends); a lease held past the bound, or a quit's outer bound, ends it undrained (no command runs); the
// checkpoints are waited for before it ends. Real stores on a workspace folder; the rest with stand-ins.
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { tempDir } from './tempDir'
import { admitted } from './admitted'

const base = tempDir('cw-close-drain-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
afterAll(() => rmSync(base, { recursive: true, force: true }))

const tables = await import('../src/main/storeTables')
const board = await import('../src/main/boardStore')
const { readEntries } = await import('../src/main/schema/storeCodec')
const { dismiss: dismissPlace } = await import('../src/main/openingFence')
const { placeKey } = await import('../src/main/fsutil')
const { drainWorkspace } = await import('../src/main/closeCommand/drain')
const writes = await import('../src/main/dbWrites')
const rows = await import('../src/main/storeRows')
const sessions = await import('../src/main/sessionStore')

let n = 0
const dismissals: (() => void)[] = []
const workspace = (): string => {
  const ws = join(base, `ws-${++n}`)
  mkdirSync(join(ws, '.combwork'), { recursive: true })
  dismissals.push(admitted(ws))
  board.workspaceDb(ws)
  return ws
}
/** Its window closes it, as WorkspaceService.close does: dismissed, then its board closed. */
const close = (ws: string): void => {
  dismissPlace(placeKey(ws))
  board.closeBoard(ws)
}
const lane = (id: string): Record<string, unknown> => ({ id, project: 'hive', name: id, builder: { id: 'a-b', name: 'B' }, reviewer: null, cards: [1], rounds: 10, waitMinutes: 360, state: 'active', startedBy: 'B', startedAt: '2026-10-28T12:00:00.000Z', updatedAt: '2026-10-28T12:00:00.000Z' })
/** A gate a test opens: what waits on it goes on then. */
const gate = (): { wait: Promise<void>; open: () => void } => {
  let open!: () => void
  return { wait: new Promise<void>((r) => (open = r)), open }
}

afterEach(() => {
  tables.tableTestHooks.beforeSave = null
  rows.storeTestHooks.beforeSave = null
})
afterAll(() => {
  board.closeAllBoards()
  for (const d of dismissals.splice(0)) d()
})

describe('the drain, with the real stores', () => {
  it("a save asked for before the close, held on its way to the board's lock: the drain waits, and ends once it has committed", async () => {
    const ws = workspace()
    const held = gate()
    const entered = gate()
    tables.tableTestHooks.beforeSave = async () => {
      entered.open()
      await held.wait
    }
    const saving = tables.saveTable(ws, 'lanes', [lane('last')])
    await entered.wait
    close(ws)
    let drained: boolean | null = null
    const draining = drainWorkspace(ws, placeKey(ws), { ms: 30_000 }).then((r) => (drained = r.drained))
    // Nothing settles while the save is held: the drain is still waiting for it.
    await Promise.resolve()
    expect(writes.writesAt(placeKey(ws), ws)).toBe(1)
    expect(drained).toBeNull()
    held.open()
    await saving
    await draining
    expect(drained).toBe(true)
    // The save landed before the drain ended, and nothing has the file open now.
    expect(board.boardOpen(ws)).toBe(false)
    const db = new DatabaseSync(board.boardFile(ws))
    try {
      expect(readEntries(db as never, 'lanes').map((e) => (e.doc as { id: string }).id)).toEqual(['last'])
    } finally {
      db.close()
    }
  })

  it("a session's last change, held on its way to the board's lock as the workspace closes: the drain waits, and ends once it has committed (HR6's round 1)", async () => {
    const ws = workspace()
    const held = gate()
    const entered = gate()
    rows.storeTestHooks.beforeSave = async (store) => {
      if (store !== 'sessions') return
      entered.open()
      await held.wait
    }
    const place = { workspace: ws, scope: 'p-drain', file: join(ws, 'alpha', '.combwork', 'sessions.json') }
    const saving = sessions.changeSessions(place as never, (f) => void f.sessions.push({ id: 'last-change', provider: 'claude-code' } as never))
    await entered.wait
    close(ws)
    let drained: boolean | null = null
    const draining = drainWorkspace(ws, placeKey(ws), { ms: 30_000 }).then((r) => (drained = r.drained))
    await Promise.resolve()
    expect(writes.writesAt(placeKey(ws), ws)).toBeGreaterThan(0)
    expect(drained).toBeNull()
    held.open()
    await saving
    await draining
    expect(drained).toBe(true)
    const db = new DatabaseSync(board.boardFile(ws))
    try {
      expect(db.prepare("SELECT id FROM sessions WHERE id = 'last-change'").all()).toHaveLength(1)
    } finally {
      db.close()
    }
  })

  it('a lease held past the bound: not drained, saying what was left (no command runs)', async () => {
    const ws = workspace()
    close(ws)
    const lease = board.leaseDb(ws)
    try {
      const r = await drainWorkspace(ws, placeKey(ws), { ms: 50 })
      expect(r).toEqual({ drained: false, left: expect.arrayContaining(['1 write(s) under way', 'not drained in time']) })
    } finally {
      lease.release()
    }
  })

  it('a workspace with nothing under way drains at once', async () => {
    const ws = workspace()
    close(ws)
    await expect(drainWorkspace(ws, placeKey(ws), { ms: 30_000 })).resolves.toEqual({ drained: true })
  })
})

describe('the drain, with stand-ins', () => {
  const stand = (o: { writes?: () => number; released?: (file: string) => Promise<void> } = {}) => {
    const ended = new Set<() => void>()
    return {
      deps: {
        writes: o.writes ?? (() => 0),
        boardOpen: () => false,
        journalOpen: () => false,
        released: o.released ?? (() => Promise.resolve()),
        onWriteEnded: (fn: () => void) => {
          ended.add(fn)
          return () => ended.delete(fn)
        }
      },
      writeEnded: () => {
        for (const fn of [...ended]) fn()
      },
      listeners: () => ended.size
    }
  }

  it("waits for the files' checkpoints to let go, then ends", async () => {
    const cp = gate()
    const s = stand({ released: () => cp.wait })
    let done = false
    const d = drainWorkspace('D:\\ws', 'd:\\ws', { ms: 30_000, deps: s.deps }).then((r) => ((done = true), r))
    await Promise.resolve()
    expect(done).toBe(false)
    cp.open()
    await expect(d).resolves.toEqual({ drained: true })
    expect(s.listeners()).toBe(0)
  })

  it('a write that begins while the checkpoints are waited for is waited for too', async () => {
    let under = 0
    const cp = gate()
    const s = stand({ writes: () => under, released: () => cp.wait })
    let done = false
    const d = drainWorkspace('D:\\ws', 'd:\\ws', { ms: 30_000, deps: s.deps }).then((r) => ((done = true), r))
    under = 1
    cp.open()
    await cp.wait
    await Promise.resolve()
    expect(done).toBe(false)
    under = 0
    s.writeEnded()
    await expect(d).resolves.toEqual({ drained: true })
  })

  it("a quit's outer bound ends it undrained, and a drain completing later changes nothing", async () => {
    let under = 1
    const s = stand({ writes: () => under })
    const bound = new AbortController()
    const d = drainWorkspace('D:\\ws', 'd:\\ws', { ms: 30_000, cancelled: bound.signal, deps: s.deps })
    bound.abort()
    const r = await d
    expect(r.drained).toBe(false)
    expect(s.listeners()).toBe(0)
    under = 0
    s.writeEnded()
    // Still the answer it gave: nothing follows it (the caller runs nothing).
    expect(r.drained).toBe(false)
  })

  it('already cancelled: ends at once', async () => {
    const bound = new AbortController()
    bound.abort()
    await expect(drainWorkspace('D:\\ws', 'd:\\ws', { deps: stand().deps, cancelled: bound.signal })).resolves.toMatchObject({ drained: false })
  })
})
