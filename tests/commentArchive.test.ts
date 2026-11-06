// A card's comment archive (HI-2641, schema/commentArchive.ts): the oldest comments past the 500 a card keeps are
// archived in the change that evicts them, never dropped; each exactly once, in order, whatever saves or rolls back; read
// a page at a time and counted; the cards that held the cap before the archive existed flagged as maybe having lost
// some; and kept in Export Board.
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { as09, editCard } from './boardDb'

const base = tempDir('cw-comment-archive-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const { MAY_HAVE_LOST_KEY } = await import('../src/main/schema/commentArchive')
type WS = ReturnType<typeof createWorkspaceService>

const user = { kind: 'user' } as const
const alphaAgent = { kind: 'agent', name: 'Agent 1 (alpha)', self: { project: 'alpha', agentId: 'a1' }, scope: 'alpha' } as const
const betaAgent = { kind: 'agent', name: 'Agent 1 (beta)', self: { project: 'beta', agentId: 'b1' }, scope: 'beta' } as const
const KEPT = 500

let n = 0
const opened: WS[] = []
afterEach(async () => {
  store.boardTestHooks.failPut = null
  for (const w of opened.splice(0)) await close(w)
})
afterAll(() => store.closeAllBoards())

function newWorkspace(): string {
  const ws = join(base, `ws-${++n}`)
  for (const [p, a] of [['alpha', 'a1'], ['beta', 'b1']]) {
    mkdirSync(join(ws, p, '.combwork'), { recursive: true })
    writeFileSync(join(ws, p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: a, name: 'Agent 1' }] }))
  }
  return ws
}
async function open(ws: string): Promise<WS> {
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return w
}
async function close(w: WS): Promise<void> {
  const path = w.path!
  const i = opened.indexOf(w)
  if (i >= 0) opened.splice(i, 1)
  await disposeWorkspaceService(w)
  store.closeBoard(path)
}

/** `count` comments, numbered from `from`: "c0", "c1"… (with ids unless `ids` is false). */
const comments = (count: number, from = 0, ids = true): Record<string, string>[] =>
  Array.from({ length: count }, (_, i) => ({ at: new Date(Date.UTC(2026, 0, 1, 0, 0, from + i)).toISOString(), by: 'someone', text: `c${from + i}`, ...(ids ? { id: `id${from + i}` } : {}) }))

/** A card in alpha with these comments saved on it. */
async function cardWith(w: WS, list: unknown[]): Promise<number> {
  const c = await inWorkspace(w, () => tasks.createTask({ title: 'Long', project: 'alpha' }, user))
  await editCard(w, c.number, (d) => void (d.comments = list))
  return c.number
}

const archived = (w: WS, card: number, offset = 0, limit = 100) => inWorkspace(w, () => tasks.archivedCommentsOf(card, user, offset, limit))
const texts = (list: { text: string }[]): string[] => list.map((c) => c.text)
/** The archive's rows as stored (its keys and raw JSON too), on a connection of their own. */
function rows(ws: string, card: number): { ord: number; akey: string; text: string; doc: string }[] {
  const db = new DatabaseSync(store.boardFile(ws), { readOnly: true })
  try {
    return (db.prepare('SELECT ord, akey, doc FROM card_comments_archive WHERE card = ? ORDER BY ord').all(card) as { ord: number; akey: string; doc: string }[]).map((r) => ({ ...r, text: (JSON.parse(r.doc) as { text: string }).text }))
  } finally {
    db.close()
  }
}
function tables(ws: string): string[] {
  const db = new DatabaseSync(store.boardFile(ws), { readOnly: true })
  try {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name)
  } finally {
    db.close()
  }
}

describe('archiving past the cap', () => {
  it('a 501st comment archives the oldest, which is read back exactly; none below the cap', async () => {
    const ws = newWorkspace()
    const w = await open(ws)
    const card = await cardWith(w, comments(KEPT - 1))
    await inWorkspace(w, () => tasks.commentTask(card, 'c499', user))
    expect(await archived(w, card)).toMatchObject({ total: 0, comments: [] })
    expect(inWorkspace(w, () => tasks.commentArchive(card))).toEqual({ archived: 0, mayHaveBeenLost: false })
    const c = await inWorkspace(w, () => tasks.commentTask(card, 'c500', user))
    expect(c.comments).toHaveLength(KEPT)
    expect(c.comments[0].text).toBe('c1')
    const got = await archived(w, card)
    expect(got.total).toBe(1)
    expect(got.comments).toEqual([{ at: comments(1)[0].at, by: 'someone', text: 'c0' }])
    expect(inWorkspace(w, () => tasks.commentArchive(card))).toEqual({ archived: 1, mayHaveBeenLost: false })
  })

  it('500 + k comments archive k, oldest first, paged with offset and limit', async () => {
    const ws = newWorkspace()
    const w = await open(ws)
    const card = await cardWith(w, comments(KEPT))
    for (let i = 0; i < 5; i++) await inWorkspace(w, () => tasks.commentTask(card, `new${i}`, user))
    expect(texts((await archived(w, card)).comments)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4'])
    expect(texts((await archived(w, card, 1, 2)).comments)).toEqual(['c1', 'c2'])
    expect(texts((await archived(w, card, 5)).comments)).toEqual([])
    const now = await inWorkspace(w, () => tasks.getTask(card))
    expect(now.comments).toHaveLength(KEPT)
    expect(now.comments.at(-1)!.text).toBe('new4')
    // The card and its archive hold every comment once, in order.
    expect([...texts((await archived(w, card)).comments), ...texts(now.comments)]).toEqual([...texts(comments(KEPT)), 'new0', 'new1', 'new2', 'new3', 'new4'])
  })

  it('several adds before one save archive all their evictions; the same object saved twice in one change adds them once', async () => {
    const ws = newWorkspace()
    const w = await open(ws)
    const card = await cardWith(w, comments(KEPT))
    await inWorkspace(w, () =>
      store.boardWrite(w, async () => {
        const c = await tasks.getTask(card, w)
        tasks.commentTestSeam.add(c, 'me', 'a')
        tasks.commentTestSeam.add(c, 'me', 'b')
        tasks.commentTestSeam.add(c, 'me', 'c')
        await tasks.commentTestSeam.save(w, c)
        await tasks.commentTestSeam.save(w, c)
      })
    )
    expect(rows(ws, card).map((r) => [r.ord, r.text])).toEqual([[0, 'c0'], [1, 'c1'], [2, 'c2']])
    expect(new Set(rows(ws, card).map((r) => r.akey)).size).toBe(3)
  })

  it('a failed save archives nothing, and a retry of the same object archives each once', async () => {
    const ws = newWorkspace()
    const w = await open(ws)
    const card = await cardWith(w, comments(KEPT))
    const c = await inWorkspace(w, () => tasks.getTask(card, w))
    tasks.commentTestSeam.add(c, 'me', 'a')
    tasks.commentTestSeam.add(c, 'me', 'b')
    // The put fails (a full disk): the change rolls back whole.
    store.boardTestHooks.failPut = (x) => x === card
    await expect(inWorkspace(w, () => store.boardWrite(w, () => tasks.commentTestSeam.save(w, c)))).rejects.toThrow(/SQLITE_FULL/)
    store.boardTestHooks.failPut = null
    expect(rows(ws, card)).toEqual([])
    expect((await inWorkspace(w, () => tasks.getTask(card))).comments[0].text).toBe('c0')
    // The archive is written but the change fails after it (a revoked caller's last check): rolled back too.
    await expect(
      inWorkspace(w, () =>
        store.boardWrite(w, async () => {
          await tasks.commentTestSeam.save(w, c)
          throw new Error('refused at the end')
        })
      )
    ).rejects.toThrow('refused at the end')
    expect(rows(ws, card)).toEqual([])
    // The retry: each once, in order.
    await inWorkspace(w, () => store.boardWrite(w, () => tasks.commentTestSeam.save(w, c)))
    expect(rows(ws, card).map((r) => r.text)).toEqual(['c0', 'c1'])
    // Saved again later: nothing more.
    await inWorkspace(w, () => store.boardWrite(w, () => tasks.commentTestSeam.save(w, c)))
    expect(rows(ws, card).map((r) => r.text)).toEqual(['c0', 'c1'])
    const now = await inWorkspace(w, () => tasks.getTask(card))
    expect([...texts((await archived(w, card)).comments), ...texts(now.comments)]).toEqual([...texts(comments(KEPT)), 'a', 'b'])
  })

  it('two ID-less legacy comments alike in every field both stay, each once, in order and unchanged, through a double save and a rollback', async () => {
    const ws = newWorkspace()
    const w = await open(ws)
    // Alike in at, by and text, no id; one of a form Combwork doesn't write (an extra field), each kept exactly.
    const twin = { at: '2025-01-01T00:00:00.000Z', by: 'old', text: 'same' }
    const odd = { at: '2025-01-01T00:00:00.000Z', by: 'old', text: 'same', legacy: { kept: true } }
    const card = await cardWith(w, [twin, { ...twin }, odd, ...comments(KEPT - 3, 3)])
    const c = await inWorkspace(w, () => tasks.getTask(card, w))
    for (const t of ['a', 'b', 'c']) tasks.commentTestSeam.add(c, 'me', t)
    await expect(
      inWorkspace(w, () =>
        store.boardWrite(w, async () => {
          await tasks.commentTestSeam.save(w, c)
          await tasks.commentTestSeam.save(w, c)
          throw new Error('undone')
        })
      )
    ).rejects.toThrow('undone')
    expect(rows(ws, card)).toEqual([])
    await inWorkspace(w, () =>
      store.boardWrite(w, async () => {
        await tasks.commentTestSeam.save(w, c)
        await tasks.commentTestSeam.save(w, c)
      })
    )
    const r = rows(ws, card)
    expect(r.map((x) => [x.ord, x.doc])).toEqual([
      [0, JSON.stringify(twin)],
      [1, JSON.stringify(twin)],
      [2, JSON.stringify(odd)]
    ])
    expect((await archived(w, card)).comments).toEqual([twin, twin, odd])
  })

  it('a card read again after a rollback evicts again, archived once', async () => {
    const ws = newWorkspace()
    const w = await open(ws)
    const card = await cardWith(w, comments(KEPT))
    store.boardTestHooks.failPut = (x) => x === card
    await expect(inWorkspace(w, () => tasks.commentTask(card, 'first try', user))).rejects.toThrow(/SQLITE_FULL/)
    store.boardTestHooks.failPut = null
    await inWorkspace(w, () => tasks.commentTask(card, 'second try', user))
    expect(rows(ws, card).map((x) => x.text)).toEqual(['c0'])
  })
})

describe('reading the archive', () => {
  it("is read as the card is: a confined agent can't read another project's", async () => {
    const ws = newWorkspace()
    const w = await open(ws)
    const card = await cardWith(w, comments(KEPT))
    await inWorkspace(w, () => tasks.commentTask(card, 'more', user))
    expect((await inWorkspace(w, () => tasks.archivedCommentsOf(card, alphaAgent, 0, 10))).total).toBe(1)
    await expect(inWorkspace(w, () => tasks.archivedCommentsOf(card, betaAgent, 0, 10))).rejects.toThrow(`Unknown task #${card}`)
  })

  it('is kept in Export Board, in the same snapshot, masked', async () => {
    const ws = newWorkspace()
    const w = await open(ws)
    const card = await cardWith(w, [{ ...comments(1)[0], text: 'key SECRET here' }, ...comments(KEPT - 1, 1)])
    const plain = await cardWith(w, comments(2))
    await inWorkspace(w, () => tasks.commentTask(card, 'more', user))
    const dir = join(base, `export-${n}`)
    const mask = <T,>(v: T): T => JSON.parse(JSON.stringify(v).replaceAll('SECRET', '***')) as T
    await inWorkspace(w, () => store.exportBoard(w, dir, mask))
    const file = JSON.parse(readFileSync(join(dir, `${card}.comments-archive.json`), 'utf8'))
    expect(file).toEqual({ version: 1, card, comments: [{ at: comments(1)[0].at, by: 'someone', text: 'key *** here', id: 'id0' }] })
    expect(existsSync(join(dir, `${plain}.comments-archive.json`))).toBe(false)
    // The card's own file holds the 500 it keeps, as before.
    expect(JSON.parse(readFileSync(join(dir, `${card}.json`), 'utf8')).comments).toHaveLength(KEPT)
  })
})

describe("the archive's board step", () => {
  /** The board as it was before step 27: its table, its row in schema_version and its record gone. */
  function before27(ws: string): void {
    const db = new DatabaseSync(store.boardFile(ws))
    try {
      db.exec('DROP TABLE card_comments_archive')
      db.prepare('DELETE FROM schema_version WHERE version >= 27').run()
      db.prepare('DELETE FROM board_meta WHERE key = ?').run(MAY_HAVE_LOST_KEY)
    } finally {
      db.close()
    }
  }

  it('an upgraded board takes it unasked; only a card that held the cap may have lost comments, and none is counted', async () => {
    const ws = newWorkspace()
    let w = await open(ws)
    const atCap = await cardWith(w, comments(KEPT))
    const below = await cardWith(w, comments(KEPT - 1))
    const none = await cardWith(w, [])
    await close(w)
    before27(ws)
    w = await open(ws)
    expect(inWorkspace(w, () => store.boardState(w)).readOnly).toBeNull()
    expect(tables(ws)).toContain('card_comments_archive')
    const of = (x: number) => inWorkspace(w, () => tasks.commentArchive(x))
    expect([of(atCap), of(below), of(none)]).toEqual([
      { archived: 0, mayHaveBeenLost: true },
      { archived: 0, mayHaveBeenLost: false },
      { archived: 0, mayHaveBeenLost: false }
    ])
    // Archiving from now on: the flag stays (what was lost before stays unknown), the count is what was archived.
    await inWorkspace(w, () => tasks.commentTask(atCap, 'more', user))
    expect(of(atCap)).toEqual({ archived: 1, mayHaveBeenLost: true })
  })

  it('a 0.9 board waiting for its upgrade takes it only with the upgrade', async () => {
    const ws = newWorkspace()
    let w = await open(ws)
    const atCap = await cardWith(w, comments(KEPT))
    await close(w)
    as09(store.boardFile(ws))
    w = await open(ws)
    expect(inWorkspace(w, () => store.boardState(w)).readOnly).toBe('upgrade')
    expect(tables(ws)).not.toContain('card_comments_archive')
    expect(inWorkspace(w, () => tasks.commentArchive(atCap))).toEqual({ archived: 0, mayHaveBeenLost: false })
    await inWorkspace(w, () => store.upgradeBoard(w))
    expect(tables(ws)).toContain('card_comments_archive')
    expect(inWorkspace(w, () => tasks.commentArchive(atCap))).toEqual({ archived: 0, mayHaveBeenLost: true })
  })
})
